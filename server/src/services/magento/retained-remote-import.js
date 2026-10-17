// Reviewed import of values recorded by the removed first-sync decision
// retain_remote (state remote_retained, migration 080). Historical internal SKUs
// are opaque identifiers (catalog owner, 2026-10-14), so a legacy SV answer that
// Amber lacks may now be filled missing-only from Magento. The completed first-sync
// ledger stays immutable history; this command writes only the Amber product
// through the canonical first-sync setter and its own audit receipt. Magento is
// read with GET only; full_sku, the pinned schema and option meanings never change.
const c = require('./binding-contract');
const eligibility = require('./first-sync-eligibility');
const { projectFirstSyncFields } = require('./first-sync-projection');
const { prepareProgress } = require('./first-sync-progress-plan');
const local = require('./first-sync-local-apply');
const legacy = require('./first-sync-legacy-inputs');
const previews = require('./sync-preview-db');
const evaluator = require('./binding-evidence-products');
const { writeAuditEvent } = require('../../audit/audit-events');
const gate = require('../full-product-cutover-gate');

const EVENT = 'product.magento_retained_values_imported';
const RECORD_KEYS = ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'];
const fail = code => { throw c.error(409, 'MAGENTO_RETAINED_IMPORT_' + code, 'Потрібна актуальна перевірка характеристик, залишених у Magento.'); };
const key = row => row.scope + '/' + row.target;
const pair = e => ({ all: e.base?.name, en: e.english?.name });
const clean = value => JSON.parse(JSON.stringify(value));

function command(input, applying = false) {
  c.command(input, ['sku', 'bindingRevisionId'], applying ? ['previewToken'] : []);
  c.identity(input.bindingRevisionId);
  if (typeof input.sku !== 'string' || !input.sku.trim() || input.sku.length > 256 || /[\u0000-\u001f\u007f]/.test(input.sku)
    || applying && (typeof input.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewToken))) c.invalid();
}
const selection = input => ({ sku: input.sku, bindingRevisionId: input.bindingRevisionId });
const optionsFor = options => ({ ...options, databasePool: options.databasePool || require('../../db/pool'),
  actorUserId: options.mutationContext?.actorUserId || options.actorUserId });

async function administrator(client, options) {
  await require('./binding-publication').administrator(client, options.actorUserId);
  for (const permission of ['export_templates.manage', 'exports.view', 'products.recount']) {
    await require('../access-admin-transaction').assertActorStillAuthorized(client, options.actorUserId, permission, c.error, { readOnly: true });
  }
}
async function retainedRows(client, config, publicIdentityId) {
  return (await client.query(`SELECT f.session_id::text session_id,f.revision::text revision,f.target,f.scope,f.evidence,
      s.completed_at IS NOT NULL completed
    FROM magento_first_sync_fields f JOIN magento_first_sync_sessions s ON s.id=f.session_id
    WHERE s.origin_hash=$1 AND s.public_product_identity_id=$2 AND f.state='remote_retained'
    ORDER BY f.scope,f.target`, [c.originHash(config.baseUrl), publicIdentityId])).rows;
}

