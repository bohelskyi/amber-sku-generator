'use strict';

// Local per-product stages only. The caller owns the durable campaign journal and
// any later outbound handoff; every mutation retains the canonical service gate.
const path = require('node:path');
const { createRequire } = require('node:module');
const RECORD_KEYS = ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'];
const key = row => row.scope + '/' + row.target;
const record = row => Object.fromEntries(RECORD_KEYS.map(name => [name, row[name]]));
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const globalCode = code => /PUBLICATION|PUBLISHED_CURRENT_BINDING|BINDING_CHANGED|BINDING_CONFLICT|INSTALLATION_MISMATCH|PERMISSION|ACTOR|ADMINISTRATOR|AUTHORI|CUTOVER|LIFECYCLE_WRITER/.test(code || '');
const exactItem = item => ({ sku: item.sku, productId: item.productId, remoteProductId: item.remoteProductId });
const helperScope = (scope, item, names = false) => ({ bindingRevisionId: scope.bindingRevisionId,
  expectedDefinitionHash: scope.expectedDefinitionHash, installationKey: scope.installationKey,
  ...(names ? { choice: 'magento' } : {}), items: [exactItem(item)] });

function createRuntime(serverRoot) {
  const local = createRequire(path.join(path.resolve(serverRoot), 'package.json'));
  const initialNames = local('./scripts/first-sync-initial-names');
  const runtime = { ...initialNames.createRuntime(serverRoot), local,
    initialNames, names: local('./scripts/first-sync-campaign-names'),
    historyBatch: local('./scripts/first-sync-history-batch'), historyCampaign: local('./scripts/first-sync-campaign-history'),
    campaign: local('./scripts/first-sync-campaign'), nameCommit: local('./scripts/first-sync-name-commit').runNameCommit,
    policy: require('./sv-campaign-policy').createPolicy(serverRoot),
    history: local('./src/services/magento/recovery-history'),
    eligibility: local('./src/services/magento/first-sync-eligibility'),
    price: local('./src/services/magento/first-sync-price'),
    readSnapshot: local('./src/services/magento/sync-preview-db').readPreviewProduct };
  return runtime;
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
function runOptions(run, scope) {
  if (typeof run?.fetchImpl !== 'function' || !run.databasePool || !Number.isSafeInteger(run.actorUserId) || run.actorUserId <= 0)
    fail('SV_CAMPAIGN_STAGE_OPTIONS_REQUIRED');
  if (['automatic', 'firstSyncDecision', 'firstSyncRecoveryProof'].some(name => Object.hasOwn(run, name)))
    fail('SV_CAMPAIGN_STAGE_OPTIONS_INVALID');
  return { ...run, installation: scope.installationKey, fetchImpl: getOnly(run.fetchImpl) };
}
function assertExact(runtime, config, item, scope, observation, report) {
  const amber = observation?.amber, p = amber?.product, revision = amber?.revision;
  if (!p || item.category !== undefined && item.category !== 'SV' || p.category !== 'SV'
    || p.id !== item.productId || p.public_sku !== item.sku || !Number.isSafeInteger(item.remoteProductId) || item.remoteProductId <= 0
    || observation.raw?.id !== item.remoteProductId || observation.raw?.sku !== item.sku
    || report?.identity?.state !== 'found' || report.identity.article !== item.sku
    || report.identity.observedMagentoId !== item.remoteProductId || report.mode !== 'update')
    fail('SV_CAMPAIGN_EXACT_IDENTITY_REQUIRED');
  if (revision?.id !== scope.bindingRevisionId || revision.state !== 'published' || revision.installationKey !== scope.installationKey
    || revision.definitionHash !== scope.expectedDefinitionHash || amber.compiled?.hash !== scope.expectedDefinitionHash
    || revision.originHash !== runtime.c.originHash(config.baseUrl)
    || Object.hasOwn(scope, 'publicationHash') && runtime.c.hash(revision) !== scope.publicationHash)
    fail('SV_CAMPAIGN_PUBLICATION_CHANGED');
  if (p.status !== 'active' || p.corrected_to_product_id != null || p.corrected_from_product_id != null
    || p.is_test_product !== false || Number(p.exclude_from_export) !== 0 || p.exportState?.route !== 'normal'
    || p.exportState.business_exclusion_state !== 'none' || p.exportState.recount_compatibility_excluded !== false
    || p.exportState.independentExclusion === true) fail('SV_CAMPAIGN_NORMAL_SINGLETON_REQUIRED');
}
async function assertSingleton(runtime, item, run) {
  const client = await run.databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const history = await runtime.history.read(client, item.productId);
    if (history.complete !== true || history.hasRecount !== false || history.identityChanged !== false
      || !Array.isArray(history.issues) || history.issues.length || !Array.isArray(history.corrections) || history.corrections.length
      || history.products?.length !== 1 || history.products[0].productId !== item.productId)
      fail('SV_CAMPAIGN_NORMAL_SINGLETON_REQUIRED');
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK').catch(() => {}); throw cause; }
  finally { client.release(); }
}
function assertBase(base) {
  if (base?.first?.admissionGuards?.protectedWork !== false) fail('SV_CAMPAIGN_PROTECTED_WORK');
  if (base.first.admissionGuards.otherOrigin !== false) fail('SV_CAMPAIGN_OTHER_ORIGIN');
}
const needsNames = base => (base.prepared?.rows || []).some(row => !row.received && row.target === 'name'
  && ['imported', 'name_received'].includes(row.record?.state));
function historyAvailable(base, item) {
  const proposal = base.historyReview, assessment = base.historyReviewAssessment;
  return base.mode === 'review' && base.first?.mode === 'review' && base.blockers?.length === 1
    && base.blockers[0].code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' && assessment?.status === 'available'
    && assessment.legacySnapshotFlag === true && assessment.code === 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE'
    && proposal?.scope === 'first_sync_review_only' && proposal.doesNotAcknowledgeExport === true
    && proposal.legacySnapshotFlag === true && proposal.sku === item.sku && proposal.remoteProductId === item.remoteProductId
    && /^[a-f0-9]{64}$/.test(proposal.previewToken || '');
}
async function checked(runtime, config, item, scope, run, observation, report, stage) {
  assertExact(runtime, config, item, scope, observation, report);
  const source = structuredClone(runtime.batch.source(observation.amber.product));
  const lifecycle = structuredClone(observation.amber.product.exportState);
  await assertSingleton(runtime, item, run);
  const base = await runtime.first.inspect(config, observation, run);
  assertBase(base);
  const currencyEvidence = base.currencyEvidence || await runtime.price.readCurrencyEvidence(config, observation, { fetchImpl: run.fetchImpl });
  runtime.policy.assertObservation(config, { observation, report, currencyEvidence,
    stage: stage || (historyAvailable(base, item) ? 'history' : needsNames(base) ? 'names' : 'fields') });
  const fresh = await runtime.readSnapshot(run.databasePool, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId });
  if (!same(runtime, source, runtime.batch.source(fresh.product))
    || !same(runtime, lifecycle, fresh.product.exportState) || fresh.product.is_test_product !== false)
    fail('SV_CAMPAIGN_SOURCE_CHANGED_DURING_READ');
  return { observation, report, base, sourceHash: runtime.c.hash(source) };
}
async function inspect(runtime, config, item, scope, inputRun) {
  const run = runOptions(inputRun, scope); let observation;
  const report = await runtime.preview(config, { ...run, sku: item.sku, bindingRevisionId: scope.bindingRevisionId,
    onObservation: value => { observation = value; } });
  return checked(runtime, config, item, scope, run, observation, report);
}

