const gate = require('./full-product-cutover-gate');
const access = require('./access-admin-transaction');
const { writeAuditEvent } = require('../audit/audit-events');
const e = require('./correction-request-batch-evidence');
const EVENT = 'correction_batch.step_committed';
const authorityHeld = new WeakSet();
const key = review => e.hash({ planHash: review.planHash, actorUserId: review.actorUserId, requestId: review.entry.requestId });

async function databaseIdentity(client, connectionTargetHash) {
  const identity = (await client.query(`SELECT current_database() name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) oid,
    (SELECT system_identifier::text FROM pg_control_system()) cluster,
    current_schema() schema,
    (SELECT jsonb_agg(jsonb_build_object('name',name,'checksum',checksum) ORDER BY name) FROM schema_migrations) migrations,
    (SELECT pg_get_indexdef(indexrelid) FROM pg_index
      WHERE indexrelid=to_regclass('correction_batch_step_identity_idx') AND indisunique AND indisvalid
      AND indrelid='audit_events'::regclass AND indnkeyatts=1 AND indnatts=1
      AND indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid='audit_events'::regclass AND attname='subject_id')
      AND pg_get_expr(indpred,indrelid)='(event_key = ''correction_batch.step_committed''::text)') receipt_index,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='audit_events'::regclass AND conname='correction_batch_step_shape' AND convalidated) receipt_shape`)).rows[0];
  if (!identity.receipt_index || !identity.receipt_shape || identity.migrations.some(m => !m.checksum)) throw e.error(503, 'CORRECTION_BATCH_SCHEMA_UNSUPPORTED');
  return { ...identity, connectionTargetHash };
}

async function readRequest(client, requestId) {
  const row = (await client.query(`SELECT cr.*,to_jsonb(cr)||jsonb_build_object('claim_version',claim_version::text) raw
    FROM correction_requests cr WHERE id=$1`, [requestId])).rows[0];
  if (!row) throw e.error(409, 'CORRECTION_BATCH_REQUEST_MISSING');
  const { raw, ...request } = row;
  return { row: request, requestHash: e.hash(raw) };
}

async function readSource(client, productId) {
  const row = (await client.query(`SELECT
    to_jsonb(p)||jsonb_build_object('public_product_identity_id',p.public_product_identity_id::text,'public_sku',i.public_sku) product,
    to_jsonb(f)||jsonb_build_object('revision',f.revision::text,'confirmed_revision',f.confirmed_revision::text,
      'delivery_version',f.delivery_version::text,'cutover_baseline_revision',f.cutover_baseline_revision::text,
      'externally_delivered_revision',f.externally_delivered_revision::text,'csv_retired_revision',f.csv_retired_revision::text) lifecycle,
    to_jsonb(i)||jsonb_build_object('id',i.id::text) identity,
    (SELECT to_jsonb(r) FROM sku_registry r WHERE r.full_sku=p.full_sku) reservation,
    (SELECT count(*)::int FROM products other WHERE other.full_sku=p.full_sku) sku_count,
    (SELECT count(*)::int FROM products other WHERE other.public_product_identity_id=p.public_product_identity_id
      AND other.status='active' AND other.corrected_to_product_id IS NULL) current_identity_count,
    EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=p.public_product_identity_id
      AND d.state<>'finalized') deletion_fence,
    (SELECT to_jsonb(a) FROM public_sku_activation a WHERE singleton) public_activation,
    (SELECT to_jsonb(a) FROM full_product_export_activation a WHERE singleton) lifecycle_activation,
    (SELECT to_jsonb(a) FROM magento_auto_sync_activation a WHERE singleton) automatic_activation
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1`, [productId])).rows[0];
  return row || null;
}

async function begin(client, options, permission) {
  if (!options.batchReview) return gate.begin(client, 'BEGIN');
  await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
  authorityHeld.add(client);
  await gate.begin(client, 'BEGIN');
  await authorize(client, options.batchReview, permission);
}

async function authorize(client, review, permission, readOnly = false) {
  if (review.actorUserId !== review.mutationActorUserId) throw e.error(403, 'CORRECTION_BATCH_ACTOR_MISMATCH');
  await access.assertActorStillAuthorized(client, review.actorUserId, permission, e.error, { readOnly });
  await access.assertActorStillAuthorized(client, review.actorUserId, 'corrections.view', e.error, { readOnly });
  const identity = await databaseIdentity(client, review.databaseIdentity.connectionTargetHash);
  if (!e.same(identity, review.databaseIdentity)) throw e.error(503, 'CORRECTION_BATCH_DATABASE_MISMATCH');
}