// Read-only unless the caller holds the apply transaction. Every retained row is
// classified against a fresh no-receipt projection of the current publication.
async function prepareOnClient(client, { config, observation, state, input, options, rateObservation }) {
  await administrator(client, options);
  const amber = observation.amber, product = amber.product;
  const current = (await client.query("SELECT id FROM magento_binding_revisions WHERE installation_key=$1 AND state='published' ORDER BY version_number DESC LIMIT 1",
    [state.revision.installationKey])).rows[0];
  if (current?.id !== input.bindingRevisionId || amber.revision.id !== input.bindingRevisionId) fail('BINDING_NOT_CURRENT');
  if (!legacy.isLegacySv(product) || Number(product.id) !== state.productId || product.public_sku !== state.publicSku
    || String(product.public_product_identity_id) !== String(state.publicIdentityId) || product.status !== 'active'
    || product.corrected_to_product_id || !observation.raw || observation.raw.sku !== state.publicSku
    || !Number.isSafeInteger(observation.raw.id) || observation.raw.id < 1) fail('IDENTITY_UNPROVEN');
  const retained = await retainedRows(client, config, state.publicIdentityId);
  if (!retained.length) return { status: 'nothing_retained', fields: [], accepted: [] };
  if (retained.some(row => !row.completed)) fail('FIRST_SYNC_NOT_COMPLETE');
  const first = await eligibility.readFirstSyncEligibility(client, config, observation);
  if (first.mode !== 'ordinary') fail('FIRST_SYNC_NOT_COMPLETE');
  const projection = projectFirstSyncFields({ observation: { amber, raw: observation.raw,
    schema: observation.schema, domainEvidence: observation.domainEvidence } });
  if (!projection.plan) fail('PROJECTION_UNAVAILABLE');
  const plan = prepareProgress(projection, null);
  const fields = [], accepted = [];
  for (const row of retained) {
    const fresh = plan.rows.find(item => key(item) === key(row));
    const meta = projection.projection.find(item => key(item) === key(row));
    const base = { target: row.target, scope: row.scope, sessionId: row.session_id, revision: row.revision,
      retainedRemote: row.evidence.remote?.value ?? null };
    let status = 'importable', code = null;
    if (!fresh || meta?.persistence !== 'characteristic' || meta.source?.key !== row.evidence.source?.key) code = 'FIELD_NOT_MAPPED';
    else if (fresh.local.known && fresh.local.present) {
      if (fresh.status === 'equal') status = 'already_imported'; else code = 'LOCAL_VALUE_PRESENT';
    }
    // A Magento value changed since retention is not what the owner decided.
    else if (!fresh.remote.known || !fresh.remote.present || String(fresh.remote.value) !== String(base.retainedRemote)) code = 'REMOTE_CHANGED';
    else if (fresh.record.state !== 'imported') code = fresh.reason || 'IMPORT_NOT_AVAILABLE';
    if (code) status = 'blocked';
    if (status === 'importable') {
      const record = { ...Object.fromEntries(RECORD_KEYS.map(name => [name, fresh.record[name]])),
        source: { ...fresh.record.source, productId: product.id } };
      accepted.push(record);
      fields.push({ ...base, status, after: record.after });
    } else fields.push({ ...base, status, ...(code ? { code } : {}) });
  }
  // Each field is proved alone first, so one refused answer never blocks another;
  // the remaining set is then prepared together exactly as apply will write it.
  const validate = records => local.prepareFirstSyncLocal(client, { config, observation, projection,
    actorUserId: options.actorUserId, acceptedFields: records, rateObservation });
  const block = (record, code) => {
    accepted.splice(accepted.indexOf(record), 1);
    const field = fields.find(item => key(item) === key(record));
    field.status = 'blocked'; field.code = code; delete field.after;
  };
  for (const record of [...accepted]) {
    const blocked = (await validate([record])).blockedFields[0];
    if (blocked) block(record, blocked.code);
  }
  let canonicalHash = null;
  if (accepted.length) {
    const validation = await validate(accepted);
    if (validation.blockedFields.length) for (const record of [...accepted]) block(record, 'FIELDS_NOT_INDEPENDENT');
    else canonicalHash = validation.canonicalHash || null;
  }
  const evidence = clean({ version: 1, proofKind: 'opaque_legacy_sku_retained_import', productId: product.id,
    publicSku: product.public_sku, sku: product.full_sku, bindingRevisionId: amber.revision.id, definitionHash: amber.compiled.hash,
    firstEvidenceHash: first.evidenceHash, remoteHash: c.hash({ raw: observation.raw, domainEvidence: observation.domainEvidence, schema: observation.schema }),
    fields, accepted, canonicalHash,
    rate: rateObservation?.rateInfo ? Object.fromEntries(['rate', 'rateDate', 'source', 'stale'].map(name => [name, rateObservation.rateInfo[name]])) : null });
  return { status: accepted.length ? 'importable' : fields.every(f => f.status === 'already_imported') ? 'already_imported' : 'blocked',
    fields, accepted, projection, evidence, previewToken: c.hash({ input: selection(input), evidence }) };
}
function response(state, prepared) {
  return { sku: state.publicSku, productId: state.productId, status: prepared.status,
    fields: prepared.fields.map(field => clean(field)), ...(prepared.previewToken ? { previewToken: prepared.previewToken } : {}),
    remoteWrites: 0, syncJobEnqueued: false };
}
async function observeRate(options) {
  try { return await (options.observeRate || require('../currency.service').observeUsdRate)({ databasePool: options.databasePool }); }
  catch { return null; }
}

