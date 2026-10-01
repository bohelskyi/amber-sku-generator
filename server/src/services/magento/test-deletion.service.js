const { randomUUID } = require('node:crypto');
const c = require('./binding-contract');
const { clean } = require('./sync-job-plan');
const { createMagentoClient } = require('./client');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');
const { readLineageExposure } = require('../full-product-export-exposure');
const { retireFullProduct } = require('../full-product-export.service');

const fail = (code, message = 'Тестове видалення небезпечне. Використайте звичайне архівування.') => {
  throw c.error(409, code, message);
};
const receipt = (row) => ({ intentId: row.id, productId: row.product_id, publicSku: row.public_sku,
  internalSku: row.internal_sku, state: row.state, previewHash: row.preview_hash });
function dependencies(options) {
  return { ...options, databasePool: options.databasePool || require('../../db/pool'),
    actorUserId: options.mutationContext?.actorUserId };
}
function transaction(options, operation) {
  return runAccessAdminMutation({ databasePool: options.databasePool, actorUserId: options.actorUserId,
    requiredPermission: 'products.delete_test', createError: c.error, operation });
}
async function audit(client, options, row, event) {
  await writeAuditEvent(client, { mutationContext: options.mutationContext,
    eventKey: `product.test_delete_${event}`, subjectType: 'product', subjectId: row.product_id,
    details: { intentId: row.id, publicSku: row.public_sku, internalSku: row.internal_sku, state: row.state } });
}
async function existing(client, productId) {
  return (await client.query('SELECT * FROM magento_test_deletions WHERE product_id=$1', [productId])).rows[0];
}
async function eligible(client, productId, origin) {
  const product = (await client.query(`SELECT p.*,i.public_sku,i.origin AS identity_origin
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE p.id=$1 FOR UPDATE OF p`, [productId])).rows[0];
  if (!product || product.status !== 'active' || product.corrected_from_product_id
    || product.corrected_to_product_id || product.exclude_from_export !== 0) fail('TEST_DELETE_NOT_CURRENT');
  if (product.identity_origin !== 'allocated' || !/^AG-[0-9]{6,}$/.test(product.public_sku)) fail('TEST_DELETE_LEGACY_IDENTITY');
  const ownership = (await client.query(`SELECT
    (SELECT count(*)::int FROM products WHERE public_product_identity_id=$1 OR full_sku=$2) AS revisions,
    (SELECT first_product_id FROM sku_registry WHERE full_sku=$2) AS owner`,
  [product.public_product_identity_id, product.full_sku])).rows[0];
  if (ownership.revisions !== 1 || ownership.owner !== product.id) fail('TEST_DELETE_IDENTITY_OWNERSHIP');
  const lifecycle = (await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1 FOR UPDATE', [productId])).rows[0];
  if (!lifecycle || lifecycle.route !== 'normal' || lifecycle.evidence?.origin !== 'ordinary_save'
    || lifecycle.business_exclusion_state !== 'none' || lifecycle.recount_compatibility_excluded
    || lifecycle.source_correction_id || lifecycle.resolved_at || lifecycle.last_resolution_key
    || Number(lifecycle.confirmed_revision) || Number(lifecycle.cutover_baseline_revision)
    || Number(lifecycle.externally_delivered_revision)) fail('TEST_DELETE_LIFECYCLE_EVIDENCE');
  const business = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM correction_requests WHERE source_product_id=$1 OR corrected_product_id=$1) AS corrections,
    EXISTS(SELECT 1 FROM product_corrections WHERE source_product_id=$1 OR corrected_product_id=$1
      OR source_sku=$2 OR corrected_sku=$2) AS lineage,
    EXISTS(SELECT 1 FROM repricing_items WHERE product_id=$1 OR sku=$2 OR sku=$5) AS repricing,
    EXISTS(SELECT 1 FROM repricing_drafts WHERE status='draft' AND (category_code=$3 OR scope='global')) AS draft,
    EXISTS(SELECT 1 FROM product_export_revisions WHERE product_id=$1) AS price,
    EXISTS(SELECT 1 FROM export_snapshot_products WHERE product_id=$1) AS exported,
    EXISTS(SELECT 1 FROM price_export_snapshots s, jsonb_array_elements(s.captured_revisions) e
      WHERE e->>'productId'=$4 OR e->>'sku'=$2 OR e->>'sku'=$5
        OR e->>'internalSku'=$2 OR e->>'publicSku'=$5) AS price_delivery,
    EXISTS(SELECT 1 FROM audit_events WHERE subject_type='product' AND subject_id=$4
      AND event_key NOT IN ('product.created','product.test_delete_sealed','product.test_delete_dispatched',
        'product.test_delete_verified')) AS history`,
  [productId, product.full_sku, product.category, String(productId), product.public_sku])).rows[0];
  if (Object.values(business).some(Boolean)) fail('TEST_DELETE_BUSINESS_EVIDENCE');
  const exposure = await readLineageExposure(client, productId, product);
  if (exposure.evidence.classification !== 'reliably_unexposed') fail('TEST_DELETE_EXPORT_EVIDENCE');
  const jobs = (await client.query(`SELECT * FROM magento_sync_jobs
    WHERE public_product_identity_id=$1 OR product_id=$2 OR sku=$3 ORDER BY created_at,id`,
  [product.public_product_identity_id, productId, product.public_sku])).rows;
  if (jobs.some((job) => !['succeeded','superseded'].includes(job.state))) fail('TEST_DELETE_UNRESOLVED_SYNC');
  const creates = jobs.filter((job) => job.state === 'succeeded' && job.intent.mode === 'create');
  if (creates.length !== 1 || !creates[0].remote_product_id || creates[0].origin_hash !== origin
    || creates[0].product_id !== productId || creates[0].sku !== product.public_sku
    || jobs.some((job) => job.state === 'succeeded' &&
      (job.origin_hash !== origin || job.remote_product_id !== creates[0].remote_product_id
        || (job.baseline.raw && job.baseline.raw.status !== 2)))) fail('TEST_DELETE_CREATE_PROOF_REQUIRED');
  if ((await client.query(`SELECT 1 FROM magento_sync_steps s JOIN magento_sync_jobs j ON j.id=s.job_id
    WHERE j.public_product_identity_id=$1 AND s.state='dispatched'`, [product.public_product_identity_id])).rowCount) {
    fail('TEST_DELETE_UNRESOLVED_SYNC');
  }
  const request = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE',
    [product.public_product_identity_id])).rows[0];
  if (request && (request.state !== 'synced' || request.active_job_id)) fail('TEST_DELETE_SYNC_PENDING');
  const nameStates = (await client.query('SELECT * FROM magento_name_sync_states WHERE public_product_identity_id=$1',
    [product.public_product_identity_id])).rows;
  if (nameStates.some((state) => state.origin_hash !== origin || state.state !== 'common'
    || String(state.remote_product_id) !== String(creates[0].remote_product_id))) fail('TEST_DELETE_NAME_EVIDENCE');
  return { product, lifecycle, create: creates[0], localHash: c.hash(clean({ product, lifecycle, nameStates,
    generation: request?.desired_generation || null, jobs: jobs.map((j) => [j.id,j.state,j.remote_product_id]) })) };
}
async function observe(config, sku, remoteId, options) {
  let product;
  try { product = await createMagentoClient(config, { fetchImpl: options.fetchImpl }).findProductBySku(sku); }
  catch (error) { if (error.code === 'MAGENTO_PRODUCT_NOT_FOUND') return null; throw error; }
  if (product.sku !== sku || String(product.id) !== String(remoteId)) fail('TEST_DELETE_REMOTE_IDENTITY_CHANGED');
  // Products already offered for sale are deliberately outside this hotfix.
  if (product.status !== 2) fail('TEST_DELETE_REMOTE_NOT_DISABLED');
  return product;
}
function validateInput(input, apply = false) {
  c.command(input, apply ? ['productId','previewHash','confirmation'] : ['productId']);
  if (!c.positive(input.productId)) fail('TEST_DELETE_INPUT_INVALID');
  if (apply && (typeof input.confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewHash))) fail('TEST_DELETE_INPUT_INVALID');
}
async function preview(config, input, supplied = {}) {
  validateInput(input); const options = dependencies(supplied);
  const local = await transaction(options, async (client) => {
    const row = await existing(client, input.productId);
    if (row) {
      if (row.origin_hash !== c.originHash(config.baseUrl)) fail('TEST_DELETE_ORIGIN_CHANGED');
      return { row };
    }
    return eligible(client, input.productId, c.originHash(config.baseUrl));
  });
  if (local.row) return receipt(local.row);
  const remote = await observe(config, local.product.public_sku, local.create.remote_product_id, options);
  const binding = { productId: input.productId, publicIdentityId: local.product.public_product_identity_id,
    publicSku: local.product.public_sku, internalSku: local.product.full_sku, originHash: c.originHash(config.baseUrl),
    remoteId: local.create.remote_product_id, createJobId: local.create.id, actorUserId: options.actorUserId,
    localHash: local.localHash, remoteHash: c.hash(remote) };
  return { productId: input.productId, publicSku: binding.publicSku, internalSku: binding.internalSku,
    state: 'preview', previewHash: c.hash(binding) };
}
async function apply(config, input, supplied = {}) {
  validateInput(input, true); const options = dependencies(supplied); const db = options.databasePool;
  // Same lock order as the automatic lane: public identity then origin/SKU.
  const identity = await transaction(options, async (client) => (await client.query(`SELECT p.public_product_identity_id,i.public_sku
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [input.productId])).rows[0]);
  if (!identity) fail('TEST_DELETE_NOT_CURRENT');
  if (input.confirmation !== identity.public_sku) fail('TEST_DELETE_CONFIRMATION_REQUIRED', 'Введіть точний публічний артикул товару.');
  const locks = [`amber_magento_public_identity:${identity.public_product_identity_id}`,
    `amber_magento_sync:${c.originHash(config.baseUrl)}:${identity.public_sku}`];
  const connection = await db.connect(); const held = [];
  // Reuse this lane's connection for each short transaction. Releasing a
  // transaction must not release the session locks or consume a second pool slot.
  const borrowed = { query: (...args) => connection.query(...args), release() {} };
  const lockedTransaction = (operation) => transaction({ ...options,
    databasePool: { connect: async () => borrowed } }, operation);
  try {
    for (const key of locks) {
      if (!(await connection.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0].held) {
        fail('TEST_DELETE_BUSY', 'Синхронізація ще триває. Повторіть перевірку пізніше.');
      }
      held.push(key);
    }
    let row = await lockedTransaction((client) => existing(client, input.productId));
    if (!row) {
      const local = await lockedTransaction((client) => eligible(client, input.productId, c.originHash(config.baseUrl)));
      const remote = await observe(config, identity.public_sku, local.create.remote_product_id, options);
      const binding = { productId: input.productId, publicIdentityId: identity.public_product_identity_id,
        publicSku: identity.public_sku, internalSku: local.product.full_sku, originHash: c.originHash(config.baseUrl),
        remoteId: local.create.remote_product_id, createJobId: local.create.id, actorUserId: options.actorUserId,
        localHash: local.localHash, remoteHash: c.hash(remote) };
      if (c.hash(binding) !== input.previewHash) fail('TEST_DELETE_PREVIEW_STALE', 'Дані змінилися. Виконайте нову перевірку.');
      row = await lockedTransaction(async (client) => {
        const current = await eligible(client, input.productId, binding.originHash);
        if (current.localHash !== binding.localHash) fail('TEST_DELETE_PREVIEW_STALE');
        const saved = (await client.query(`INSERT INTO magento_test_deletions
          (id,product_id,public_product_identity_id,public_sku,internal_sku,origin_hash,remote_product_id,
           create_job_id,actor_user_id,local_hash,remote_hash,preview_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [randomUUID(),input.productId,binding.publicIdentityId,binding.publicSku,binding.internalSku,binding.originHash,
          binding.remoteId,binding.createJobId,options.actorUserId,binding.localHash,binding.remoteHash,input.previewHash])).rows[0];
        await audit(client, options, saved, 'sealed'); return saved;
      });
    }
    if (row.origin_hash !== c.originHash(config.baseUrl) || row.preview_hash !== input.previewHash
      || row.public_sku !== input.confirmation) fail('TEST_DELETE_PREVIEW_STALE');
    if (row.state === 'finalized') return receipt(row);
    let remote = await observe(config, row.public_sku, row.remote_product_id, options);
    if (remote && row.state !== 'sealed') return { ...receipt(row), reconciliationRequired: true };
    if (remote) {
      if (c.hash(remote) !== row.remote_hash) fail('TEST_DELETE_REMOTE_CHANGED', 'Magento змінився після перевірки. Потрібна технічна звірка; DELETE не надіслано.');
      row = await lockedTransaction(async (client) => {
        const current = await eligible(client, input.productId, row.origin_hash);
        if (current.localHash !== row.local_hash) fail('TEST_DELETE_PREVIEW_STALE');
        const saved = (await client.query(`UPDATE magento_test_deletions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP
          WHERE id=$1 AND state='sealed' RETURNING *`, [row.id])).rows[0];
        if (!saved) fail('TEST_DELETE_BUSY');
        await audit(client, options, saved, 'dispatched'); return saved;
      });
      try { await require('./test-deletion-transport').deleteSealedProduct(config, row, { fetchImpl: options.fetchImpl }); }
      catch { /* The durable marker is authoritative; only a read can resolve uncertainty. */ }
      try { remote = await observe(config, row.public_sku, row.remote_product_id, options); }
      catch { return { ...receipt(row), reconciliationRequired: true }; }
      if (remote) return { ...receipt(row), reconciliationRequired: true };
    }
    if (row.state !== 'verified') row = await lockedTransaction(async (client) => {
      const saved = (await client.query(`UPDATE magento_test_deletions SET state='verified',verified_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND state IN ('sealed','dispatched') RETURNING *`, [row.id])).rows[0];
      if (!saved) fail('TEST_DELETE_BUSY');
      await audit(client, options, saved, 'verified'); return saved;
    });
    return await lockedTransaction(async (client) => {
      const saved = await existing(client, row.product_id);
      if (saved.state === 'finalized') return receipt(saved);
      if (saved.state !== 'verified') fail('TEST_DELETE_NOT_VERIFIED');
      const current = await eligible(client, row.product_id, row.origin_hash);
      if (current.localHash !== row.local_hash) fail('TEST_DELETE_PREVIEW_STALE');
      await client.query("UPDATE products SET status='voided',exclude_from_export=1 WHERE id=$1", [row.product_id]);
      await retireFullProduct(client, row.product_id);
      const result = (await client.query(`UPDATE magento_test_deletions SET state='finalized',finalized_at=CURRENT_TIMESTAMP
        WHERE id=$1 RETURNING *`, [row.id])).rows[0];
      await audit(client, options, result, 'finalized'); return receipt(result);
    });
  } finally {
    for (const key of held.reverse()) await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    connection.release();
  }
}
module.exports = { preview, apply };
