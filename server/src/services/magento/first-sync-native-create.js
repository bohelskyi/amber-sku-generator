// A fresh ordinary allocation's initial CSV-retirement floor is not delivery.
// This SELECT-only capability never repairs history, media or a queue. The caller
// still owns current authority, binding/product/generation locks and remote reads.
const c = require('./binding-contract');
const { assertCompiled } = require('../export-templates/definition');
const photos = require('../product-photos.service');
const proofs = new WeakMap();
const FORMAT = 'allocated-ordinary-create-v1';
const clean = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => a !== undefined && b !== undefined && c.hash(clean(a)) === c.hash(clean(b));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => value == null ? NaN : new Date(value).getTime();
const denied = () => null;
const changed = () => c.error(409, 'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED', 'Новий товар або його початкове передавання фото змінилися.');

async function inspect(client, config, observation, { jobId = null, referenceOnly = false } = {}) {
  const amber = observation?.amber, product = amber?.product, revision = amber?.revision;
  if (!product || !revision || !referenceOnly && observation.raw !== null) return denied();
  if(referenceOnly && (!observation.raw || observation.raw.sku!==product.public_sku
    || !Number.isSafeInteger(observation.raw.id) || observation.raw.id<1)) return denied();
  try { assertCompiled(amber.compiled); } catch { return denied(); }
  if (revision.state !== 'published' || revision.originHash !== c.originHash(config.baseUrl)
    || revision.definitionHash !== amber.compiled.hash || amber.template?.kind !== 'published'
    || amber.template.versionId !== revision.templateVersionId) return denied();
  const facts = (await client.query(`SELECT to_jsonb(p) product,to_jsonb(i) identity,to_jsonb(f) lifecycle,
    to_jsonb(v) characteristic,to_jsonb(g) activation,to_jsonb(b) binding,
    to_jsonb(a) cutover,to_jsonb(cb) cutover_binding
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    JOIN product_full_export_state f ON f.product_id=p.id
    JOIN product_characteristic_versions v ON v.id=p.characteristic_version_id
    CROSS JOIN magento_auto_sync_activation g
    JOIN magento_binding_revisions b ON b.installation_key=g.installation_key AND b.state='published'
    LEFT JOIN audit_events a ON a.id=g.cutover_event_id
    LEFT JOIN magento_binding_revisions cb ON cb.id=a.details->>'bindingRevisionId'
    WHERE p.id=$1 AND g.singleton ORDER BY b.version_number DESC LIMIT 1`, [product.id])).rows[0];
  if (!facts) return denied();
  const { product: p, identity: i, lifecycle: f, characteristic: v, activation: g, binding: b, cutover: a, cutover_binding: cb } = facts;
  // Preserve PostgreSQL's established BIGINT/NUMERIC row decoding for amber_hash.
  // JSON facts are useful for predicates, but are not the native job protocol.
  const nativeProduct = (await client.query(`SELECT p.*,i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [product.id])).rows[0];
  const nativeLifecycle = (await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [product.id])).rows[0];
  if (!nativeProduct || !nativeLifecycle) return denied();
  if (p.id !== product.id || String(p.public_product_identity_id) !== String(product.public_product_identity_id)
    || i.public_sku !== product.public_sku || p.category !== product.category || i.origin !== 'allocated' || i.is_test_product !== false
    || p.full_sku !== null || p.sku_schema_version_id !== null || p.characteristic_version_id == null
    || String(p.characteristic_version_id) !== String(product.characteristic_version_id)
    || p.status !== 'active' || p.exclude_from_export !== 0 || p.corrected_from_product_id !== null || p.corrected_to_product_id !== null
    || v.category_code !== p.category || v.snapshot?.contract !== 'product-characteristics-v1'
    || v.snapshot.category_code !== p.category || !hex(v.config_hash) || c.hash(v.snapshot)!==v.config_hash
    || f.route !== 'normal' || f.hold_reason !== null || f.source_correction_id !== null
    || f.business_exclusion_state !== 'none' || f.recount_compatibility_excluded !== false
    || String(f.revision) !== '1' || String(f.csv_retired_revision) !== '1' || String(f.delivery_version) !== '1'
    || ['confirmed_revision', 'cutover_baseline_revision', 'externally_delivered_revision'].some(key => String(f[key]) !== '0')
    || f.cutover_baseline_event_id !== null || f.externally_delivered_event_id !== null || f.repair_manifest_hash !== null
    || f.last_resolution_key !== null || f.resolved_at !== null || f.resolved_by_user_id !== null
    || !same(f.evidence, { origin: 'ordinary_save' })
    || g.legacy_product_csv_enabled !== false || b.id !== revision.id || b.origin_hash !== revision.originHash
    || b.template_definition_hash !== amber.compiled.hash || b.installation_key !== revision.installationKey
    || !a || a.event_key !== 'magento_delivery.cutover' || a.subject_type !== 'magento_delivery'
    || a.subject_id !== b.installation_key || String(a.actor_user_id) !== String(g.cutover_by_user_id)
    || !hex(a.details?.planHash) || !cb || cb.state !== 'published' || cb.origin_hash !== b.origin_hash
    || cb.installation_key !== b.installation_key || String(a.details.bindingVersionNumber) !== String(cb.version_number)
    || !Number.isFinite(time(g.cutover_at)) || time(a.occurred_at) !== time(g.cutover_at)
    || !Number.isFinite(time(p.created_at)) || !Number.isFinite(time(i.created_at))
    || time(p.created_at) < time(g.cutover_at) || time(i.created_at) < time(g.cutover_at) || time(i.created_at) > time(p.created_at)) return denied();
  const identityId = String(p.public_product_identity_id);
  const absence = (await client.query(`SELECT
    (SELECT count(*)::int FROM products WHERE public_product_identity_id=$2) AS revisions,
    EXISTS(SELECT 1 FROM product_corrections WHERE source_product_id=$1 OR corrected_product_id=$1)
      OR EXISTS(SELECT 1 FROM correction_requests WHERE source_product_id=$1 OR corrected_product_id=$1)
      OR EXISTS(SELECT 1 FROM products WHERE corrected_from_product_id=$1 OR corrected_to_product_id=$1) AS corrections,
    EXISTS(SELECT 1 FROM magento_first_sync_sessions WHERE public_product_identity_id=$2 OR initial_product_id=$1 OR public_sku=$3) AS sessions,
    EXISTS(SELECT 1 FROM export_snapshot_products WHERE product_id=$1) AS snapshots,
    EXISTS(SELECT 1 FROM product_export_revisions WHERE product_id=$1
      AND (confirmed_revision>0 OR has_product_snapshot OR revision>1)) AS legacy_exports,
    EXISTS(SELECT 1 FROM price_export_snapshots s WHERE position($3 in s.csv_content)>0
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.captured_revisions) e WHERE e->>'productId'=$1::text)) AS price_exports,
    EXISTS(SELECT 1 FROM product_visibility_intents WHERE public_product_identity_id=$2 OR product_id=$1 OR public_sku=$3) AS visibility,
    EXISTS(SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=$2 OR product_id=$1 OR public_sku=$3) AS historical_reactivation,
    EXISTS(SELECT 1 FROM historical_standard_intents WHERE public_product_identity_id=$2 OR product_id=$1 OR public_sku=$3) AS historical_standard,
    EXISTS(SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$2 OR product_id=$1 OR public_sku=$3) AS deletion`, [p.id, identityId, i.public_sku])).rows[0];
  if (!absence || absence.revisions !== 1 || Object.entries(absence).some(([key, value]) => key !== 'revisions' && value !== false)) return denied();
  const creation = (await client.query(`SELECT * FROM audit_events WHERE event_key='product.created'
    AND subject_type='product' AND subject_id=$1 ORDER BY id LIMIT 2`, [String(p.id)])).rows;
  if (creation.length !== 1 || creation[0].details?.fullSku !== null || creation[0].details.publicSku !== i.public_sku
    || creation[0].details.categoryCode !== p.category || p.created_by_user_id == null
    || String(creation[0].actor_user_id) !== String(p.created_by_user_id) || time(creation[0].occurred_at) !== time(p.created_at)) return denied();
  const request = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [identityId])).rows[0];
  if (!request || request.product_id !== p.id || String(request.synced_generation) !== '0'
    || !referenceOnly && request.reason_code === 'reconciliation_required' || !['pending', 'syncing', 'needs_attention'].includes(request.state)) return denied();
  const media = (await client.query('SELECT * FROM product_media_jobs WHERE public_product_identity_id=$1 OR product_id=$2 ORDER BY id LIMIT 2', [identityId, p.id])).rows;
  let mediaEvidence = null;
  if (media.length) {
    if (media.length !== 1) return denied();
    const m = media[0];
    if (Number(m.product_id) !== p.id || String(m.public_product_identity_id) !== identityId || m.state !== 'pending' || String(m.version) !== '1'
      || m.required_permission !== 'products.create' || String(m.actor_user_id) !== String(p.created_by_user_id)
      || ['origin_hash', 'binding_revision_id', 'remote_product_id', 'native_generation', 'preservation', 'verified_at',
        'inherited_from_product_id', 'inherited_from_job_id', 'superseded_by_job_id', 'failure_code'].some(key => m[key] !== null)) return denied();
    if ((await client.query('SELECT 1 FROM product_media_steps WHERE job_id=$1 LIMIT 1', [m.id])).rowCount) return denied();
    const set = (await client.query('SELECT * FROM product_photo_sets WHERE product_id=$1', [p.id])).rows[0];
    if (!set || String(set.version) !== '1' || !same(set.photo_ids, m.photo_ids) || set.enable_when_verified !== m.enable_when_verified
      || !m.photo_ids.length || m.intent_hash !== photos.mediaIntent({ id: p.id, public_product_identity_id: identityId }, m.version, m.photo_ids, m.enable_when_verified)) return denied();
    const assets = (await client.query('SELECT id,product_id,actor_user_id,content_hash FROM product_photo_assets WHERE id=ANY($1::uuid[]) ORDER BY id', [m.photo_ids])).rows;
    if (assets.length !== m.photo_ids.length || assets.some(asset => Number(asset.product_id) !== p.id
      || String(asset.actor_user_id) !== String(p.created_by_user_id) || !hex(asset.content_hash))) return denied();
    const receipts = (await client.query(`SELECT * FROM audit_events WHERE event_key='product.photos_saved'
      AND subject_type='product' AND subject_id=$1 ORDER BY id LIMIT 2`, [String(p.id)])).rows;
    const receipt = receipts[0];
    if (receipts.length !== 1 || String(receipt.actor_user_id) !== String(p.created_by_user_id)
      || time(receipt.occurred_at) !== time(p.created_at) || receipt.request_id !== creation[0].request_id
      || receipt.details?.jobId !== m.id || String(receipt.details.version) !== '1'
      || !same(receipt.details.photoIds, m.photo_ids) || receipt.details.enableWhenVerified !== m.enable_when_verified) return denied();
    mediaEvidence = { job: m, set, assets, receipt };
  } else if ((await client.query('SELECT 1 FROM product_photo_sets WHERE product_id=$1 LIMIT 1', [p.id])).rowCount) return denied();
  const frame = { format: FORMAT, product: p, identity: i, lifecycle: f, characteristic: v,
    binding: b, cutover: a, cutoverBinding: cb, creation: creation[0], media: mediaEvidence,
    generation: String(request.desired_generation) };
  const reference = { format: FORMAT, productId: p.id, publicIdentityId: identityId, sku: i.public_sku,
    bindingRevisionId: b.id, creationEventId: String(creation[0].id), evidenceHash: c.hash(frame) };
  const jobs = (await client.query('SELECT * FROM magento_sync_jobs WHERE public_product_identity_id=$1 OR product_id=$2 OR sku=$3 ORDER BY id LIMIT 2', [identityId, p.id, i.public_sku])).rows;
  if (!jobId) {
    if (jobs.length || request.active_job_id !== null || request.active_generation !== null) return denied();
  } else {
    if (jobs.length !== 1 || jobs[0].id !== jobId) return denied();
    const job = jobs[0];
    if (job.product_id !== p.id || String(job.public_product_identity_id) !== identityId || job.sku !== i.public_sku || job.origin_hash !== b.origin_hash || job.installation_key !== b.installation_key
      || job.binding_revision_id !== b.id || job.automatic_generation == null
      || String(job.automatic_generation) !== String(request.desired_generation) || request.active_job_id !== job.id
      || String(request.active_generation) !== String(job.automatic_generation) || !['queued', 'running', 'retryable', 'blocked', 'uncertain'].includes(job.state)
      || job.intent?.mode !== 'create' || job.intent.operations?.[0]?.domain !== 'coreProduct'
      || job.intent.operations[0].payload?.product?.sku !== i.public_sku || job.intent.operations[0].payload.product.status !== 2
      || job.baseline?.raw !== null || !same(job.baseline.allocatedFirstCreate, reference)
      || job.amber_hash !== c.hash(clean({ product: nativeProduct, lifecycle: nativeLifecycle })) || job.plan_hash !== c.hash(job.intent)
      || job.binding_hash !== c.hash(clean(revision))) return denied();
    const steps = (await client.query('SELECT ordinal,state FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [job.id])).rows;
    if (!referenceOnly && (steps.length || job.remote_product_id !== null || job.state === 'uncertain')) return denied();
    const enqueued = (await client.query(`SELECT * FROM audit_events WHERE event_key='magento_sync.enqueued'
      AND subject_type='magento_sync_job' AND subject_id=$1 ORDER BY id LIMIT 2`, [job.id])).rows;
    if (enqueued.length !== 1 || enqueued[0].details?.planHash !== job.plan_hash
      || String(enqueued[0].actor_user_id) !== String(job.created_by_user_id)) return denied();
  }
  return { reference, evidenceHash: reference.evidenceHash, jobId };
}

async function readOnClient(client, config, observation, options = {}) {
  const result = await inspect(client, config, observation, options);
  if (!result) return null;
  const proof = Object.freeze({});
  proofs.set(proof, { ...result, config, observation, referenceOnly: options.referenceOnly === true });
  return proof;
}
function baselineReference(proof) {
  const saved = proofs.get(proof);
  if (!saved) throw changed();
  return clean(saved.reference);
}
async function assertOnClient(client, proof) {
  const saved = proofs.get(proof);
  if (!saved) throw changed();
  const fresh = await inspect(client, saved.config, saved.observation, { jobId: saved.jobId, referenceOnly: saved.referenceOnly });
  if (!fresh || fresh.evidenceHash !== saved.evidenceHash) throw changed();
}
module.exports = { readOnClient, baselineReference, assertOnClient };
