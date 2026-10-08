const { randomUUID } = require('node:crypto');
const c = require('./binding-contract');
const plan = require('./sync-job-plan');
const { previewProduct } = require('./sync-preview');
const { createMagentoClient } = require('./client');
const { readDomains } = require('./sync-preview-domains');
const { evaluate } = require('./binding-evidence-products');
const { dispatch } = require('./sync-write-client');
const { assertEvidenceSafe } = require('./binding-evidence-audit');
const { writeAuditEvent } = require('../../audit/audit-events');
const gate = require('../full-product-cutover-gate');
const automatic = require('./automatic-sync-boundary');
const { resolveProductLookup } = require('../product/public-identity');
const { measurePhase } = require('./sync-performance');
const transaction = require('./sync-job-transaction');
const local = require('./sync-local-diagnostics');
const historical = require('./historical-update-boundary');
const standardHistorical = require('./historical-standard-boundary');

async function ledger(db, actorUserId, action, operation) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const job = await operation(client);
    if (action === 'succeeded') await require('./name-state').confirmJobNames(client, job);
    await local.phase('job_audit', () => writeAuditEvent(client, { mutationContext: { actorUserId, requestId: `magento-sync-${randomUUID()}` },
      eventKey: `magento_sync.${action}`, subjectType: 'magento_sync_job', subjectId: job.id,
      details: { state: job.state, planHash: job.plan_hash } }));
    await gate.commit(client); return job;
  } catch (e) { await gate.rollback(client).catch(() => {}); throw e; }
  finally { await gate.release(client).catch(() => {}); client.release(); }
}
async function guard(config, input, options, operation, applying = false) {
  c.identity(input.bindingRevisionId);
  if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) plan.fail('MAGENTO_SYNC_ACTOR_REQUIRED');
  if (typeof input.sku !== 'string' || !input.sku.trim() || input.sku.length > 256) plan.fail('MAGENTO_SYNC_SKU_REQUIRED');
  const db = options.databasePool; const client = await db.connect();
  let canonicalSku; let lock; let held = false; let transactionOpen = false;
  try {
    const initiallyResolved = await resolveProductLookup(client, input.sku);
    if (!initiallyResolved.product || initiallyResolved.internalMatchCount > 1) plan.fail('MAGENTO_SYNC_PRODUCT_NOT_UNIQUE');
    canonicalSku = initiallyResolved.product.public_sku;
    lock = `amber_magento_sync:${c.originHash(config.baseUrl)}:${canonicalSku}`;
    if (applying) {
      held = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held;
      if (!held) plan.fail('MAGENTO_SYNC_BUSY');
    } else { await client.query('SELECT pg_advisory_lock(hashtext($1))', [lock]); held = true; }
    await client.query('BEGIN'); transactionOpen = true;
    const state = await transaction.readState(client, config, input, options, canonicalSku);
    // Retain the SKU session lane, but release authority/publication/product
    // transaction locks before every remote read or write. Manual mutations
    // revalidate under short transactions immediately before committing evidence.
    await gate.commit(client); transactionOpen = false;
    return await operation(state);
  } catch (e) {
    local.log(e, options);
    if (transactionOpen) await gate.rollback(client).catch(() => {});
    throw e;
  }
  finally {
    await gate.release(client).catch(() => {});
    if (held) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]).catch(() => {});
    client.release();
  }
}
async function observe(config, input, options) {
  return measurePhase(options, 'observation', async (fetchImpl) => {
  let observation;
  let standardProof = null;
  if (await standardHistorical.present(options.databasePool)) standardProof = (await options.databasePool.query(
    `SELECT * FROM historical_standard_intents WHERE public_sku=$1 AND origin_hash=$2 AND state IN ('queued','delivering','blocked') ORDER BY created_at DESC LIMIT 1`,
    [input.sku,c.originHash(config.baseUrl)])).rows[0];
  // Automatic work retains the complete fresh schema contract, while independent
  // set/option GETs use one bounded four-read observation budget. No cache spans
  // enqueue, APPLY, jobs, products or publications.
  const discover = options.automatic ? (config, reads) => measurePhase({ ...options, fetchImpl: reads.fetchImpl }, 'schema_discovery', (read) =>
    require('./schema-audit').auditMagentoSchema(config, { ...reads, fetchImpl: read, concurrency: 4 })) : undefined;
  const report = await (options.preview || previewProduct)(config, { databasePool: options.databasePool,
    fetchImpl, sku: input.sku, bindingRevisionId: input.bindingRevisionId,
    ...(discover ? { discover } : {}),
    ...(standardProof ? { readAmber:standardHistorical.readProspective } : {}),
    sensitiveValues: options.sensitiveValues || [],
    onObservation: (value) => { observation = value; } });
  if (!observation) plan.fail('MAGENTO_SYNC_OBSERVATION_REQUIRED');
  return { observation, report };
  });
}
async function refresh(config, observation, options, phase = 'precondition_read') {
  return measurePhase(options, phase, async (fetchImpl) => {
  if (options.refresh) return options.refresh(observation);
  const client = createMagentoClient(config, { fetchImpl });
  const sku = observation.amber.product.public_sku || observation.amber.product.full_sku; let raw = null;
  try { raw = await client.findProductBySku(sku); }
  catch (e) { if (e.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw e; }
  const domainEvidence = await readDomains(config, { client, schema: observation.schema, sku, raw,
    expected: evaluate(observation.amber, observation.amber.product), fetchImpl });
  if (domainEvidence.failures.length) plan.fail('MAGENTO_SYNC_READ_FAILED');
  return { ...observation, raw, domainEvidence };
  });
}
async function enqueue(config, input, options) {
  options = { ...options, telemetryStage: 'enqueue' };
  return guard(config, input, options, async (state) => {
    const existing = (await options.databasePool.query(`SELECT * FROM magento_sync_jobs WHERE origin_hash=$1 AND sku=$2
      AND state <> 'superseded' AND (state <> 'succeeded' OR (binding_revision_id=$3 AND amber_hash=$4
        AND ($5::bigint IS NULL OR automatic_generation=$5::bigint))) ORDER BY created_at DESC LIMIT 1`,
    [state.revision.originHash, state.publicSku, input.bindingRevisionId, state.amberHash, options.automatic?.generation || null])).rows[0];
    if (existing) {
      if (existing.amber_hash !== state.amberHash) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
      if (existing.binding_hash !== state.bindingHash) plan.fail('MAGENTO_SYNC_BINDING_CHANGED');
      if (options.automatic) await ledger(options.databasePool, options.actorUserId, 'attached', async (client) => {
        await automatic.assertSnapshot(client, state, options);
        await automatic.attachJob(client, existing, options); return existing;
      });
      return existing; // Idempotent even after the successful plan changes the remote diff.
    }
    const externalInput = { ...input, sku: state.publicSku };
    const { observation, report } = await observe(config, externalInput, options);
    if (options.automatic && Object.hasOwn(observation.amber, 'nameState')) {
      const nameResult = await require('./name-state').reconcileObservation(config, observation, options);
      if (nameResult.action === 'accept_external') plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
    }
    if (options.automatic) await require('./sync-problems').saveDiagnostics(options.databasePool,
      options.automatic, report.blockers);
    if (options.automatic && (observation.categoryFailures?.length || observation.domainEvidence.failures?.length)) {
      plan.fail('MAGENTO_SYNC_READ_FAILED');
    }
    const intent = plan.intent(report); const baseline = plan.baseline(observation, report);
    historical.assertPlan(state.historicalUpdate, intent, observation);
    standardHistorical.assertPlan(state.historicalStandard, intent, observation);
    if (state.historicalUpdate) await require('./historical-update-transport').capability(config, options);
    assertEvidenceSafe({ intent, baseline }, config, options.sensitiveValues || []);
    return ledger(options.databasePool, options.actorUserId, 'enqueued', async (client) => {
      if (options.automatic) await automatic.assertSnapshot(client, state, options);
      else await transaction.revalidate(client, config, state, options);
      const job = (await client.query(`
      INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,binding_revision_id,
        binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,automatic_generation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14) RETURNING *`,
    [randomUUID(), state.productId, state.publicIdentityId, state.publicSku, state.revision.installationKey, state.revision.originHash,
      input.bindingRevisionId, state.bindingHash, state.amberHash, c.hash(intent), JSON.stringify(intent),
      JSON.stringify(baseline), options.actorUserId, options.automatic?.generation || null])).rows[0];
      if (options.automatic) await automatic.attachJob(client, job, options);
      return job;
    });
  });
}
async function applyJob(config, id, options) {
  options = { ...options, telemetryStage: 'apply' };
  if (options.apply !== true) plan.fail('MAGENTO_SYNC_APPLY_REQUIRED');
  c.identity(id);
  let job = (await options.databasePool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
  let guardedState;
  if (!job) plan.fail('MAGENTO_SYNC_JOB_NOT_FOUND');
  const input = { sku: job.sku, bindingRevisionId: job.binding_revision_id };
  const saveState = (state, failure = null) => ledger(options.databasePool, options.actorUserId, state, async (client) => {
    if (guardedState && !options.automatic && ['running','succeeded'].includes(state)) {
      await transaction.revalidate(client, config, guardedState, options);
    }
    const result = (await local.phase('job_state', () => client.query(`UPDATE magento_sync_jobs SET state=$2, failure=$3::jsonb, updated_at=CURRENT_TIMESTAMP,
      attempts=attempts+CASE WHEN $2='running' THEN 1 ELSE 0 END,
      acknowledged_at=CASE WHEN $2='succeeded' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=$1 RETURNING *`,
    [id, state, JSON.stringify(failure)]))).rows[0];
    if (state === 'running' && options.recoveryReview) await writeAuditEvent(client, {
      mutationContext: { actorUserId: options.actorUserId, requestId: options.mutationContext?.requestId },
      eventKey: 'magento_sync.recovery_continued', subjectType: 'magento_sync_recovery', subjectId: c.hash(options.recoveryReview),
      details: { jobId: id, reviewHash: c.hash(options.recoveryReview), reason: options.recoveryReason } });
    return result;
  });
  return guard(config, input, options, async (state) => {
    guardedState = state;
    job = (await options.databasePool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
    if (job.state === 'succeeded') return job;
    if (job.state === 'superseded') plan.fail('MAGENTO_SYNC_JOB_SUPERSEDED');
    if (options.recoveryReview) {
      const steps = (await options.databasePool.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [id])).rows;
      require('./sync-job-recovery').assertReviewedJob(job, steps, options.recoveryReview);
    }
    if (options.automatic && (job.state === 'uncertain' || (await options.databasePool.query(
      "SELECT 1 FROM magento_sync_steps WHERE job_id=$1 AND state='dispatched'", [id])).rowCount)) {
      plan.fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
    }
    let activeOrdinal = null;
    try {
      if (job.amber_hash !== state.amberHash || job.product_id !== state.productId) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
      if (job.binding_hash !== state.bindingHash) plan.fail('MAGENTO_SYNC_BINDING_CHANGED');
      if (c.hash(job.intent) !== job.plan_hash) plan.fail('MAGENTO_SYNC_PLAN_INTEGRITY');
      let reviewedObservation;
      if (options.recoveryReview) {
        reviewedObservation = (await observe(config, input, options)).observation;
        require('./sync-job-recovery').assertReviewedRemote(reviewedObservation, options.recoveryReview);
      }
      job = await saveState('running');
      let observation = reviewedObservation || (await observe(config, input, options)).observation;
      historical.assertPlan(state.historicalUpdate, job.intent, observation);
      const standardProgress = state.historicalStandard && (await options.databasePool.query('SELECT 1 FROM magento_sync_steps WHERE job_id=$1 LIMIT 1',[job.id])).rowCount>0;
      standardHistorical.assertPlan(state.historicalStandard,job.intent,observation,standardProgress);
      if (state.historicalUpdate) await require('./historical-update-transport').capability(config, options);
      if (options.automatic) {
        // Reject a mixed snapshot if a save committed during remote discovery.
        await ledger(options.databasePool, options.actorUserId, 'revalidated', async (client) => {
          await automatic.assertSnapshot(client, state, options); return job;
        });
      }
      plan.replan(job, observation);
      if (observation.domainEvidence.failures?.length) plan.fail('MAGENTO_SYNC_READ_FAILED');
      plan.preflight(job, observation);
      for (let ordinal = 0; ordinal < job.intent.operations.length; ordinal++) {
        activeOrdinal = ordinal;
        const operation = job.intent.operations[ordinal];
        observation = await refresh(config, observation, options);
        historical.assertObservation(state.historicalUpdate, observation);
        standardHistorical.assertIdentity(state.historicalStandard,observation,job);
        plan.preserve(job, observation);
        const step = (await options.databasePool.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 AND ordinal=$2', [id, ordinal])).rows[0];
        if (state.historicalStandard && ordinal===0 && !step) standardHistorical.assertOriginalObservation(state.historicalStandard,observation);
        if (!step && ordinal === 0 && job.intent.mode === 'create' && observation.raw) plan.fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
        if (!plan.matches(operation, observation)) {
          if (step) plan.fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
          plan.precondition(job, operation, observation);
          // Committed before HTTP. There is deliberately no path that resets this marker.
          await ledger(options.databasePool, options.actorUserId, 'dispatched', async (client) => {
            if (!options.automatic) await transaction.revalidate(client, config, state, options);
            await historical.assertLocal(client, config, state.historicalUpdate, state);
            await standardHistorical.assertLocal(client,config,state.historicalStandard,state,options.actorUserId);
            if (options.automatic) {
              await automatic.assertEnabled(client, options);
              await local.phase('binding_lock', () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${job.installation_key}`]));
              const current = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
                AND state='published' ORDER BY version_number DESC LIMIT 1`, [job.installation_key])).rows[0];
              if (current?.id !== job.binding_revision_id) plan.fail('MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED');
            }
            await local.phase('dispatch_marker', () => client.query("INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at) VALUES($1,$2,'dispatched',CURRENT_TIMESTAMP)", [id, ordinal]));
            return job;
          });
          let uncertain = false;
          try { await measurePhase(options, 'dispatch', (fetchImpl) =>
            state.historicalUpdate
              ? require('./historical-update-transport').dispatchExisting(config, state.historicalUpdate, operation,
                { apply: true, fetchImpl, jobId: job.id, dispatchOther: options.dispatch || dispatch })
              : (options.dispatch || dispatch)(config, operation, { apply: true, fetchImpl })); }
          catch { uncertain = true; }
          observation = await refresh(config, observation, options, 'step_readback');
          historical.assertObservation(state.historicalUpdate, observation);
          standardHistorical.assertIdentity(state.historicalStandard,observation,job);
          plan.preserve(job, observation);
          if (!plan.verifyStep(operation, observation)) plan.fail(uncertain ? 'MAGENTO_SYNC_MUTATION_UNCERTAIN' : 'MAGENTO_SYNC_VERIFICATION_MISMATCH');
        }
        if (step?.state !== 'verified' && !plan.verifyStep(operation, observation)) plan.fail('MAGENTO_SYNC_VERIFICATION_MISMATCH');
        if (step?.state !== 'verified') job = await ledger(options.databasePool, options.actorUserId, 'verified', async (client) => {
          await client.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,verified_at) VALUES($1,$2,'verified',CURRENT_TIMESTAMP)
            ON CONFLICT(job_id,ordinal) DO UPDATE SET state='verified',verified_at=CURRENT_TIMESTAMP`, [id, ordinal]);
          return (await client.query(`UPDATE magento_sync_jobs SET remote_product_id=COALESCE(remote_product_id,$2),
            updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id, observation.raw.id])).rows[0];
        });
      }
      observation = await refresh(config, observation, options, 'final_readback');
      historical.assertObservation(state.historicalUpdate, observation);
      standardHistorical.assertIdentity(state.historicalStandard,observation,job);
      plan.verifyAll(job, observation);
      return await saveState('succeeded');
    } catch (cause) {
      local.log(cause, options, { jobId: id });
      const pending = (await options.databasePool.query("SELECT 1 FROM magento_sync_steps WHERE job_id=$1 AND state='dispatched'", [id])).rowCount > 0;
      const code = /^(MAGENTO|ADMIN|EXPORT|HISTORICAL)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_SYNC_FAILED';
      const status = pending ? 'uncertain' : code === 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'
        || /CHANGED|MISMATCH|INTEGRITY|NOT_SENDABLE|UNRESOLVED/.test(code) ? 'blocked' : 'retryable';
      return saveState(status, { code, ordinal: activeOrdinal,
        operation: activeOrdinal === null ? null : job.intent.operations[activeOrdinal].domain, reconciliationOnly: pending,
        ...(local.diagnostic(cause) ? { sqlState: local.diagnostic(cause).sqlState, phase: local.diagnostic(cause).phase } : {}) });
    }
  }, true).catch(async (cause) => {
    // These checks happen after actor authorization but before entering the worker.
    if (job.state !== 'succeeded' && ['MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED', 'MAGENTO_SYNC_INSTALLATION_MISMATCH'].includes(cause.code)) {
      return saveState('blocked', { code: cause.code, reconciliationOnly: true });
    }
    throw cause;
  });
}
async function supersedeUndispatched(config, id, options) {
  const client = await options.databasePool.connect();
  let lock;
  try {
    const job = (await client.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [id])).rows[0];
    if (!job) plan.fail('MAGENTO_SYNC_JOB_NOT_FOUND');
    if (job.origin_hash !== c.originHash(config.baseUrl)
      || String(job.public_product_identity_id) !== String(options.automatic?.publicIdentityId)
      || job.installation_key !== options.automatic?.installationKey) plan.fail('MAGENTO_SYNC_INSTALLATION_MISMATCH');
    lock = `amber_magento_sync:${c.originHash(config.baseUrl)}:${job.sku}`;
    if (!(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held) {
      lock = null; plan.fail('MAGENTO_SYNC_BUSY');
    }
    return await ledger(options.databasePool, options.actorUserId, 'superseded', async (db) => {
      await automatic.assertEnabled(db, options);
      const result = await db.query(`UPDATE magento_sync_jobs SET state='superseded',updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND automatic_generation IS NOT NULL AND state IN ('queued','running','retryable','blocked')
        AND NOT EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=$1) RETURNING *`, [id]);
      if (!result.rowCount) plan.fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
      return result.rows[0];
    });
  } finally {
    if (lock) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]).catch(() => {});
    client.release();
  }
}
module.exports = { enqueue, applyJob, supersedeUndispatched,
  recoveryBoundary: { guard, observe, ledger, revalidate: transaction.revalidate } };
