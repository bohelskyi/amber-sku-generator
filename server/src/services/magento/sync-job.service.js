const { randomUUID } = require('node:crypto');
const c = require('./binding-contract');
const plan = require('./sync-job-plan');
const { previewProduct } = require('./sync-preview');
const { createMagentoClient } = require('./client');
const { readDomains } = require('./sync-preview-domains');
const { evaluate } = require('./binding-evidence-products');
const { readRevisionOnClient } = require('./binding.service');
const { dispatch } = require('./sync-write-client');
const { assertEvidenceSafe } = require('./binding-evidence-audit');
const { writeAuditEvent } = require('../../audit/audit-events');
const { APPLICATION_USER_ADMIN_LOCK_KEY, assertActorStillAuthorized } = require('../access-admin-transaction');
const gate = require('../full-product-cutover-gate');

async function ledger(db, actorUserId, action, operation) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const job = await operation(client);
    await writeAuditEvent(client, { mutationContext: { actorUserId, requestId: `magento-sync-${randomUUID()}` },
      eventKey: `magento_sync.${action}`, subjectType: 'magento_sync_job', subjectId: job.id,
      details: { state: job.state, planHash: job.plan_hash } });
    await client.query('COMMIT'); return job;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
async function guard(config, input, options, operation, applying = false) {
  c.identity(input.bindingRevisionId);
  if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) plan.fail('MAGENTO_SYNC_ACTOR_REQUIRED');
  if (typeof input.sku !== 'string' || !input.sku.trim() || input.sku.length > 256) plan.fail('MAGENTO_SYNC_SKU_REQUIRED');
  const db = options.databasePool; const client = await db.connect();
  const lock = `amber_magento_sync:${c.originHash(config.baseUrl)}:${input.sku}`;
  let held = false;
  try {
    if (applying) {
      held = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held;
      if (!held) plan.fail('MAGENTO_SYNC_BUSY');
    } else { await client.query('SELECT pg_advisory_lock(hashtext($1))', [lock]); held = true; }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
    await assertActorStillAuthorized(client, options.actorUserId, 'export_templates.publish', c.error);
    await gate.enterExisting(client);
    if (!(await client.query("SELECT to_regclass('magento_sync_jobs') AS present")).rows[0].present) plan.fail('MAGENTO_SYNC_MIGRATION_REQUIRED');
    const revision = await readRevisionOnClient(client, input.bindingRevisionId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${revision.installationKey}`]);
    const current = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`, [revision.installationKey])).rows[0];
    if (revision.state !== 'published' || current?.id !== revision.id) plan.fail('MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED');
    if (revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') plan.fail('MAGENTO_SYNC_INSTALLATION_MISMATCH');
    const rows = (await client.query('SELECT * FROM products WHERE full_sku=$1 ORDER BY id FOR NO KEY UPDATE', [input.sku])).rows;
    if (rows.length !== 1) plan.fail('MAGENTO_SYNC_PRODUCT_NOT_UNIQUE');
    const product = rows[0];
    const lifecycle = (await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1 FOR NO KEY UPDATE', [product.id])).rows[0];
    if (!lifecycle) plan.fail('MAGENTO_SYNC_PRODUCT_STATE_MISSING');
    const state = { productId: product.id, amberHash: c.hash(plan.clean({ product, lifecycle })),
      bindingHash: c.hash(plan.clean(revision)), revision };
    const result = await operation(state);
    await gate.commit(client); return result;
  } catch (e) { await gate.rollback(client).catch(() => {}); throw e; }
  finally {
    await gate.release(client).catch(() => {});
    if (held) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]).catch(() => {});
    client.release();
  }
}
async function observe(config, input, options) {
  let observation;
  const report = await (options.preview || previewProduct)(config, { databasePool: options.databasePool,
    fetchImpl: options.fetchImpl, sku: input.sku, bindingRevisionId: input.bindingRevisionId,
    sensitiveValues: options.sensitiveValues || [],
    onObservation: (value) => { observation = value; } });
  if (!observation) plan.fail('MAGENTO_SYNC_OBSERVATION_REQUIRED');
  return { observation, report };
}
async function refresh(config, observation, options) {
  if (options.refresh) return options.refresh(observation);
  const client = createMagentoClient(config, { fetchImpl: options.fetchImpl });
  const sku = observation.amber.product.full_sku; let raw = null;
  try { raw = await client.findProductBySku(sku); }
  catch (e) { if (e.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw e; }
  const domainEvidence = await readDomains(config, { client, schema: observation.schema, sku, raw,
    expected: evaluate(observation.amber, observation.amber.product), fetchImpl: options.fetchImpl });
  if (domainEvidence.failures.length) plan.fail('MAGENTO_SYNC_READ_FAILED');
  return { ...observation, raw, domainEvidence };
}
async function enqueue(config, input, options) {
  return guard(config, input, options, async (state) => {
    const existing = (await options.databasePool.query(`SELECT * FROM magento_sync_jobs WHERE origin_hash=$1 AND sku=$2
      AND (state <> 'succeeded' OR (binding_revision_id=$3 AND amber_hash=$4)) ORDER BY created_at DESC LIMIT 1`,
    [state.revision.originHash, input.sku, input.bindingRevisionId, state.amberHash])).rows[0];
    if (existing) {
      if (existing.amber_hash !== state.amberHash) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
      if (existing.binding_hash !== state.bindingHash) plan.fail('MAGENTO_SYNC_BINDING_CHANGED');
      return existing; // Idempotent even after the successful plan changes the remote diff.
    }
    const { observation, report } = await observe(config, input, options);
    const intent = plan.intent(report); const baseline = plan.baseline(observation, report);
    assertEvidenceSafe({ intent, baseline }, config, options.sensitiveValues || []);
    return ledger(options.databasePool, options.actorUserId, 'enqueued', async (client) => (await client.query(`
      INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,
        binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING *`,
    [randomUUID(), state.productId, input.sku, state.revision.installationKey, state.revision.originHash,
      input.bindingRevisionId, state.bindingHash, state.amberHash, c.hash(intent), JSON.stringify(intent),
      JSON.stringify(baseline), options.actorUserId])).rows[0]);
  });
}
async function applyJob(config, id, options) {
  if (options.apply !== true) plan.fail('MAGENTO_SYNC_APPLY_REQUIRED');
  c.identity(id);
  let job = (await options.databasePool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
  if (!job) plan.fail('MAGENTO_SYNC_JOB_NOT_FOUND');
  const input = { sku: job.sku, bindingRevisionId: job.binding_revision_id };
  const saveState = (state, failure = null) => ledger(options.databasePool, options.actorUserId, state, async (client) =>
    (await client.query(`UPDATE magento_sync_jobs SET state=$2, failure=$3::jsonb, updated_at=CURRENT_TIMESTAMP,
      attempts=attempts+CASE WHEN $2='running' THEN 1 ELSE 0 END,
      acknowledged_at=CASE WHEN $2='succeeded' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=$1 RETURNING *`,
    [id, state, JSON.stringify(failure)])).rows[0]);
  return guard(config, input, options, async (state) => {
    job = (await options.databasePool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
    if (job.state === 'succeeded') return job;
    let activeOrdinal = null;
    try {
      if (job.amber_hash !== state.amberHash || job.product_id !== state.productId) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
      if (job.binding_hash !== state.bindingHash) plan.fail('MAGENTO_SYNC_BINDING_CHANGED');
      if (c.hash(job.intent) !== job.plan_hash) plan.fail('MAGENTO_SYNC_PLAN_INTEGRITY');
      job = await saveState('running');
      let { observation } = await observe(config, input, options);
      plan.replan(job, observation);
      if (observation.domainEvidence.failures?.length) plan.fail('MAGENTO_SYNC_READ_FAILED');
      plan.preflight(job, observation);
      for (let ordinal = 0; ordinal < job.intent.operations.length; ordinal++) {
        activeOrdinal = ordinal;
        const operation = job.intent.operations[ordinal];
        observation = await refresh(config, observation, options);
        plan.preserve(job, observation);
        const step = (await options.databasePool.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 AND ordinal=$2', [id, ordinal])).rows[0];
        if (!step && ordinal === 0 && job.intent.mode === 'create' && observation.raw) plan.fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
        if (!plan.matches(operation, observation)) {
          if (step) plan.fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
          plan.precondition(job, operation, observation);
          // Committed before HTTP. There is deliberately no path that resets this marker.
          await ledger(options.databasePool, options.actorUserId, 'dispatched', async (client) => {
            await client.query("INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at) VALUES($1,$2,'dispatched',CURRENT_TIMESTAMP)", [id, ordinal]);
            return job;
          });
          let uncertain = false;
          try { await (options.dispatch || dispatch)(config, operation, { apply: true, fetchImpl: options.fetchImpl }); }
          catch { uncertain = true; }
          observation = await refresh(config, observation, options);
          plan.preserve(job, observation);
          if (!plan.matches(operation, observation)) plan.fail(uncertain ? 'MAGENTO_SYNC_MUTATION_UNCERTAIN' : 'MAGENTO_SYNC_VERIFICATION_MISMATCH');
        }
        if (step?.state !== 'verified') job = await ledger(options.databasePool, options.actorUserId, 'verified', async (client) => {
          await client.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,verified_at) VALUES($1,$2,'verified',CURRENT_TIMESTAMP)
            ON CONFLICT(job_id,ordinal) DO UPDATE SET state='verified',verified_at=CURRENT_TIMESTAMP`, [id, ordinal]);
          return (await client.query(`UPDATE magento_sync_jobs SET remote_product_id=COALESCE(remote_product_id,$2),
            updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id, observation.raw.id])).rows[0];
        });
      }
      observation = await refresh(config, observation, options);
      plan.verifyAll(job, observation);
      return await saveState('succeeded');
    } catch (cause) {
      const pending = (await options.databasePool.query("SELECT 1 FROM magento_sync_steps WHERE job_id=$1 AND state='dispatched'", [id])).rowCount > 0;
      const code = /^(MAGENTO|ADMIN|EXPORT)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_SYNC_FAILED';
      const status = pending ? 'uncertain' : /CHANGED|MISMATCH|INTEGRITY|NOT_SENDABLE|UNRESOLVED/.test(code) ? 'blocked' : 'retryable';
      return saveState(status, { code, ordinal: activeOrdinal,
        operation: activeOrdinal === null ? null : job.intent.operations[activeOrdinal].domain, reconciliationOnly: pending });
    }
  }, true).catch(async (cause) => {
    // These checks happen after actor authorization but before entering the worker.
    if (job.state !== 'succeeded' && ['MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED', 'MAGENTO_SYNC_INSTALLATION_MISMATCH'].includes(cause.code)) {
      return saveState('blocked', { code: cause.code, reconciliationOnly: true });
    }
    throw cause;
  });
}
module.exports = { enqueue, applyJob };
