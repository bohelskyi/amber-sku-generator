'use strict';

// Validate the complete canonical inspection; never construct a partial plan or
// turn an outward blocker into authority to import another field.
const TERMINAL = new Set(['imported', 'equal', 'optional_empty', 'outward_verified', 'name_received', 'seo_received']);
const RECORD_KEYS = ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'];
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const key = field => field.scope + '/' + field.target;
const record = field => Object.fromEntries(RECORD_KEYS.map(name => [name, field[name]]));
const fail = code => { throw Object.assign(Error(code), { code: 'INITIAL_NAMES_' + code, statusCode: 409 }); };
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
const dense = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max
  && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
const name = value => typeof value === 'string' && value.trim() !== '' && value.length <= 1024
  && !/[\u0000-\u001f\u007f]/.test(value);

function validateScope(input, runtime) {
  try {
    runtime.c.command(input, ['bindingRevisionId', 'expectedDefinitionHash', 'installationKey', 'choice', 'items']);
    runtime.c.identity(input.bindingRevisionId);
    runtime.c.installation(input.installationKey);
    if (!hex(input.expectedDefinitionHash) || input.choice !== 'magento' || !dense(input.items, 1, 2000)) fail('SCOPE_INVALID');
    for (const item of input.items) {
      runtime.c.command(item, ['sku', 'productId', 'remoteProductId']);
      if (typeof item.sku !== 'string' || !item.sku || item.sku.trim() !== item.sku || item.sku.length > 255
        || /[\u0000-\u001f\u007f]/.test(item.sku) || !positive(item.productId) || !positive(item.remoteProductId)) fail('SCOPE_INVALID');
    }
    if (['sku', 'productId', 'remoteProductId'].some(field => new Set(input.items.map(item => item[field])).size !== input.items.length))
      fail('SCOPE_INVALID');
    return structuredClone(input);
  } catch { fail('SCOPE_INVALID'); }
}

function keyed(rows) {
  if (!dense(rows, 1, 500) || rows.some(row => !row || typeof row.target !== 'string' || !row.target
    || typeof row.scope !== 'string' || !row.scope) || new Set(rows.map(key)).size !== rows.length) fail('MANIFEST_INVALID');
  return new Map(rows.map(row => [key(row), row]));
}

