const { randomUUID } = require('node:crypto');
const c = require('./magento/binding-contract');
const s = require('./historical-reactivation-state');
const lifecycle = require('./product-lifecycle-state');
const { runAccessAdminMutation } = require('./access-admin-transaction');
const { writeAuditEvent } = require('../audit/audit-events');
const { previewProduct } = require('./magento/sync-preview');
const { readPreviewProduct } = require('./magento/sync-preview-db');
const plan = require('./magento/sync-job-plan');
const atomic = require('./magento/historical-update-transport');

function dependencies(options) {
  const env = (!options.config || !options.reviewSecret) ? require('../config/env') : null;
  return { db: options.databasePool || require('../db/pool'), config: options.config || env.magento,
    secret: options.reviewSecret || env.sessionSecret, actor: Number(options.actorUserId || options.mutationContext?.actorUserId),
    now: options.now || (() => Date.now()) };
}
async function readTargets(client, skus, origin) {
  const rows = (await client.query(`SELECT p.id,p.full_sku,p.public_product_identity_id,i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE upper(i.public_sku)=ANY($1::text[]) OR upper(p.full_sku)=ANY($1::text[]) ORDER BY p.id`, [skus])).rows;
  const seen = new Set(), targets = [];
  for (const inputSku of skus) {
    const publicRows = rows.filter(p => p.public_sku.toUpperCase() === inputSku);
    const matches = publicRows.length ? publicRows : rows.filter(p => p.full_sku?.toUpperCase() === inputSku);
    const base = { inputSku, targetStatus: 2, priorFacts: 'unknown', prerequisites: [], blockerCodes: [] };
    if (!matches.length) { targets.push({ ...base, disposition: 'blocked', reasonCode: 'HISTORICAL_PRODUCT_NOT_FOUND' }); continue; }
    if (new Set(matches.map(p => String(p.public_product_identity_id))).size !== 1 || !publicRows.length && matches.length !== 1) {
      targets.push({ ...base, disposition: 'blocked', reasonCode: 'HISTORICAL_PRODUCT_AMBIGUOUS' }); continue;
    }
    const chosen = matches.at(-1);
    if (seen.has(Number(chosen.id))) { targets.push({ ...base, disposition: 'skipped', reasonCode: 'HISTORICAL_DUPLICATE_TARGET' }); continue; }
    seen.add(Number(chosen.id));
    const current = await lifecycle.readTarget(client, Number(chosen.id), { origin });
    const request = (await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [chosen.public_product_identity_id])).rows[0];
    const existing = (await client.query(`SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=$1
      AND state IN ('queued','dispatched','awaiting_native') LIMIT 1`, [chosen.public_product_identity_id])).rowCount;
    const reason = s.localIssue(current) || (existing ? 'HISTORICAL_INTENT_EXISTS' : null);
    const item = { ...base, productId: Number(chosen.id), article: chosen.public_sku, category: current.product.category,
      currentPriceUah: Number(current.product.total_price_uah), currentWeight: Number(current.product.weight || 0),
      currentRoute: current.lifecycle?.route || null, currentExclusion: Number(current.product.exclude_from_export),
      currentBusinessExclusion: current.lifecycle?.business_exclusion_state || null,
      localFingerprint: s.fingerprint(current.product, current.lifecycle), requestGeneration: request?.desired_generation || null,
      disposition: reason === 'HISTORICAL_PRODUCT_ALREADY_ACTIVE' ? 'skipped' : reason ? 'blocked' : 'eligible', reasonCode: reason,
      prerequisites: [
        { code: 'LOCAL_ARCHIVED_CURRENT', met: current.product.status === 'archived' && current.lifecycle?.route === 'retired' },
        { code: 'LINEAGE_CLEAR', met: !current.facts.newerRevision && !current.facts.activeSuccessor && !current.facts.correctionHistory
          && current.product.corrected_from_product_id == null && current.product.corrected_to_product_id == null },
        { code: 'MEDIA_CLEAR', met: !current.facts.unfinishedMedia }, { code: 'DELETION_CLEAR', met: !current.facts.testDeletion },
        { code: 'SYNC_CLEAR', met: !current.facts.unfinishedJob && !current.facts.unresolvedStep && !current.facts.unresolvedVisibility },
        { code: 'CURRENT_PRICE_VALID', met: Number.isFinite(Number(current.product.total_price_uah)) && Number(current.product.total_price_uah) > 0 }],
    };
    targets.push(item);
  }
  return targets;
}
// A private prospective projection permits only the explicit NEW administrator
// participation decision. The original product retains its source-support
// association; historical identity/answers/schema/name evidence are untouched.
async function observeCurrent(config, db, item, bindingId, options) {
  let observation;
  const report = await (options.previewProduct || previewProduct)(config, { databasePool: db, sku: item.article,
    bindingRevisionId: bindingId, fetchImpl: options.fetchImpl, discover: options.discover,
    readAmber: async (pool, input) => {
      const amber = await readPreviewProduct(pool, input);
      amber.product.status = 'active'; amber.product.exclude_from_export = 0;
      amber.product.exportState = { ...amber.product.exportState, route: 'normal', hold_reason: null,
        business_exclusion_state: 'none', recount_compatibility_excluded: false, independentExclusion: false };
      return amber;
    }, onObservation: value => { observation = value; } });
  if (!observation) s.fail('HISTORICAL_OBSERVATION_REQUIRED');
  return { observation, report };
}
async function preview(input, options = {}) {
  c.command(input, ['skus']);
  const skus = s.normalizeSkus(input.skus), { db, config, secret, actor, now } = dependencies(options);
  const client = await db.connect(); let context, items;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await s.authority(client, actor, true);
    let unavailable = null;
    try { context = await s.currentBinding(client, config); } catch (cause) {
      if (!['HISTORICAL_AUTO_DELIVERY_REQUIRED', 'HISTORICAL_BINDING_REQUIRED'].includes(cause.code)) throw cause;
      unavailable = cause.code;
    }
    items = await readTargets(client, skus, config.configured ? c.originHash(config.baseUrl) : c.hash('magento-unconfigured'));
    for (const item of items) if (item.productId) {
      item.prerequisites.push({ code: 'AUTOMATIC_DELIVERY_ENABLED', met: !unavailable || unavailable !== 'HISTORICAL_AUTO_DELIVERY_REQUIRED' },
        { code: 'CURRENT_BINDING_VALID', met: !!context });
      if (item.disposition === 'eligible' && unavailable) { item.disposition = 'blocked'; item.reasonCode = unavailable; }
    }
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK').catch(() => {}); throw cause; }
  finally { client.release(); }
  let atomicAvailable = false;
  if (items.some(i => i.disposition === 'eligible')) {
    try { await atomic.capability(config, options); atomicAvailable = true; }
    catch (cause) { if (cause.code !== 'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED') throw cause; }
  }
  for (const item of items.filter(i => i.disposition === 'eligible')) {
    item.prerequisites.push({ code: 'ATOMIC_UPDATE_ONLY_SUPPORTED', met: atomicAvailable });
    let observed;
    try { observed = await observeCurrent(config, db, item, context.row.id, options); }
    catch (cause) {
      if (!['MAGENTO_PRODUCT_AMBIGUOUS','MAGENTO_RESPONSE_INVALID','MAGENTO_PRODUCT_NOT_FOUND'].includes(cause.code)) throw cause;
      item.disposition = 'blocked'; item.reasonCode = cause.code === 'MAGENTO_PRODUCT_NOT_FOUND'
        ? 'HISTORICAL_REMOTE_COUNTERPART_MISSING' : 'HISTORICAL_REMOTE_IDENTITY_MISMATCH';
      item.prerequisites.push({ code: 'EXACT_REMOTE_COUNTERPART', met: false }); continue;
    }
    const { observation, report } = observed;
    const raw = observation.raw;
    item.bindingRevisionId = context.row.id; item.bindingHash = context.fingerprint;
    item.remoteProductId = raw?.id || null; item.observedRemoteStatus = raw?.status ?? null;
    item.remoteFingerprint = s.remoteFingerprint(raw);
    item.deliveryBlockerCodes = [...new Set(report.blockers.map(b => b.code))];
    const exact = !!raw && raw.sku === item.article && Number.isSafeInteger(raw.id) && raw.id > 0;
    const currentName = report.candidatePayload?.product?.name ?? (exact ? raw?.name : null);
    item.currentName = typeof currentName === 'string' && currentName.trim() ? currentName.trim() : null;
    const deliveredPrice = report.candidatePayload?.product?.price ?? raw?.price;
    const priceExact = Number.isFinite(Number(deliveredPrice)) && Number(deliveredPrice) === item.currentPriceUah;
    if (!priceExact) item.deliveryBlockerCodes.push('HISTORICAL_CURRENT_PRICE_NOT_AUTHORITATIVE');
    const reason = !raw ? 'HISTORICAL_REMOTE_COUNTERPART_MISSING' : !exact ? 'HISTORICAL_REMOTE_IDENTITY_MISMATCH'
      : ![1, 2].includes(raw.status) ? 'HISTORICAL_REMOTE_STATUS_UNSUPPORTED'
        : !report.sendable || report.mode !== 'update' || !priceExact ? 'HISTORICAL_DELIVERY_PLAN_BLOCKED'
          : !atomicAvailable ? 'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED' : null;
    item.prerequisites.push({ code: 'EXACT_REMOTE_COUNTERPART', met: exact }, { code: 'CURRENT_DELIVERY_PLAN_VALID', met: report.sendable && report.mode === 'update' && priceExact });
    if (!reason) item.deliveryPlanHash = c.hash(plan.intent(report));
    if (reason) { item.disposition = 'blocked'; item.reasonCode = reason; }
  }
  for (const item of items) item.blockerCodes = item.reasonCode ? [item.reasonCode] : [];
  const review = { format: s.FORMAT, reviewNonce: options.reviewNonce || randomUUID(),
    reviewExpiresAt: options.reviewExpiresAt || new Date(now() + s.TTL).toISOString(),
    originHash: config.configured ? c.originHash(config.baseUrl) : null,
    installationKey: context?.row.installation_key || null, skus, items };
  return { ...review, reviewHash: c.hash(review), reviewToken: s.signReview(actor, review, secret),
    counts: { eligible: items.filter(i => i.disposition === 'eligible').length, blocked: items.filter(i => i.disposition === 'blocked').length,
      skipped: items.filter(i => i.disposition === 'skipped').length } };
}
async function readBatch(id, options = {}) {
  c.identity(id); const { db, actor } = dependencies(options);
  await s.authority(db, actor, true);
  const batch = (await db.query('SELECT id,actor_user_id,created_at FROM historical_reactivation_batches WHERE id=$1', [id])).rows[0];
  if (!batch) s.fail('HISTORICAL_BATCH_NOT_FOUND', 404);
  const items = (await db.query('SELECT * FROM historical_reactivation_intents WHERE batch_id=$1 ORDER BY product_id', [id])).rows;
  return { batchId: id, createdAt: batch.created_at, items: items.map(s.receipt) };
}
async function confirmLocked(input, options = {}) {
  c.command(input, ['skus', 'selectedSkus', 'reviewNonce', 'reviewHash', 'reviewToken', 'reviewExpiresAt', 'idempotencyKey', 'confirmCurrentFactsAndHiddenUpdate']);
  if (input.confirmCurrentFactsAndHiddenUpdate !== true || !/^[a-f0-9]{64}$/.test(input.reviewHash || '')) s.fail('HISTORICAL_CONFIRMATION_REQUIRED', 422);
  c.identity(input.reviewNonce); c.identity(input.idempotencyKey);
  const skus = s.normalizeSkus(input.skus);
  s.normalizeSkus(input.selectedSkus);
  const selected = [...new Set(input.selectedSkus)];
  if (selected.length !== input.selectedSkus.length || !input.selectedSkus.every(x => x === x.trim())) s.fail('HISTORICAL_SELECTION_INVALID', 422);
  const { db, config, secret, actor, now } = dependencies(options);
  await s.authority(db, actor, true);
  const requestHash = c.hash(input);
  const original = (await db.query('SELECT * FROM historical_reactivation_batches WHERE id=$1', [input.idempotencyKey])).rows[0];
  if (original) {
    if (Number(original.actor_user_id) !== actor || original.request_hash !== requestHash) s.fail('HISTORICAL_IDEMPOTENCY_CONFLICT');
    return readBatch(original.id, options);
  }
  const checked = await preview({ skus }, { ...options, reviewNonce: input.reviewNonce, reviewExpiresAt: input.reviewExpiresAt });
  const { reviewHash, reviewToken: ignoredToken, counts: ignoredCounts, ...review } = checked; void ignoredToken; void ignoredCounts;
  s.verifyReview(actor, review, input.reviewToken, secret, now());
  if (reviewHash !== input.reviewHash) s.fail('HISTORICAL_REVIEW_STALE');
  const chosen = review.items.filter(item => item.disposition === 'eligible' && selected.includes(item.article));
  if (chosen.length !== selected.length) s.fail('HISTORICAL_SELECTION_INVALID', 422);
  await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'export_templates.publish', createError: c.error,
    operation: async client => {
      await s.authority(client, actor);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`historical_reactivation:${input.idempotencyKey}`]);
      const existing = (await client.query('SELECT * FROM historical_reactivation_batches WHERE id=$1', [input.idempotencyKey])).rows[0];
      if (existing) {
        if (Number(existing.actor_user_id) !== actor || existing.request_hash !== requestHash) s.fail('HISTORICAL_IDEMPOTENCY_CONFLICT');
        return;
      }
      await require('./full-product-cutover-gate').requireActive(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${review.installationKey}`]);
      const binding = await s.currentBinding(client, config);
      if (binding.fingerprint !== chosen[0].bindingHash) s.fail('HISTORICAL_REVIEW_STALE');
      const currentById = new Map();
      for (const item of [...chosen].sort((a,b) => a.productId-b.productId)) {
        const identity = (await client.query('SELECT public_product_identity_id FROM products WHERE id=$1',[item.productId])).rows[0]?.public_product_identity_id;
        if (!identity) s.fail('HISTORICAL_REVIEW_STALE');
        for (const key of [`amber_magento_public_identity:${identity}`,
          `amber_magento_sync:${review.originHash}:${item.article}`]) {
          if (!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held',[key])).rows[0].held) s.fail('HISTORICAL_BUSY');
        }
        // A competing job's FK-strength trigger must wait before inspecting the
        // new intent. Acquire both nonblocking writer lanes first: a manual
        // enqueue keeps its own row lock while using a separate ledger client.
        await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[item.productId]);
        const current = await lifecycle.readTarget(client, item.productId, { origin: review.originHash, lock: true });
        const problem = s.localIssue(current);
        if (problem || s.fingerprint(current.product, current.lifecycle) !== item.localFingerprint) s.fail('HISTORICAL_REVIEW_STALE');
        const request = (await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE', [current.product.public_product_identity_id])).rows[0];
        if ((request?.desired_generation || null) !== item.requestGeneration) s.fail('HISTORICAL_REVIEW_STALE');
        currentById.set(item.productId, current);
      }
      await client.query(`INSERT INTO historical_reactivation_batches(id,actor_user_id,request_hash,review,selected_skus)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [input.idempotencyKey, actor, requestHash, JSON.stringify(review), JSON.stringify(selected)]);
      for (const item of chosen) {
        const current = currentById.get(item.productId);
        const id = randomUUID();
        await client.query(`INSERT INTO historical_reactivation_intents(id,batch_id,actor_user_id,product_id,public_product_identity_id,
          public_sku,origin_hash,installation_key,binding_revision_id,binding_hash,local_fingerprint,current_facts,
          remote_product_id,remote_fingerprint,initial_remote_status,request_generation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`,
        [id, input.idempotencyKey, actor, item.productId, current.product.public_product_identity_id, item.article, review.originHash,
          review.installationKey, item.bindingRevisionId, item.bindingHash, item.localFingerprint,
          JSON.stringify({ product: current.product, lifecycle: current.lifecycle, priorFacts: 'unknown', newDecision: 'participate_hidden_update', deliveryPlanHash: item.deliveryPlanHash }),
          item.remoteProductId, item.remoteFingerprint, item.observedRemoteStatus, item.requestGeneration]);
        await writeAuditEvent(client, { mutationContext: options.mutationContext, eventKey: 'product.historical_reactivation_requested', subjectType: 'product', subjectId: item.productId,
          details: { intentId: id, batchId: input.idempotencyKey, publicSku: item.article, remoteProductId: item.remoteProductId, priorFacts: 'unknown', targetStatus: 2 } });
      }
    } });
  return readBatch(input.idempotencyKey, options);
}
async function confirm(input, options = {}) {
  c.identity(input?.idempotencyKey);
  const { db, actor } = dependencies(options);
  await s.authority(db, actor, true);
  const client = await db.connect();
  const key = `historical_reactivation_review:${actor}:${input.idempotencyKey}`;
  try {
    // Serialize the original UUID before fresh GET review, without holding any
    // row/admin lock over HTTP. A concurrent lost-response attempt sees receipt.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await confirmLocked(input, options);
  } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {}); client.release(); }
}
module.exports = { dependencies, preview, confirm, readBatch, observeCurrent };
