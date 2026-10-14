'use strict';

// Exact local handoff only. The normal automatic worker owns jobs and Magento
// delivery. A session lane keeps that worker out of this SKU's local stages.
const path = require('node:path');
const { createRequire } = require('node:module');
const lanes = new WeakMap();
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
const reason = 'Reviewed SV campaign: canonical full product synchronization';
const globalCode = code => /AUTHORITY|PUBLICATION|PUBLISHED_CURRENT_BINDING|BINDING_CHANGED|BINDING_CONFLICT|INSTALLATION_MISMATCH|PERMISSION|ACTOR|ADMINISTRATOR|CUTOVER|LIFECYCLE_WRITER/.test(code || '');

function extendRuntime(serverRoot) {
  const local = createRequire(path.join(path.resolve(serverRoot), 'package.json'));
  return { controlled: local('./src/services/magento/binding-controlled-actions'),
    outboundPreview: local('./src/services/magento/sync-preview'),
    jobPlan: local('./src/services/magento/sync-job-plan'),
    nameProof: local('./src/services/magento/first-sync-name-proof') };
}
function validateItem(item) {
  if (!item || !Number.isSafeInteger(item.productId) || item.productId <= 0
    || typeof item.sku !== 'string' || !item.sku || item.sku.trim() !== item.sku
    || item.sku.length > 256 || /[\u0000-\u001f\u007f]/.test(item.sku)
    || item.category !== undefined && item.category !== 'SV') fail('SV_CAMPAIGN_OUTBOUND_ITEM_INVALID');
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null
      || typeof url === 'object' && url?.body != null)
      fail('SV_CAMPAIGN_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}
async function identity(client, item) {
  const rows = (await client.query(`SELECT p.id,p.category,p.status,p.exclude_from_export,p.corrected_to_product_id,
    i.id::text AS public_identity_id,i.public_sku FROM public_product_identities i JOIN products p
    ON p.public_product_identity_id=i.id WHERE i.public_sku=$1 AND p.status='active'
    AND p.corrected_to_product_id IS NULL ORDER BY p.id LIMIT 2`, [item.sku])).rows;
  if (rows.length !== 1 || rows[0].id !== item.productId || rows[0].category !== 'SV'
    || Number(rows[0].exclude_from_export) !== 0 || !counter(rows[0].public_identity_id)
    || item.publicIdentityId !== undefined && String(item.publicIdentityId) !== rows[0].public_identity_id)
    fail('SV_CAMPAIGN_OUTBOUND_IDENTITY_CHANGED');
  return rows[0];
}
async function work(client, publicIdentityId) {
  // Enrollment runs outside the public-identity lane. Read its pending side
  // first: a committed pending -> enrolled transition also creates the request
  // before the following SELECT. These reads do not fence new manual actions.
  const handoffs = (await client.query(`SELECT handoff_id,product_id,state FROM magento_binding_handoff_items
    WHERE public_product_identity_id=$1 AND state IN ('pending','protected')
    ORDER BY handoff_id,product_id LIMIT 2`, [publicIdentityId])).rows;
  const request = (await client.query(`SELECT public_product_identity_id::text,product_id,desired_generation::text,
    synced_generation::text,state,reason_code,active_job_id,active_generation::text
    FROM magento_product_sync_requests WHERE public_product_identity_id=$1`, [publicIdentityId])).rows[0] || null;
  const jobs = (await client.query(`SELECT j.id,j.state,j.automatic_generation::text,
    EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id) AS has_steps,
    EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id AND s.state='dispatched') AS dispatched
    FROM magento_sync_jobs j WHERE j.public_product_identity_id=$1
    AND j.state NOT IN ('succeeded','superseded') ORDER BY j.created_at,j.id LIMIT 2`, [publicIdentityId])).rows;
  return { request, jobs, handoffs };
}
function workReason(current, item) {
  if (current.handoffs.length) return 'SV_CAMPAIGN_OUTBOUND_EXISTING_HANDOFF';
  if (current.request && current.request.product_id !== item.productId) return 'SV_CAMPAIGN_OUTBOUND_REQUEST_CHANGED';
  if (current.jobs.length || current.request?.reason_code === 'reconciliation_required')
    return 'SV_CAMPAIGN_OUTBOUND_EXISTING_WORK';
  // A dangling attachment is not permission to replace or acknowledge a job.
  if (current.request?.active_job_id) return 'SV_CAMPAIGN_OUTBOUND_ATTACHED_WORK';
  return null;
}
async function acquireLane(runtime, config, item, run) {
  validateItem(item);
  const client = await run.databasePool.connect(); let held = false, released = false, key;
  const release = async () => {
    if (released) return; released = true;
    const lane = lanes.get(run); if (lane?.client === client) lanes.delete(run);
    try { if (held) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
    finally { client.release(); }
  };
  try {
    if (lanes.has(run)) fail('SV_CAMPAIGN_OUTBOUND_LANE_ALREADY_HELD');
    const before = await identity(client, item);
    key = 'amber_magento_public_identity:' + before.public_identity_id;
    held = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0]?.held === true;
    if (!held) { await release(); return { status: 'review', reason: 'SV_CAMPAIGN_OUTBOUND_BUSY', release }; }
    const after = await identity(client, item);
    if (after.public_identity_id !== before.public_identity_id) fail('SV_CAMPAIGN_OUTBOUND_IDENTITY_CHANGED');
    const blocked = workReason(await work(client, after.public_identity_id), item);
    if (blocked) { await release(); return { status: 'review', reason: blocked, release }; }
    lanes.set(run, { client, key, sku: item.sku, productId: item.productId,
      publicIdentityId: after.public_identity_id, originHash: runtime.c.originHash(config.baseUrl) });
    return { status: 'acquired', publicIdentityId: after.public_identity_id, release };
  } catch (cause) { await release(); throw cause; }
}
function laneFor(runtime, config, item, run) {
  const lane = lanes.get(run);
  if (!lane || lane.sku !== item.sku || lane.productId !== item.productId
    || lane.originHash !== runtime.c.originHash(config.baseUrl)) fail('SV_CAMPAIGN_OUTBOUND_LANE_REQUIRED');
  return lane;
}
async function freshReady(runtime, config, item, scope, run) {
  return runtime.boundary.guard(config, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId }, run, async () => {
    const { observation, report: original } = await runtime.boundary.observe(config,
      { sku: item.sku, bindingRevisionId: scope.bindingRevisionId }, run);
    const amber = observation.amber, product = amber.product, binding = amber.revision;
    if (product.id !== item.productId || product.public_sku !== item.sku || product.category !== 'SV'
      || observation.raw?.id !== item.remoteProductId || observation.raw?.sku !== item.sku)
      fail('SV_CAMPAIGN_OUTBOUND_SCOPE_CHANGED');
    if (binding.id !== scope.bindingRevisionId || binding.definitionHash !== scope.expectedDefinitionHash
      || amber.compiled.hash !== scope.expectedDefinitionHash || binding.installationKey !== scope.installationKey
      || binding.originHash !== runtime.c.originHash(config.baseUrl)
      || scope.publicationHash !== undefined && runtime.c.hash(binding) !== scope.publicationHash)
      fail('SV_CAMPAIGN_PUBLICATION_CHANGED');
    const client = await run.databasePool.connect();
    try {
      const history = await runtime.history.read(client, item.productId);
      if (!history.complete || history.hasRecount || history.identityChanged || history.issues.length
        || history.corrections.length || history.products.length !== 1 || history.products[0].productId !== item.productId)
        fail('SV_CAMPAIGN_OUTBOUND_LINEAGE_CHANGED');
    } finally { client.release(); }
    const base = await runtime.first.inspect(config, observation, run);
    if (base.first?.admissionGuards?.protectedWork !== false || base.first.admissionGuards.otherOrigin !== false
      || !['first', 'ordinary'].includes(base.mode) || base.readyForOutbound !== true || base.blockers?.length)
      fail('SV_CAMPAIGN_OUTBOUND_NOT_READY');
    if (base.prepared?.rows.some(row => !row.received && ['imported', 'name_received'].includes(row.record?.state)))
      fail('SV_CAMPAIGN_OUTBOUND_LOCAL_STAGE_REQUIRED');
    let report = original;
    if (base.mode === 'first') {
      // Only durable prior initial-name decisions can explain an empty remote
      // name. The unchanged canonical proof still validates both exact scopes.
      const pending = base.prepared.rows.filter(row => row.target === 'name' && row.record?.state === 'pending_outward_confirmation');
      const received = pending.every(row => base.first.progress?.fields.some(field => field.target === row.target
        && field.scope === row.scope && field.state === 'pending_outward_confirmation'));
      if (received) report = runtime.outboundPreview.applyFirstSyncNameProof(report, observation,
        runtime.nameProof.issue({ observation, prepared: base.prepared, projection: base.projection }));
    }
    const currencyEvidence = base.currencyEvidence || await runtime.price.readCurrencyEvidence(config, observation, { fetchImpl: run.fetchImpl });
    const intent = runtime.jobPlan.intent(report), baseline = runtime.jobPlan.baseline(observation, report);
    runtime.policy.assertIntent(config, { observation, report, intent, baseline, currencyEvidence });
    return { sourceHash: runtime.c.hash(runtime.batch.source(product)), bindingHash: runtime.c.hash(binding),
      publicIdentityId: String(product.public_product_identity_id), expectedRevision: binding.revision,
      planHash: runtime.c.hash(intent), lifecycleHash: runtime.c.hash(product.exportState) };
  });
}
async function unchanged(runtime, item, scope, run, ready) {
  const fresh = await runtime.readSnapshot(run.databasePool, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId });
  if (fresh.product.id !== item.productId || String(fresh.product.public_product_identity_id) !== ready.publicIdentityId
    || runtime.c.hash(runtime.batch.source(fresh.product)) !== ready.sourceHash
    || runtime.c.hash(fresh.product.exportState) !== ready.lifecycleHash) fail('SV_CAMPAIGN_OUTBOUND_SOURCE_CHANGED');
  if (runtime.c.hash(fresh.revision) !== ready.bindingHash) fail('SV_CAMPAIGN_PUBLICATION_CHANGED');
}
async function verifyReceipt(runtime, config, item, scope, record, run) {
  validateItem(item);
  const receipt = record?.receipt, prepared = record?.prepared;
  if (!receipt || !prepared || receipt.sku !== item.sku || receipt.productId !== item.productId
    || receipt.remoteProductId !== item.remoteProductId
    || receipt.originHash !== runtime.c.originHash(config.baseUrl) || receipt.bindingRevisionId !== scope.bindingRevisionId
    || receipt.actorUserId !== run.actorUserId || !counter(receipt.publicIdentityId)) fail('SV_CAMPAIGN_HANDOFF_RECEIPT_INVALID');
  if (receipt.kind === 'automatic_request') {
    if (!counter(receipt.generation) || !same(runtime, prepared, receipt)) fail('SV_CAMPAIGN_HANDOFF_RECEIPT_INVALID');
    const exact = await identity(run.databasePool, item);
    const current = await work(run.databasePool, receipt.publicIdentityId);
    if (exact.public_identity_id !== receipt.publicIdentityId || !current.request
      || current.request.product_id !== item.productId || BigInt(current.request.desired_generation) < BigInt(receipt.generation))
      fail('SV_CAMPAIGN_HANDOFF_RECEIPT_UNCONFIRMED');
    return true;
  }
  if (receipt.kind !== 'binding_handoff' || !prepared.command || prepared.command.kind !== 'broader_resync'
    || !same(runtime, prepared.command.productIds, [item.productId])
    || prepared.command.bindingRevisionId !== scope.bindingRevisionId
    || prepared.sourceHash !== receipt.sourceHash || prepared.planHash !== receipt.planHash
    || receipt.previewToken !== prepared.command.previewToken || receipt.commandHash !== runtime.c.hash(prepared.command))
    fail('SV_CAMPAIGN_HANDOFF_RECEIPT_INVALID');
  const row = (await run.databasePool.query(`SELECT id,binding_revision_id,kind,preview_hash,actor_user_id,evidence
    FROM magento_binding_handoffs WHERE id=$1`, [receipt.handoffId])).rows[0];
  const items = (await run.databasePool.query(`SELECT product_id,public_product_identity_id::text,reason
    FROM magento_binding_handoff_items WHERE handoff_id=$1 ORDER BY product_id`, [receipt.handoffId])).rows;
  const audits = (await run.databasePool.query(`SELECT actor_user_id,details FROM audit_events WHERE
    event_key='magento_binding.broader_resync_reviewed' AND subject_type='magento_binding_handoff' AND subject_id=$1`, [receipt.handoffId])).rows;
  if (!row || row.binding_revision_id !== scope.bindingRevisionId || row.kind !== 'broader_resync'
    || row.preview_hash !== receipt.previewToken || Number(row.actor_user_id) !== run.actorUserId
    || runtime.c.hash(row.evidence) !== prepared.evidenceHash || items.length !== 1
    || items[0].product_id !== item.productId || items[0].public_product_identity_id !== receipt.publicIdentityId
    || items[0].reason !== 'reviewed_resync' || audits.length !== 1 || Number(audits[0].actor_user_id) !== run.actorUserId
    || !same(runtime, audits[0].details, { previewToken: receipt.previewToken, productCount: 1, reason: prepared.command.reason.trim() }))
    fail('SV_CAMPAIGN_HANDOFF_RECEIPT_UNCONFIRMED');
  return true;
}
async function handoff(runtime, config, item, scope, inputRun, { checkpoint, authority, stopping = () => false } = {}) {
  if (runtime.controlled?.handoffExclusivityVersion !== 1) fail('SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED');
  validateItem(item); const lane = laneFor(runtime, config, item, inputRun);
  if (typeof checkpoint !== 'function' || typeof authority !== 'function' || typeof inputRun.fetchImpl !== 'function')
    fail('SV_CAMPAIGN_HANDOFF_OPTIONS_REQUIRED');
  if (['automatic', 'firstSyncDecision', 'firstSyncRecoveryProof', 'preview', 'refresh', 'dispatch']
    .some(name => Object.hasOwn(inputRun, name))) fail('SV_CAMPAIGN_HANDOFF_OPTIONS_INVALID');
  const run = { ...inputRun, fetchImpl: getOnly(inputRun.fetchImpl) }; let entered = false;
  const save = async record => {
    try { await checkpoint(record); } catch (cause) { cause.journalFailure = true; throw cause; }
  };
  try {
    await authority(); if (stopping()) fail('SV_CAMPAIGN_INTERRUPTED');
    let current = await work(lane.client, lane.publicIdentityId);
    let blocked = workReason(current, item); if (blocked) return { status: 'review', reason: blocked };
    const ready = await freshReady(runtime, config, item, scope, run);
    if (ready.publicIdentityId !== lane.publicIdentityId) fail('SV_CAMPAIGN_OUTBOUND_IDENTITY_CHANGED');
    await unchanged(runtime, item, scope, run, ready);
    current = await work(lane.client, lane.publicIdentityId); blocked = workReason(current, item);
    if (blocked) return { status: 'review', reason: blocked };
    const baseReceipt = { sku: item.sku, productId: item.productId, publicIdentityId: lane.publicIdentityId,
      remoteProductId: item.remoteProductId, originHash: runtime.c.originHash(config.baseUrl),
      bindingRevisionId: scope.bindingRevisionId, actorUserId: run.actorUserId, sourceHash: ready.sourceHash, planHash: ready.planHash };
    const pendingReceipt = async request => {
      if (!counter(request.desired_generation)) fail('SV_CAMPAIGN_OUTBOUND_REQUEST_CHANGED');
      const receipt = { ...baseReceipt, kind: 'automatic_request', generation: request.desired_generation };
      const record = { type: 'receipt', stage: 'handoff', sku: item.sku, prepared: receipt, receipt };
      await verifyReceipt(runtime, config, item, scope, record, run); await save(record);
      return { status: 'already_pending', receipt };
    };
    if (current.request && ['pending', 'syncing'].includes(current.request.state)) return pendingReceipt(current.request);
    const request = { bindingRevisionId: scope.bindingRevisionId, expectedRevision: ready.expectedRevision,
      kind: 'broader_resync', productIds: [item.productId], reason };
    const report = await runtime.controlled.preview(config, request, { databasePool: run.databasePool });
    if (report.blockers?.length || report.products?.length !== 1 || report.products[0].productId !== item.productId
      || String(report.products[0].publicIdentityId) !== lane.publicIdentityId || report.products[0].article !== item.sku)
      fail('SV_CAMPAIGN_HANDOFF_PREVIEW_CHANGED');
    if (runtime.c.hash(report.revision) !== ready.bindingHash) fail('SV_CAMPAIGN_PUBLICATION_CHANGED');
    const command = { ...request, previewToken: report.previewToken };
    const prepared = { command, evidenceHash: runtime.c.hash({ reason: request.reason.trim(), products: report.products }),
      sourceHash: ready.sourceHash, planHash: ready.planHash };
    await unchanged(runtime, item, scope, run, ready); await authority();
    current = await work(lane.client, lane.publicIdentityId); blocked = workReason(current, item);
    if (blocked) return { status: 'review', reason: blocked };
    if (current.request && ['pending', 'syncing'].includes(current.request.state)) return pendingReceipt(current.request);
    if (stopping()) fail('SV_CAMPAIGN_INTERRUPTED');
    await save({ type: 'prepared', stage: 'handoff', sku: item.sku, prepared });
    if (stopping()) fail('SV_CAMPAIGN_INTERRUPTED');
    entered = true;
    const applied = await runtime.controlled.apply(config, command, { databasePool: run.databasePool,
      mutationContext: { actorUserId: run.actorUserId, requestId: run.requestId } });
    const receipt = { ...baseReceipt, kind: 'binding_handoff', handoffId: applied.handoffId,
      previewToken: command.previewToken, commandHash: runtime.c.hash(command), alreadyApplied: applied.alreadyApplied };
    const record = { type: 'receipt', stage: 'handoff', sku: item.sku, prepared, receipt };
    await verifyReceipt(runtime, config, item, scope, record, run); await save(record); entered = false;
    return { status: 'queued', receipt };
  } catch (cause) {
    if (entered) { cause.uncertain = true; throw cause; }
    if (cause.journalFailure || cause.code === 'SV_CAMPAIGN_INTERRUPTED') throw cause;
    if (cause.svAuthorityFailure || [401, 403].includes(cause.statusCode) || globalCode(cause.code)) throw cause;
    if (cause.statusCode >= 400 && cause.statusCode < 500 || /^SV_CAMPAIGN_/.test(cause.code || ''))
      return { status: 'review', reason: cause.code };
    throw cause;
  }
}
module.exports = { extendRuntime, acquireLane, handoff, verifyReceipt };