function selectionFor(runtime, scope, item, base, report, run, { expected = null, allowPristineFirst = false } = {}) {
  validateScope(scope, runtime);
  if (!scope.items.some(candidate => same(runtime, candidate, item))) fail('ITEM_OUTSIDE_SCOPE');
  const observation = base?.observation, amber = observation?.amber, product = amber?.product, first = base?.first;
  if (base?.mode !== 'first' || first?.mode !== 'first' || !hex(base.previewToken) || !hex(first.evidenceHash)
    || !product || product.id !== item.productId || product.public_sku !== item.sku || product.is_test_product !== false
    || product.status !== 'active' || product.corrected_to_product_id != null || Number(product.exclude_from_export) !== 0
    || product.exportState?.route !== 'normal' || product.exportState.business_exclusion_state !== 'none'
    || product.exportState.recount_compatibility_excluded !== false || product.exportState.independentExclusion === true
    || amber.revision?.id !== scope.bindingRevisionId || amber.revision.state !== 'published'
    || amber.revision.installationKey !== scope.installationKey || run?.installation !== scope.installationKey
    || amber.compiled?.hash !== scope.expectedDefinitionHash || amber.revision.definitionHash !== scope.expectedDefinitionHash
    || observation.raw?.sku !== item.sku || observation.raw?.id !== item.remoteProductId
    || report?.identity?.state !== 'found' || report.identity.article !== item.sku
    || report.identity.observedMagentoId !== item.remoteProductId || report.mode !== 'update'
    || report.bindingRevision?.id !== scope.bindingRevisionId || report.bindingRevision.state !== 'published'
    || report.evaluation?.ready !== true || report.syncEligibility?.eligible !== true)
    fail('FRESH_EVIDENCE_INVALID');
  if (first.admissionGuards?.protectedWork !== false || first.admissionGuards?.otherOrigin !== false) fail('HISTORY_ADMISSION_REQUIRED');
  // A campaign may explicitly use the canonical pristine-first lane. The
  // canonical commit rereads its eligibility hash; no admission is invented.
  const pristine = allowPristineFirst === true && first.historyAdmission === null && first.progress === null;
  let historyRoot = null;
  if (!pristine) {
    if (!first.historyAdmission || !runtime.admission.allows(observation, first.historyAdmission)) fail('HISTORY_ADMISSION_REQUIRED');
    historyRoot = runtime.admission.rootId(first.historyAdmission);
    if (!counter(historyRoot) || first.progress && first.progress.historyAdmissionEventId !== historyRoot) fail('HISTORY_ADMISSION_REQUIRED');
  }
  if (!dense(report.blockers, 0, 500) || report.blockers.some(blocker => blocker?.code !== 'NAME_BASELINE_REQUIRED'))
    fail('ORDINARY_BLOCKER');
  if (!dense(observation.domainEvidence?.failures, 0, 20) || observation.domainEvidence.failures.length
    || observation.categoryFailures?.length) fail('REMOTE_READ_FAILED');

  const prepared = base.prepared, projection = base.projection;
  if (!prepared || !projection || !dense(prepared.blockers, 0, 2000)
    || typeof prepared.complete !== 'boolean' || typeof prepared.readyForOutbound !== 'boolean') fail('PREPARED_INVALID');
  const rows = keyed(prepared.rows), manifest = keyed(prepared.manifest), fields = keyed(projection.fields), metadata = keyed(projection.projection);
  if ([manifest, fields, metadata].some(map => map.size !== rows.size || [...rows.keys()].some(id => !map.has(id)))) fail('MANIFEST_INVALID');
  const manifestHash = runtime.c.hash(projection.projection.map(({ target, scope: fieldScope, mappingHash }) => ({ target, scope: fieldScope, mappingHash })));
  if (!hex(prepared.manifestHash) || prepared.manifestHash !== manifestHash
    || [...metadata.values()].some(meta => !hex(meta.mappingHash))) fail('MANIFEST_INVALID');
  if (first.progress && !dense(first.progress.fields, 0, 500)) fail('PRIOR_RECEIPT_INVALID');
  const previousFields = first.progress?.fields || [];
  if (previousFields.some(field => !field || typeof field.target !== 'string' || typeof field.scope !== 'string')
    || new Set(previousFields.map(key)).size !== previousFields.length) fail('PRIOR_RECEIPT_INVALID');
  const previous = new Map(previousFields.map(field => [key(field), field]));
  for (const prior of previous.values()) if (TERMINAL.has(prior.state) || prior.state === 'seo_pending_initial_readback' || prior.source?.decision) {
    const row = rows.get(key(prior));
    if (!row?.record || !same(runtime, record(prior), record(row.record))) fail('PRIOR_RECEIPT_CHANGED');
  }
  const initialImports = [];
  for (const [id, row] of rows) {
    const prior = previous.get(id), field = fields.get(id), meta = metadata.get(id);
    if (!row.record || key(row.record) !== id || !TERMINAL.has(prior?.state) && row.record.mappingHash !== meta.mappingHash
      || !same(runtime, row.local, field.local) || !same(runtime, row.remote, field.remote)) fail('PREPARED_INVALID');
    if (row.received === true && !TERMINAL.has(prior?.state)) fail('PRIOR_RECEIPT_INVALID');
    if ((row.record.source && Object.hasOwn(row.record.source, 'decision') || row.record.state === 'seo_pending_initial_readback')
      && (!prior || !same(runtime, record(prior), record(row.record)))) fail('NEW_DECISION_DENIED');
    if (TERMINAL.has(prior?.state)) continue;
    if (!['imported', 'name_received'].includes(row.record.state)) continue;
    if (row.target !== 'name' || !['all', 'en'].includes(row.scope) || row.record.state !== 'name_received'
      || row.received || !['imported', 'equal'].includes(row.status)
      || field.kind !== 'name' || field.type !== 'text' || field.mapping?.proven !== true
      || meta.persistence !== 'name' || meta.reason || meta.importBlocker || meta.readReason
      || meta.source?.kind !== 'name' || meta.source.field !== `magento_name_override.values.${row.scope}`
      || meta.source.bindingRevisionId !== scope.bindingRevisionId || meta.source.definitionHash !== scope.expectedDefinitionHash
      || row.record.source?.kind !== 'name' || row.record.source.field !== meta.source.field
      || row.record.source.bindingRevisionId !== scope.bindingRevisionId || row.record.source.definitionHash !== scope.expectedDefinitionHash
      || row.record.source.manifestHash !== manifestHash || row.record.source.productId !== item.productId
      || row.local?.known !== true || row.remote?.known !== true || row.remote.present !== true
      || !name(row.remote.value) || row.record.after !== row.remote.value
      || !same(runtime, row.record.before, row.local) || !same(runtime, row.record.remote, row.remote)) fail('NON_NAME_IMPORT_OR_INVALID_NAME');
    initialImports.push({ target: row.target, scope: row.scope, before: structuredClone(row.local), after: row.record.after });
  }
  if (!initialImports.length) fail('NO_NEW_NAMES');
  if (prepared.blockers.some(blocker => blocker?.target === 'name')) fail('NAME_BLOCKED');
  const selection = {
    item: { sku: item.sku, expectedProduct: runtime.batch.source(product), remoteProductId: item.remoteProductId },
    request: { bindingRevisionId: scope.bindingRevisionId, expectedDefinitionHash: scope.expectedDefinitionHash },
    preview: { sku: item.sku, productId: item.productId, remoteProductId: item.remoteProductId, initialImports },
    report: { applyInput: { sku: item.sku, bindingRevisionId: scope.bindingRevisionId, previewToken: base.previewToken, choices: [] } },
    ordinaryBlockers: structuredClone(report.blockers), remainingBlockers: structuredClone(prepared.blockers),
    manifestHash, preparedHash: runtime.c.hash(prepared), eligibilityHash: first.evidenceHash,
    progressHash: runtime.c.hash(first.progress || null), historyRoot,
  };
  selection.scopeHash = runtime.c.hash(selection);
  if (expected !== null) {
    const { scopeHash, ...sealed } = expected;
    if (!hex(scopeHash) || runtime.c.hash(sealed) !== scopeHash || !same(runtime, selection, expected)) fail('REVIEW_CHANGED');
  }
  return selection;
}

module.exports = { validateScope, selectionFor };