async function steps(client, review) {
  const rows = (await client.query(`SELECT id::text,actor_user_id::text,details FROM audit_events
    WHERE event_key=$1 AND subject_type='correction_batch_step' AND subject_id=ANY($2::text[]) ORDER BY audit_events.id`,
  [EVENT, ['claimed','refreshed','released','completed'].map(p => `${key(review)}:${p}`)])).rows;
  const seen = new Set();
  let beforeRequestHash = review.entry.requestHash;
  for (const row of rows) {
    const d = row.details;
    if (Number(row.actor_user_id) !== review.actorUserId || d.planHash !== review.planHash
      || d.selectionHash !== review.selectionHash || d.entryHash !== review.entry.entryHash
      || d.entryKey !== key(review) || d.requestId !== review.entry.requestId
      || d.beforeRequestHash !== beforeRequestHash || seen.has(d.phase)) e.conflict('CORRECTION_BATCH_RECEIPT_CONFLICT');
    if ((d.phase === 'claimed' && seen.size) || (d.phase === 'completed' && !seen.has('refreshed'))
      || (d.phase === 'released' && (!seen.has('claimed') || seen.has('refreshed')))
      || seen.has('released') || seen.has('completed')) e.conflict('CORRECTION_BATCH_RECEIPT_CONFLICT');
    seen.add(d.phase);
    beforeRequestHash = d.afterRequestHash;
  }
  return rows;
}

async function guard(client, review, { source = true } = {}) {
  const prior = await steps(client, review), last = prior.at(-1)?.details;
  if (last && ['completed','released'].includes(last.phase)) e.conflict('CORRECTION_BATCH_TERMINAL_PHASE');
  const current = await readRequest(client, review.entry.requestId);
  if (current.requestHash !== (last?.afterRequestHash || review.entry.requestHash)) e.conflict('CORRECTION_BATCH_REQUEST_DRIFT');
  if (source && !e.same(await readSource(client, review.entry.sourceProductId), review.entry.sourceEvidence)) e.conflict('CORRECTION_BATCH_SOURCE_DRIFT');
  return current.row;
}

async function record(client, options, phase, result = {}) {
  const review = options.batchReview;
  if (!review) return;
  const prior = await steps(client, review);
  const seen = new Set(prior.map(r => r.details.phase));
  if (seen.has(phase) || seen.has('completed') || seen.has('released')
    || (phase === 'claimed' && seen.size)
    || (phase === 'completed' && !seen.has('refreshed'))
    || (phase === 'released' && (!seen.has('claimed') || seen.has('refreshed')))) e.conflict('CORRECTION_BATCH_RECEIPT_CONFLICT');
  const current = await readRequest(client, review.entry.requestId);
  let committed = result;
  if (phase === 'completed') {
    const productId = result.correctedProductId || review.entry.sourceProductId;
    const source = await readSource(client, productId);
    const sync = (await client.query(`SELECT product_id,public_product_identity_id::text,desired_generation::text,
      synced_generation::text,state,reason_code,active_job_id FROM magento_product_sync_requests
      WHERE public_product_identity_id=$1`, [source.product.public_product_identity_id])).rows[0] || null;
    committed = { ...result, productId, publicSku: source.product.public_sku,
      publicIdentityId: source.product.public_product_identity_id, internalSku: source.product.full_sku,
      lifecycle: source.lifecycle, sync, finalPayload: current.row.final_payload,
      expectedDelivery: review.entry.refreshedResult?.corrected?.delivery || null,
      postDeliveryReviewRequired: review.entry.requestType === 'recount' && source.lifecycle.route === 'hold' };
  }
  let audit;
  try {
    audit = await writeAuditEvent(client, { mutationContext: options.mutationContext,
      eventKey: EVENT, subjectType: 'correction_batch_step', subjectId: `${key(review)}:${phase}`,
      details: { entryKey: key(review), planHash: review.planHash, selectionHash: review.selectionHash,
        entryHash: review.entry.entryHash, requestId: review.entry.requestId, phase,
        beforeRequestHash: prior.at(-1)?.details.afterRequestHash || review.entry.requestHash,
        afterRequestHash: current.requestHash, claimVersion: String(current.row.claim_version), result: committed } });
  } catch (cause) {
    // Do not let recount's legacy generic 23505 SKU normalization turn a ledger
    // integrity failure into a continuable business collision.
    if (cause.code === '23505' && cause.constraint === 'correction_batch_step_identity_idx') {
      throw e.error(503, 'CORRECTION_BATCH_RECEIPT_CONFLICT');
    }
    throw cause;
  }
  return { auditId: String(audit.id), result: committed };
}

async function release(client) {
  await gate.release(client);
  if (authorityHeld.has(client)) {
    authorityHeld.delete(client);
    await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
  }
}

module.exports = { EVENT, key, databaseIdentity, readRequest, readSource, begin, authorize, steps, guard, record, release };