async function review(config, input, options = {}) {
  command(input); options = optionsFor(options);
  const boundary = require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config, input, options, async state => {
    const auth = await options.databasePool.connect(); try { await administrator(auth, options); } finally { auth.release(); }
    const { observation } = await boundary.observe(config, { sku: state.publicSku, bindingRevisionId: input.bindingRevisionId }, options);
    const rateObservation = await observeRate(options);
    const client = await options.databasePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const prepared = await prepareOnClient(client, { config, observation, state, input, options, rateObservation });
      await client.query('COMMIT'); return response(state, prepared);
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  });
}

async function apply(config, input, options = {}) {
  command(input, true); options = optionsFor(options);
  const boundary = require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config, input, options, async state => {
    const auth = await options.databasePool.connect(); try { await administrator(auth, options); } finally { auth.release(); }
    const actionHash = c.hash({ actorUserId: options.actorUserId, input: selection(input), previewToken: input.previewToken });
    const prior = (await options.databasePool.query('SELECT details FROM audit_events WHERE event_key=$1 AND subject_type=$2 AND subject_id=$3 ORDER BY id LIMIT 2',
      [EVENT, 'retained_remote_import', actionHash])).rows;
    if (prior.length) {
      if (prior.length !== 1 || prior[0].details?.result?.productId !== state.productId || prior[0].details.result.sku !== state.publicSku) fail('RECEIPT_CONFLICT');
      return { ...prior[0].details.result, alreadyApplied: true };
    }
    const { observation } = await boundary.observe(config, { sku: state.publicSku, bindingRevisionId: input.bindingRevisionId }, options);
    const rateObservation = await observeRate(options);
    const client = await options.databasePool.connect();
    try {
      await client.query('BEGIN'); await require('./sync-job-transaction').revalidate(client, config, state, options);
      const prepared = await prepareOnClient(client, { config, observation, state, input, options, rateObservation });
      if (prepared.previewToken !== input.previewToken) fail('PREVIEW_STALE');
      if (!prepared.accepted.length) fail('NOTHING_TO_IMPORT');
      const before = evaluator.evaluate(observation.amber, observation.amber.product);
      const written = await local.applyFirstSyncLocal(client, { config, observation, projection: prepared.projection,
        acceptedFields: prepared.accepted, actorUserId: options.actorUserId, rateObservation,
        expectedCanonicalHash: prepared.evidence.canonicalHash ?? undefined });
      const post = await previews.readPreviewProductOnClient(client, { productId: state.productId, bindingRevisionId: input.bindingRevisionId });
      const after = evaluator.evaluate(post, post.product);
      // Names and evaluation readiness stay exactly as before; only the answers change.
      if (after.failed || c.hash(after.issueFields || []) !== c.hash(before.issueFields || [])
        || c.hash(pair(after)) !== c.hash(pair(before))) fail('POST_STATE_UNPROVEN');
      for (const record of prepared.accepted) {
        if (String(post.product.details?.answers?.[record.source.key]) !== String(record.after)) fail('POST_STATE_UNPROVEN');
      }
      if (post.product.full_sku !== observation.amber.product.full_sku) fail('IDENTITY_UNPROVEN');
      const result = { sku: state.publicSku, productId: state.productId, fullRevision: written.fullRevision,
        imported: prepared.fields.filter(f => f.status === 'importable').map(f => ({ target: f.target, scope: f.scope, after: f.after,
          sessionId: f.sessionId, revision: f.revision })),
        blocked: prepared.fields.filter(f => f.status === 'blocked').map(f => ({ target: f.target, scope: f.scope, code: f.code })),
        remoteWrites: 0, syncJobEnqueued: false, alreadyApplied: false };
      await writeAuditEvent(client, { mutationContext: { actorUserId: options.actorUserId }, eventKey: EVENT,
        subjectType: 'retained_remote_import', subjectId: actionHash, details: { input: selection(input), evidence: prepared.evidence, result } });
      await gate.commit(client); return result;
    } catch (e) { await gate.rollback(client).catch(() => {}); throw e; } finally { await gate.release(client).catch(() => {}); client.release(); }
  });
}
module.exports = { EVENT, review, apply, command, prepareOnClient };