// Existing name/history helpers obtain their own SKU guard. Supply fresh scoped
// previews, never nest another guard around them or serialize their opaque proof.
function stageRuntime(runtime, config, item, scope, run, stage) {
  const reports = new WeakMap();
  const preview = async (_config, options) => {
    let observation;
    const report = await runtime.preview(config, { ...options, fetchImpl: run.fetchImpl,
      onObservation: value => { observation = value; } });
    assertExact(runtime, config, item, scope, observation, report);
    await assertSingleton(runtime, item, run);
    reports.set(observation, report);
    if (stage === 'history') {
      const currencyEvidence = await runtime.price.readCurrencyEvidence(config, observation, { fetchImpl: run.fetchImpl });
      runtime.policy.assertObservation(config, { observation, report, currencyEvidence, stage });
    }
    await options.onObservation?.(observation);
    return report;
  };
  const first = { ...runtime.first, inspect: async (_config, observation, options, ...rest) => {
    const base = await runtime.first.inspect(config, observation, options, ...rest);
    assertBase(base);
    const report = reports.get(observation);
    if (!report) fail('SV_CAMPAIGN_FRESH_OBSERVATION_REQUIRED');
    runtime.policy.assertObservation(config, { observation, report, currencyEvidence: base.currencyEvidence, stage });
    if (stage === 'names') runtime.policy.assertPrepared(base.prepared, { stage, choices: [], base });
    return base;
  } };
  return { runtime: { ...runtime, preview, first }, run: { ...run, preview } };
}
function changed(base, runtime) {
  if (!base.first.progress || base.prepared.complete && !base.first.progress.session.completed_at) return true;
  const previous = new Map(base.first.progress.fields.map(row => [key(row), record(row)]));
  return base.prepared.rows.some(row => !previous.has(key(row)) || !same(runtime, record(row.record), previous.get(key(row))));
}
function selectedFields(runtime, item, scope, evidence, choices) {
  const { base } = evidence;
  const fields = choices.map(choice => {
    const row = base.fields.find(field => key(field) === key(choice));
    if (!row?.local?.known || row.local.present !== true || !row.remote?.known || row.remote.present !== true)
      fail('SV_CAMPAIGN_FIELD_VALUE_REQUIRED');
    return { target: choice.target, scope: choice.scope, local: row.local.value, remote: row.remote.value };
  });
  const packetItem = { sku: item.sku, expectedProduct: runtime.batch.source(base.observation.amber.product),
    remoteProductId: item.remoteProductId, fields };
  const request = { bindingRevisionId: scope.bindingRevisionId, expectedDefinitionHash: scope.expectedDefinitionHash, items: [packetItem] };
  const command = { sku: item.sku, bindingRevisionId: scope.bindingRevisionId, previewToken: base.previewToken,
    choices: runtime.first.decisions({ choices }) };
  return { item: packetItem, request, command, commandSha256: runtime.c.hash(command) };
}
async function verifyReceipt(runtime, config, item, scope, saved, inputRun) {
  const run = runOptions(inputRun, scope);
  if (saved?.type !== 'receipt' || saved.sku !== item.sku || saved.selection?.item?.sku !== item.sku
    || saved.selection.item.remoteProductId !== item.remoteProductId) fail('SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED');
  const reference = saved.stage === 'history' ? saved.selection.scope : saved.selection.request;
  if (reference?.bindingRevisionId !== scope.bindingRevisionId || reference.expectedDefinitionHash !== scope.expectedDefinitionHash)
    fail('SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED');
  if (saved.stage === 'history') {
    if (!['recorded', 'already_admitted'].includes(saved.receipt?.status)) fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
    if (saved.receipt.sku !== item.sku || saved.receipt.productId !== item.productId || saved.receipt.remoteProductId !== item.remoteProductId
      || saved.receipt.status === 'recorded' && !saved.prepared?.command) fail('SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED');
    await runtime.historyCampaign.verifyHistoricalReceipt(runtime, config, helperScope(scope, item),
      { ...saved.receipt, ...(saved.prepared?.command ? { preparedCommand: saved.prepared.command } : {}) }, run.databasePool);
  } else if (saved.stage === 'names' || saved.stage === 'equal') {
    if (saved.receipt?.status !== 'recorded' || saved.selection.item.expectedProduct?.id !== item.productId)
      fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
    if (!saved.prepared?.proof || !saved.receipt.proof || !same(runtime, saved.prepared.proof, saved.receipt.proof))
      fail('SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED');
    await runtime.names.verifyRecorded(runtime, config, saved.selection, saved.receipt, run);
  } else if (saved.stage === 'fields') {
    if (saved.receipt?.status !== 'recorded' || saved.selection.item.expectedProduct?.id !== item.productId
      || !runtime.campaign.expectedReceipt(runtime, saved.selection.command, saved.receipt.result)) fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
    if (!saved.prepared?.command || !same(runtime, saved.prepared.command, saved.selection.command)
      || !/^[a-f0-9]{64}$/.test(saved.prepared.preparedHash || '')
      || saved.selection.command.choices.some(choice => choice.choice !== 'keep_local' || choice.scope !== 'all'
        || !['price', 'decor_weight'].includes(choice.target))) fail('SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED');
    await runtime.campaign.verifyRecorded(runtime, config, saved.selection, saved.receipt, run);
  } else fail('SV_CAMPAIGN_RECEIPT_STAGE_INVALID');
}
async function advance(runtime, config, item, scope, inputRun, hooks) {
  const run = runOptions(inputRun, scope), { checkpoint, authority, stopping = () => false, completedStages = new Set() } = hooks || {};
  if (typeof checkpoint !== 'function' || typeof authority !== 'function' || typeof stopping !== 'function'
    || !(completedStages instanceof Set)) fail('SV_CAMPAIGN_CHECKPOINT_REQUIRED');
  const completed = new Set(completedStages);
  const stop = () => { if (stopping()) fail('SV_CAMPAIGN_INTERRUPTED'); };
  const append = async value => { try { await checkpoint(value); } catch (cause) { cause.journalFailure = true; throw cause; } };
  let uncertain = false, pending = false;
  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      stop(); await authority();
      const evidence = await inspect(runtime, config, item, scope, run), { base } = evidence;
      stop();
      if (base.mode === 'ordinary' && base.first.mode === 'ordinary') return { status: 'ready', ...evidence };
      let stage;
      if (historyAvailable(base, item)) stage = 'history';
      else if (base.mode !== 'first' || base.first.mode !== 'first') return { status: 'review', reason: 'SV_CAMPAIGN_FIRST_SYNC_REVIEW_REQUIRED', ...evidence };
      else if (needsNames(base)) stage = 'names';
      else {
        const choices = runtime.policy.selectChoices(base);
        if (choices.length) stage = 'fields';
        else if (changed(base, runtime)) stage = 'equal';
        else {
          runtime.policy.assertPrepared(base.prepared, { stage: 'fields', choices: [], base });
          if (base.readyForOutbound !== true) fail('SV_CAMPAIGN_FIELDS_UNRESOLVED');
          return { status: 'ready', ...evidence };
        }
      }
      if (completed.has(stage)) return { status: 'review', reason: 'SV_CAMPAIGN_STAGE_ALREADY_RECORDED', stage, ...evidence };
      let selection, prepared, receipt;
      const prepare = async value => {
        stop(); await authority(); prepared = value;
        await append({ type: 'prepared', stage, sku: item.sku, selection, prepared });
        pending = true;
      };
      if (stage === 'history') {
        selection = { item: exactItem(item), scope: helperScope(scope, item) };
        const guarded = stageRuntime(runtime, config, item, scope, run, stage);
        receipt = await runtime.historyBatch.runItem(guarded.runtime, config, exactItem(item), selection.scope, guarded.run,
          { mode: 'apply', append: prepare, stopping });
      } else if (stage === 'names') {
        const nameScope = helperScope(scope, item, true), guarded = stageRuntime(runtime, config, item, scope, run, stage);
        const preview = await runtime.initialNames.previewItem(guarded.runtime, config, nameScope, exactItem(item), guarded.run, authority, stopping,
          { allowPristineFirst: true });
        if (preview.status !== 'available') return { status: 'review', reason: preview.code || 'SV_CAMPAIGN_NAMES_UNAVAILABLE' };
        selection = preview.selection;
        receipt = await runtime.initialNames.runItem(guarded.runtime, config, nameScope, selection, guarded.run,
          { append: prepare, authority, stopping, commit: runtime.nameCommit, allowPristineFirst: true });
      } else if (stage === 'fields') {
        const choices = runtime.policy.selectChoices(base);
        selection = selectedFields(runtime, item, scope, evidence, choices);
        runtime.batch.validatePacketDecision(base, evidence.report, selection.request, selection.item, selection.command.choices);
        const planned = await runtime.first.prepareDecision(config, base, selection.command.choices, run);
        runtime.policy.assertPrepared(planned.prepared, { stage, choices: selection.command.choices, base });
        if (typeof runtime.first.applyWithPreparedValidation !== 'function') fail('SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED');
        await prepare({ command: selection.command, preparedHash: runtime.c.hash(planned.prepared) }); stop();
        let validated = false;
        try {
          const result = await runtime.first.applyWithPreparedValidation(config, selection.command, { ...run,
            validateFirstSyncDecision: async (fresh, report, freshChoices) => {
              assertExact(runtime, config, item, scope, fresh.observation, report); assertBase(fresh);
              await assertSingleton(runtime, item, run);
              runtime.policy.assertObservation(config, { observation: fresh.observation, report, currencyEvidence: fresh.currencyEvidence, stage });
              if (fresh.previewToken !== base.previewToken || !same(runtime, freshChoices, selection.command.choices)) fail('SV_CAMPAIGN_FIELD_PREVIEW_CHANGED');
              runtime.batch.validatePacketDecision(fresh, report, selection.request, selection.item, freshChoices);
              stop(); await authority();
            },
            validatePreparedFirstSyncDecision: fresh => {
              runtime.policy.assertPrepared(fresh, { stage, choices: selection.command.choices, base });
              if (!same(runtime, fresh, planned.prepared)) fail('SV_CAMPAIGN_PREPARED_CHANGED');
              stop(); validated = true;
            } });
          uncertain = true;
          if (!validated || !runtime.campaign.expectedReceipt(runtime, selection.command, result)) fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
          receipt = { status: 'recorded', sku: item.sku, result };
        } catch (cause) { if (validated) cause.uncertain = true; throw cause; }
      } else {
        runtime.policy.assertPrepared(base.prepared, { stage: 'equal', choices: [], base });
        await runtime.boundary.guard(config, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId }, run, async state => {
          const { observation, report } = await runtime.boundary.observe(config, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId }, run);
          const fresh = await checked(runtime, config, item, scope, run, observation, report, 'fields');
          runtime.policy.assertPrepared(fresh.base.prepared, { stage: 'equal', choices: [], base: fresh.base });
          selection = { item: { sku: item.sku, expectedProduct: runtime.batch.source(observation.amber.product), remoteProductId: item.remoteProductId },
            request: { bindingRevisionId: scope.bindingRevisionId, expectedDefinitionHash: scope.expectedDefinitionHash },
            preview: { initialImports: [] }, report: { applyInput: { previewToken: fresh.base.previewToken } } };
          const proof = runtime.names.commitProof(runtime, fresh.base, run);
          await prepare({ proof }); stop();
          const result = await runtime.nameCommit(runtime, config, state, fresh.base, { ...run, stopping });
          uncertain = true;
          if (!runtime.names.expectedReceipt(runtime, selection, proof, result)) fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
          receipt = { status: 'recorded', sku: item.sku, proof, result };
        });
      }
      uncertain ||= receipt?.status === 'unconfirmed' || ['recorded', 'already_admitted'].includes(receipt?.status);
      if (!['recorded', 'already_admitted'].includes(receipt?.status)) {
        if (uncertain) fail('SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
        await append({ type: 'receipt', stage, sku: item.sku, selection, prepared, receipt });
        pending = false;
        if (globalCode(receipt?.code)) fail(receipt.code);
        return { status: 'review', reason: receipt?.code || 'SV_CAMPAIGN_STAGE_BLOCKED', stage };
      }
      const saved = { type: 'receipt', stage, sku: item.sku, selection, prepared, receipt };
      await verifyReceipt(runtime, config, item, scope, saved, run);
      await append(saved); uncertain = false; pending = false; completed.add(stage);
      // A name source update can awaken the ordinary worker. The next fresh
      // inspection detects protected work and stops without replacing its job.
    }
    fail('SV_CAMPAIGN_STAGE_LIMIT');
  } catch (cause) {
    if (uncertain || pending || cause.uncertain || cause.unconfirmed) { cause.uncertain = true; throw cause; }
    if (cause.journalFailure || cause.code === 'SV_CAMPAIGN_INTERRUPTED') throw cause;
    if (cause.svAuthorityFailure || [401, 403].includes(cause.statusCode) || globalCode(cause.code)) throw cause;
    if (cause.statusCode >= 400 && cause.statusCode < 500 || /^SV_CAMPAIGN_|^INITIAL_NAMES_/.test(cause.code || ''))
      return { status: 'review', reason: cause.code };
    throw cause;
  }
}

module.exports = { createRuntime, getOnly, inspect, advance, verifyReceipt };
