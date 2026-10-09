const c = require('./binding-contract');
const histories = require('./recovery-history');
const repair = require('../export-exposure/repair-loader');
const { buildHistoricalIndex } = require('../export-exposure/historical-index');

const FORMAT = 'magento-first-sync-history-admission-v1';
const SCOPE = 'first_sync_review_only';
const proofs = new WeakMap();
const recipes = {
  'product.magento_stable_recount_exposure_reconciled': { source: 'stable_recount_exposure', action: 'magento_stable_recount_prior_exposure' },
  'product.magento_historical_recount_exposure_reconciled': { source: 'historical_recount_exposure', action: 'magento_historical_recount_prior_exposure' },
};
const denied = reason => ({ admission: null, reason, evidenceHash: null });
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function identityFromObservation(observation) {
  const product = observation?.amber?.product, revision = observation?.amber?.revision, raw = observation?.raw;
  return { productId: product?.id, publicIdentityId: String(product?.public_product_identity_id), sku: product?.public_sku,
    originHash: revision?.originHash, installationKey: revision?.installationKey, bindingRevisionId: revision?.id,
    remoteId: raw?.id };
}
function validIdentity(identity) {
  return Number.isSafeInteger(identity?.productId) && identity.productId > 0 && /^[1-9][0-9]*$/.test(identity.publicIdentityId)
    && typeof identity.sku === 'string' && identity.sku.length > 0 && identity.sku.length <= 255
    && identity.sku.trim() === identity.sku && !/[\u0000-\u001f\u007f]/.test(identity.sku)
    && digest(identity.originHash) && typeof identity.installationKey === 'string' && identity.installationKey.length > 0
    && typeof identity.bindingRevisionId === 'string' && identity.bindingRevisionId.length > 0
    && Number.isSafeInteger(identity.remoteId) && identity.remoteId > 0;
}
function historyProjection(history, identity) {
  if (!history || history.productId !== identity.productId || history.complete !== true
    || !Array.isArray(history.products) || history.products.length < 2 || history.products.length > 30
    || new Set(history.products.map(product => product.productId)).size !== history.products.length) return null;
  const current = history.products.find(product => product.productId === identity.productId);
  if (!current || current.article !== identity.sku || current.status !== 'active' || current.nextProductId != null
    || current.route !== 'hold' || !['historical_ambiguity', 'prior_exposure'].includes(current.holdReason)) return null;
  // Normalize only the exact lifecycle transition performed by the reviewed
  // recipe. Field adoption, receipt progress and job state are not history.
  return { ...history, products: history.products.map(product => product.productId === identity.productId
    ? { ...product, holdReason: 'prior_exposure', lifecycleOrigin: 'reconciliation' } : product) };
}
async function captureOnClient(client, identity, { history = null } = {}) {
  if (!validIdentity(identity)) throw c.error(409, 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_INVALID', 'Reviewed history identity is invalid.');
  history = history || await histories.read(client, identity.productId);
  const structural = historyProjection(history, identity);
  if (!structural) throw c.error(409, 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_INVALID', 'Reviewed history is incomplete or changed.');
  const input = await repair.readRepairInput(client), retained = buildHistoricalIndex(input);
  const ids = new Set(history.products.map(product => product.productId));
  return { format: FORMAT, scope: SCOPE, doesNotAcknowledgeExport: true, identity: { ...identity },
    historyHash: c.hash(structural), retainedHash: c.hash({
      snapshots: retained.snapshots.map(snapshot => ({ id: snapshot.snapshotId, fingerprint: snapshot.beforeFingerprint })),
      diagnostics: retained.diagnostics, events: input.events, cursor: input.state,
      revisions: input.revisions.filter(row => ids.has(Number(row.product_id)) && Number(row.product_id) !== identity.productId),
      currentDelivery: { productId: identity.productId,
        confirmedRevision: String(input.revisions.find(row => Number(row.product_id) === identity.productId)?.confirmed_revision ?? '0'),
        hasSnapshot: input.revisions.find(row => Number(row.product_id) === identity.productId)?.has_product_snapshot === true },
      memberships: input.members.filter(row => ids.has(Number(row.product_id))),
    }) };
}

function exactReceipt(row, identity, history) {
  const { receipt, handoff, item, binding, lifecycle, request } = row || {};
  const details = receipt?.details, recipe = recipes[receipt?.event_key], result = details?.result;
  const evidence = lifecycle?.evidence, prior = evidence?.magentoPriorExposure, envelope = details?.firstSyncAdmission;
  if (!recipe || receipt.subject_type !== 'magento_exposure_resolution' || !digest(receipt.subject_id)
    || !positive(receipt.actor_user_id) || Number(receipt.actor_user_id) !== Number(handoff?.actor_user_id)
    || !digest(details?.beforeFingerprint) || details.doesNotAcknowledgeExport !== true
    || details.originHash !== identity.originHash || details.bindingRevisionId !== identity.bindingRevisionId
    || details.remote?.id !== identity.remoteId || details.remote?.sku !== identity.sku
    || result?.productId !== identity.productId || String(result?.publicIdentityId) !== identity.publicIdentityId
    || result.sku !== identity.sku || result.planHash !== receipt.subject_id || result.handoffId !== handoff?.id
    || result.route !== 'hold' || result.holdReason !== 'prior_exposure'
    || handoff.kind !== 'broader_resync' || handoff.preview_hash !== receipt.subject_id
    || handoff.binding_revision_id !== identity.bindingRevisionId || handoff.evidence?.source !== recipe.source
    || handoff.evidence?.planHash !== receipt.subject_id || handoff.evidence?.doesNotAcknowledgeExport !== true
    || binding?.id !== identity.bindingRevisionId || binding.origin_hash !== identity.originHash
    || binding.installation_key !== identity.installationKey || binding.state !== 'published'
    || item?.handoff_id !== handoff.id || item.product_id !== identity.productId
    || String(item.public_product_identity_id) !== identity.publicIdentityId
    || item.reason !== 'reviewed_resync' || item.state !== 'enrolled' || !counter(item.generation)
    || request?.product_id !== identity.productId || String(request.public_product_identity_id) !== identity.publicIdentityId
    || !counter(request.desired_generation) || BigInt(request.desired_generation) < BigInt(item.generation)
    || lifecycle?.product_id !== identity.productId || lifecycle.route !== 'hold' || lifecycle.hold_reason !== 'prior_exposure'
    || evidence?.origin !== 'reconciliation' || evidence.action !== recipe.action
    || prior?.originHash !== identity.originHash || prior.productId !== identity.remoteId || prior.sku !== identity.sku
    || prior.planHash !== receipt.subject_id || prior.doesNotAcknowledgeExport !== true
    || !envelope || envelope.format !== FORMAT || envelope.scope !== SCOPE || envelope.doesNotAcknowledgeExport !== true
    || !digest(envelope.historyHash) || !digest(envelope.retainedHash)
    || c.hash(envelope.identity) !== c.hash(identity) || c.hash(handoff.evidence.firstSyncAdmission) !== c.hash(envelope)
    || c.hash([...(details.lineageProductIds || [])].sort((a, b) => a - b))
      !== c.hash(history.products.map(product => product.productId).sort((a, b) => a - b))) return null;
  return envelope;
}

async function readOnClient(client, config, observation, { history = null } = {}) {
  const identity = identityFromObservation(observation);
  if (!validIdentity(identity) || identity.originHash !== c.originHash(config.baseUrl) || observation.raw.sku !== identity.sku)
    return denied('FIRST_SYNC_HISTORY_ADMISSION_IDENTITY_CHANGED');
  const rows = (await client.query(`SELECT to_jsonb(a) receipt,to_jsonb(h) handoff,
    to_jsonb(i)||jsonb_build_object('generation',i.generation::text,'public_product_identity_id',i.public_product_identity_id::text) item,
    to_jsonb(b) binding,to_jsonb(f) lifecycle,
    to_jsonb(r)||jsonb_build_object('desired_generation',r.desired_generation::text,'public_product_identity_id',r.public_product_identity_id::text) request
    FROM product_full_export_state f
    JOIN audit_events a ON a.subject_id=f.evidence->'magentoPriorExposure'->>'planHash'
      AND a.event_key=ANY($2::text[]) AND a.subject_type='magento_exposure_resolution'
    JOIN magento_binding_handoffs h ON h.id=a.details->'result'->>'handoffId'
    JOIN magento_binding_handoff_items i ON i.handoff_id=h.id AND i.product_id=f.product_id
    JOIN magento_binding_revisions b ON b.id=h.binding_revision_id
    LEFT JOIN magento_product_sync_requests r ON r.public_product_identity_id=i.public_product_identity_id
    WHERE f.product_id=$1 ORDER BY a.id LIMIT 2`, [identity.productId, Object.keys(recipes)])).rows;
  if (rows.length !== 1) return denied('FIRST_SYNC_HISTORY_ADMISSION_RECEIPT_REQUIRED');
  history = history || await histories.read(client, identity.productId);
  if (!historyProjection(history, identity)) return denied('FIRST_SYNC_HISTORY_ADMISSION_CHANGED');
  let envelope;
  try { envelope = exactReceipt(rows[0], identity, history); }
  catch { return denied('FIRST_SYNC_HISTORY_ADMISSION_RECEIPT_REQUIRED'); }
  if (!envelope) return denied('FIRST_SYNC_HISTORY_ADMISSION_RECEIPT_REQUIRED');
  const current = await captureOnClient(client, identity, { history });
  if (c.hash(current) !== c.hash(envelope)) return denied('FIRST_SYNC_HISTORY_ADMISSION_CHANGED');
  const admission = Object.freeze({}), evidenceHash = c.hash({ envelope, auditId: rows[0].receipt.id, handoffId: rows[0].handoff.id });
  proofs.set(admission, { identity, product: observation.amber.product, evidenceHash,
    productIds: history.products.map(product => product.productId), skus: [...new Set(history.products.map(product => product.article))] });
  return { admission, reason: null, evidenceHash };
}
function allows(observation, admission) {
  const proof = proofs.get(admission);
  return Boolean(proof && observation?.amber?.product === proof.product
    && observation.raw?.sku === proof.identity.sku && c.hash(identityFromObservation(observation)) === c.hash(proof.identity));
}

const changed = () => c.error(409, 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED', 'Reviewed history changed before the local transaction.');
async function lockOnClient(client, { productIds, skus }) {
  const ids = [...new Set(productIds)].sort((a, b) => a - b), articles = [...new Set(skus)].sort();
  if (!ids.length || ids.length > 30 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || !articles.length || articles.some(sku => typeof sku !== 'string' || !sku)) throw changed();
  try {
    // NOWAIT avoids reversing an existing current-product lock into an ancestor
    // wait. All locks are local to the caller's short mutation transaction.
    const products = await client.query('SELECT id FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE NOWAIT', [ids]);
    if (products.rows.length !== ids.length) throw changed();
    const states = await client.query('SELECT product_id FROM product_full_export_state WHERE product_id=ANY($1::int[]) ORDER BY product_id FOR UPDATE NOWAIT', [ids]);
    if (states.rows.length !== ids.length) throw changed();
    const identities = await client.query('SELECT id FROM public_product_identities WHERE public_sku=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT', [articles]);
    if (identities.rows.length !== articles.length) throw changed();
    await client.query('SELECT product_id FROM product_export_revisions WHERE product_id=ANY($1::int[]) ORDER BY product_id FOR UPDATE NOWAIT', [ids]);
    await client.query('SELECT full_sku FROM sku_registry WHERE first_product_id=ANY($1::int[]) ORDER BY full_sku FOR SHARE NOWAIT', [ids]);
    // Retained inventory includes legacy files without indexed memberships.
    // These table locks close new-file/edge phantoms; no audit or pricing table
    // lock is taken and no remote operation runs under this boundary.
    await client.query('LOCK TABLE product_corrections,export_snapshots,magento_export_artifacts,export_snapshot_products,export_events,export_state IN SHARE MODE NOWAIT');
  } catch (cause) {
    if (cause.code === '55P03') throw changed();
    throw cause;
  }
}
async function assertOnClient(client, config, observation, admission) {
  const proof = proofs.get(admission);
  if (!proof || !allows(observation, admission)) throw changed();
  await lockOnClient(client, proof);
  const fresh = await readOnClient(client, config, observation);
  if (!fresh.admission || fresh.evidenceHash !== proof.evidenceHash) throw changed();
  return fresh;
}

module.exports = { captureOnClient, readOnClient, allows, lockOnClient, assertOnClient };
