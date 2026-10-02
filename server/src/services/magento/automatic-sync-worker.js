const jobs = require('./sync-job.service');
const { originHash } = require('./binding-contract');

const transient = (code) => ['MAGENTO_NETWORK_ERROR', 'MAGENTO_TIMEOUT', 'MAGENTO_HTTP_ERROR',
  'MAGENTO_SYNC_READ_FAILED', 'MAGENTO_SYNC_CATEGORY_READ_FAILED', 'MAGENTO_SYNC_BUSY',
  'MAGENTO_SYNC_AMBER_CHANGED', 'MAGENTO_AUTO_DISABLED', '40001', '40P01', '08003', '08006',
  '57P01', '53300', 'ECONNRESET', 'ECONNREFUSED'].includes(code);
const stale = (code) => ['MAGENTO_SYNC_AMBER_CHANGED', 'MAGENTO_SYNC_BINDING_CHANGED',
  'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'].includes(code);

// One lane per process; session locks also serialize replicas. No product/request
// row lock spans HTTP. This pool must be separate from the request-serving pool.
function createAutomaticSyncWorker(config, { databasePool: db, jobOptions = {}, logger = { error() {} }, intervalMs = 5000 } = {}) {
  let stopping = false; let timer; let active;
  async function runProduct(publicIdentityId) {
    const client = await db.connect(); let held = false; let request;
    const update = (sql, values = []) => db.query(`UPDATE magento_product_sync_requests SET ${sql},updated_at=CURRENT_TIMESTAMP
      WHERE public_product_identity_id=$1`, [publicIdentityId, ...values]);
    const attention = (reason) => update(`state=CASE WHEN desired_generation=$3::bigint OR $2='reconciliation_required'
      THEN 'needs_attention' ELSE 'pending' END,
      reason_code=CASE WHEN desired_generation=$3::bigint OR $2='reconciliation_required' THEN $2 ELSE NULL END`,
    [reason, request.desired_generation]);
    const retry = () => update(`state='pending',reason_code=NULL,attempts=attempts+1,
      next_attempt_at=CURRENT_TIMESTAMP + (LEAST(300,5*power(2,LEAST(attempts,6))) * interval '1 second')`);
    try {
      held = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held',
        [`amber_magento_public_identity:${publicIdentityId}`])).rows[0].held;
      if (!held || stopping) return;
      if ((await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1', [publicIdentityId])).rowCount) return;
      const gate = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
      if (!gate?.enabled) return;
      request = (await client.query(`SELECT * FROM magento_product_sync_requests
        WHERE public_product_identity_id=$1`, [publicIdentityId])).rows[0];
      if (!request || request.state === 'synced') return;
      if (!config.configured) { await attention('configuration'); return; }
      const options = { ...jobOptions, databasePool: db, actorUserId: Number(gate.actor_user_id), apply: true,
        automatic: { publicIdentityId, productId: Number(request.product_id), generation: request.desired_generation,
          installationKey: gate.installation_key } };
      const published = (await client.query(`SELECT id,origin_hash FROM magento_binding_revisions WHERE installation_key=$1
        AND state='published' ORDER BY version_number DESC LIMIT 1`, [gate.installation_key])).rows[0];
      if (!published || published.origin_hash !== originHash(config.baseUrl)) { await attention('data_or_binding'); return; }
      const product = (await client.query(`SELECT p.full_sku,p.status,p.corrected_to_product_id,i.public_sku
        FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`,
      [request.product_id])).rows[0];
      let job = request.active_job_id
        ? (await client.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [request.active_job_id])).rows[0]
        : (await client.query(`SELECT * FROM magento_sync_jobs WHERE origin_hash=$1 AND sku=$2
          AND state NOT IN ('succeeded','superseded')`, [published.origin_hash, product.public_sku])).rows[0];
      if (job?.state === 'succeeded' && request.active_job_id) {
        // This also recovers a process death between job acknowledgement and request completion.
        await update(`synced_generation=GREATEST(synced_generation,$2::bigint),active_job_id=NULL,active_generation=NULL,
          state=CASE WHEN desired_generation=$2::bigint THEN 'synced' ELSE 'pending' END,
          reason_code=NULL,attempts=0,next_attempt_at=CURRENT_TIMESTAMP`, [request.active_generation]);
        return;
      }
      if (job) {
        const steps = (await client.query('SELECT state FROM magento_sync_steps WHERE job_id=$1', [job.id])).rows;
        if (job.state === 'uncertain' || steps.some((s) => s.state === 'dispatched') || !job.automatic_generation) {
          await attention('reconciliation_required'); return;
        }
        const obsolete = job.automatic_generation !== request.desired_generation || job.binding_revision_id !== published.id
          || stale(job.failure?.code);
        if (job.state === 'superseded' || (obsolete && steps.length === 0)) {
          if (job.state !== 'superseded') await jobs.supersedeUndispatched(config, job.id, options);
          await update("active_job_id=NULL,active_generation=NULL,state='pending',reason_code=NULL,next_attempt_at=CURRENT_TIMESTAMP");
          job = null;
        } else if (job.state === 'blocked' || obsolete) { await attention('data_or_binding'); return; }
      }
      if (product.status !== 'active' || product.corrected_to_product_id !== null) { await attention('product_retired'); return; }
      if (!job) {
        job = await jobs.enqueue(config, { sku: product.public_sku, bindingRevisionId: published.id }, options);
      }
      // Atomic enqueue/attachment prevents orphan jobs. Manual unfinished jobs
      // encountered above remain explicit operator work, never adopted for APPLY.
      await update("state='syncing',reason_code=NULL");
      job = await jobs.applyJob(config, job.id, options);
      if (job.state === 'succeeded') {
        const generation = job.id === request.active_job_id ? request.active_generation : request.desired_generation;
        await update(`synced_generation=GREATEST(synced_generation,$2::bigint),active_job_id=NULL,active_generation=NULL,
          state=CASE WHEN desired_generation=$2::bigint THEN 'synced' ELSE 'pending' END,
          reason_code=NULL,attempts=0,next_attempt_at=CURRENT_TIMESTAMP`, [generation]);
      } else if (job.state === 'uncertain') await attention('reconciliation_required');
      else if (stale(job.failure?.code) || (job.state === 'retryable' && transient(job.failure?.code))) await retry();
      else await attention('data_or_binding');
    } catch (error) {
      // A lost DB acknowledgement of dispatch must be resolved from the ledger
      // on the next pass; no catch path issues HTTP or resets a dispatch marker.
      if (request) {
        if (transient(error.code)) await retry();
        else await attention(error.code === 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' ? 'reconciliation_required'
          : error.code === 'ADMIN_PERMISSION_REVOKED' ? 'authorization'
          : error.code?.startsWith('MAGENTO_AUTO_') ? 'configuration'
            : error.code?.startsWith('MAGENTO_') ? 'data_or_binding' : 'unexpected_failure');
      }
    } finally {
      if (held) await client.query('SELECT pg_advisory_unlock(hashtext($1))',
        [`amber_magento_public_identity:${publicIdentityId}`]).catch(() => {});
      client.release();
    }
  }
  async function tick() {
    if (stopping) return;
    const gate = (await db.query('SELECT enabled FROM magento_auto_sync_activation WHERE singleton')).rows[0];
    if (!gate?.enabled) return;
    await require('./binding-handoff').processHandoffs(config,{databasePool:db});
    // needs_attention is not a retry queue. A later mutation can recheck local
    // blockers; unresolved dispatch remains sticky until trusted reconciliation.
    const rows = (await db.query(`SELECT public_product_identity_id FROM magento_product_sync_requests
      WHERE (state IN ('pending','syncing') AND next_attempt_at<=CURRENT_TIMESTAMP)
        OR (state='needs_attention' AND EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.id=active_job_id AND j.state='succeeded'))
      ORDER BY next_attempt_at,public_product_identity_id LIMIT 10`)).rows;
    for (const row of rows) { if (stopping) break; await runProduct(row.public_product_identity_id); }
  }
  function start() {
    if (timer || active || stopping) return;
    const loop = () => {
      timer = null;
      active = tick().catch(() => logger.error('magento.auto_sync.poll_failed', { code: 'LOCAL_WORKER_FAILURE' }))
        .finally(() => { active = null; if (!stopping) { timer = setTimeout(loop, intervalMs); timer.unref(); } });
    };
    timer = setTimeout(loop, intervalMs); timer.unref();
  }
  async function stop() { stopping = true; clearTimeout(timer); await active; }
  return { tick, runProduct, start, stop };
}
module.exports = { createAutomaticSyncWorker };
