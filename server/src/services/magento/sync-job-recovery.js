const c = require('./binding-contract');
const plan = require('./sync-job-plan');
const jobs = require('./sync-job.service');
const { boundedGet } = require('./integration-readiness');
const { writeAuditEvent } = require('../../audit/audit-events');
const { assertActorStillAuthorized } = require('../access-admin-transaction');
const pool = require('../../db/pool');

const FORMAT = 'magento-job-recovery-v1';
const fail = (code = 'MAGENTO_RECOVERY_REVIEW_STALE') => { throw c.error(409, code, 'Повторіть перевірку початкової операції Magento.'); };
const fingerprint = (job, steps) => c.hash(plan.clean({ job, steps }));
const remoteFingerprint = (observation) => c.hash(plan.clean({ raw: observation.raw,
  domainEvidence: observation.domainEvidence, schema: observation.schema,
  categoryNodes: observation.categoryNodes, categoryFailures: observation.categoryFailures || [] }));
const optionsFor = (options) => ({ ...options, databasePool: options.databasePool || pool,
  actorUserId: Number(options.actorUserId || options.mutationContext?.actorUserId) });
function summary(job, steps) {
  return plan.clean({ id: job.id, productId: job.product_id, article: job.sku, state: job.state,
    mode: job.intent.mode, bindingRevisionId: job.binding_revision_id, planHash: job.plan_hash,
    failure: job.failure, acknowledgedAt: job.acknowledged_at,
    steps: job.intent.operations.map((op, ordinal) => ({ ordinal, domain: op.domain,
      state: steps.find((s) => s.ordinal === ordinal)?.state || 'not_sent' })) });
}
async function readJob(id, options = {}) {
  c.identity(id); const db = options.databasePool || pool;
  const job = (await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
  if (!job) throw c.error(404, 'MAGENTO_SYNC_JOB_NOT_FOUND', 'Початкову операцію не знайдено.');
  const steps = (await db.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [id])).rows;
  return { job, steps };
}
async function get(config, id, options = {}) {
  const { job, steps } = await readJob(id, options);
  if (!config.configured || job.origin_hash !== c.originHash(config.baseUrl)) fail('MAGENTO_SYNC_INSTALLATION_MISMATCH');
  return summary(job, steps);
}
function assertReviewedJob(job, steps, review) {
  if (review.jobId !== job.id || review.planHash !== job.plan_hash || review.jobFingerprint !== fingerprint(job, steps)) fail();
  if (steps.some((s) => s.state === 'dispatched')) fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
}
function assertReviewedRemote(observation, review) {
  if (remoteFingerprint(observation) !== review.remoteFingerprint) fail();
}
function validate(input, id) {
  c.command(input, ['review', 'reviewHash', 'reason']); c.identity(id);
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 2000) c.invalid();
  c.safeData(input.review);
  c.command(input.review, ['format', 'jobId', 'planHash', 'jobFingerprint', 'remoteFingerprint', 'steps', 'complete', 'blockers']);
  if (!Array.isArray(input.review.steps) || !Array.isArray(input.review.blockers) || typeof input.review.complete !== 'boolean') c.invalid();
  if (input.review?.format !== FORMAT || input.review.jobId !== id || c.hash(input.review) !== input.reviewHash) fail();
}
async function inspectInside(config, job, steps, state, options) {
  const blockers = [];
  let observation = null;
  try {
    if (job.state === 'superseded') fail('MAGENTO_SYNC_JOB_SUPERSEDED');
    if (job.amber_hash !== state.amberHash || job.product_id !== state.productId) fail('MAGENTO_SYNC_AMBER_CHANGED');
    if (job.binding_hash !== state.bindingHash) fail('MAGENTO_SYNC_BINDING_CHANGED');
    if (c.hash(job.intent) !== job.plan_hash) fail('MAGENTO_SYNC_PLAN_INTEGRITY');
    ({ observation } = await jobs.recoveryBoundary.observe(config, { sku: job.sku, bindingRevisionId: job.binding_revision_id },
      { ...options, fetchImpl: boundedGet(options.fetchImpl) }));
    if (job.intent.mode === 'create' && !steps.some((s) => s.ordinal === 0) && observation.raw) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
    plan.replan(job, observation); plan.preflight(job, observation);
    if (observation.domainEvidence.failures?.length) fail('MAGENTO_SYNC_READ_FAILED');
  } catch (cause) {
    blockers.push({ code: /^(MAGENTO|ADMIN|EXPORT)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_SYNC_READ_FAILED' });
  }
  const checked = job.intent.operations.map((op, ordinal) => {
    const step = steps.find((s) => s.ordinal === ordinal);
    const matches = !!observation && !blockers.length && (step?.state === 'dispatched'
      ? plan.verifyStep(op, observation) : plan.matches(op, observation));
    return { ordinal, domain: op.domain, state: step?.state || 'not_sent', matches };
  });
  if (checked.some((s) => s.state === 'dispatched' && !s.matches)) blockers.push({ code: 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' });
  if (checked.some((s) => s.state === 'verified' && !s.matches) && !blockers.length) blockers.push({ code: 'MAGENTO_SYNC_VERIFIED_RESULT_CHANGED' });
  let complete = false;
  if (observation && !blockers.length) {
    try { plan.verifyAll(job, observation); complete = true; } catch { /* A reviewed continuation may still be required. */ }
  }
  const pending = checked.filter((s) => s.state === 'dispatched');
  const unsentChanges = blockers.length ? [] : require('./sync-recovery-changes').unsentChanges(job, checked, observation);
  const review = { format: FORMAT, jobId: job.id, planHash: job.plan_hash,
    jobFingerprint: fingerprint(job, steps), remoteFingerprint: observation ? remoteFingerprint(observation) : null,
    steps: checked, complete, blockers };
  return { job: summary(job, steps), review, reviewHash: c.hash(review), steps: checked, blockers,
    canReconcile: job.state !== 'succeeded' && !blockers.length && (pending.length > 0 || complete),
    canContinue: job.state !== 'succeeded' && !blockers.length && pending.length === 0 && !complete
      && checked.some((s) => s.state === 'not_sent' && !s.matches),
    unsentChanges, remainingCount: checked.filter((s) => s.state === 'not_sent' && !s.matches).length,
    observedAt: new Date().toISOString(), observation };
}
async function inspect(config, id, options = {}) {
  options = optionsFor(options); const { job } = await readJob(id, options);
  return jobs.recoveryBoundary.guard(config, { sku: job.sku, bindingRevisionId: job.binding_revision_id },
    { ...options, recoveryInspectionOnly: true }, async (state) => {
    const fresh = await readJob(id, options);
    const result = await inspectInside(config, fresh.job, fresh.steps, state, options);
    delete result.observation;
    return result;
  }, true);
}
async function reconcile(config, id, input, options = {}) {
  validate(input, id); options = optionsFor(options); const { job } = await readJob(id, options);
  return jobs.recoveryBoundary.guard(config, { sku: job.sku, bindingRevisionId: job.binding_revision_id }, options, async (state) => {
    const previous = (await options.databasePool.query(`SELECT details FROM audit_events
      WHERE event_key='magento_sync.recovery_reconciled' AND subject_id=$1`, [input.reviewHash])).rows[0];
    if (previous) return { ...previous.details.result, alreadyApplied: true };
    const fresh = await readJob(id, options);
    const checked = await inspectInside(config, fresh.job, fresh.steps, state, options);
    if (checked.reviewHash !== input.reviewHash || !checked.canReconcile) fail();
    // Only already-observed results are recorded. This function has no dispatch path.
    const result = await jobs.recoveryBoundary.ledger(options.databasePool, options.actorUserId,
      checked.review.complete ? 'succeeded' : 'recovery_verified', async (client) => {
        await assertActorStillAuthorized(client, options.actorUserId, 'export_templates.publish', c.error);
        for (const item of checked.steps) {
          if (item.state === 'verified' || (!checked.review.complete && item.state !== 'dispatched')) continue;
          await client.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,verified_at) VALUES($1,$2,'verified',CURRENT_TIMESTAMP)
            ON CONFLICT(job_id,ordinal) DO UPDATE SET state='verified',verified_at=CURRENT_TIMESTAMP`, [id, item.ordinal]);
        }
        const updated = (await client.query(`UPDATE magento_sync_jobs SET state=$2,remote_product_id=COALESCE(remote_product_id,$3),
          failure=$4::jsonb,updated_at=CURRENT_TIMESTAMP,acknowledged_at=CASE WHEN $2='succeeded' THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE id=$1 RETURNING *`, [id, checked.review.complete ? 'succeeded' : 'uncertain', checked.observation.raw.id,
          checked.review.complete ? null : JSON.stringify({ code: 'MAGENTO_SYNC_REVIEWED_CONTINUATION_REQUIRED', reconciliationOnly: true })])).rows[0];
        const steps = (await client.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [id])).rows;
        const result = { job: summary(updated, steps), remoteWrites: 0, reviewHash: input.reviewHash };
        await writeAuditEvent(client, { mutationContext: { actorUserId: options.actorUserId, requestId: options.mutationContext?.requestId },
          eventKey: 'magento_sync.recovery_reconciled', subjectType: 'magento_sync_recovery', subjectId: input.reviewHash,
          details: { jobId: id, reason: input.reason.trim(), result } });
        return updated;
      });
    return { job: await get(config, result.id, options), remoteWrites: 0, reviewHash: input.reviewHash, alreadyApplied: false };
  }, true);
}
async function continueJob(config, id, input, options = {}) {
  validate(input, id); options = optionsFor(options);
  if (input.review.blockers.length || input.review.complete || input.review.steps.some((s) => s.state === 'dispatched')) fail();
  // applyJob owns the SKU lock, current publication, actor and product checks. The
  // reviewed local/remote fingerprints are checked there before the first dispatch.
  const job = await jobs.applyJob(config, id, { ...options, apply: true, recoveryReview: input.review, recoveryReason: input.reason.trim() });
  return { job: await get(config, job.id, options), reviewHash: input.reviewHash };
}
module.exports = { FORMAT, summary, get, inspect, reconcile, continueJob,
  assertReviewedJob, assertReviewedRemote, fingerprint, remoteFingerprint };
