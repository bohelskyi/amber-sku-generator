// Standalone exact-identity classification. No application startup or business writes.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const discovery = require('./first-sync-local-discovery');
const { selectionFor } = require('./first-sync-initial-name-plan');
const MAX_BYTES = 4 * 1024 * 1024, MAX_JOURNAL = 32 * 1024 * 1024, MAX_ITEMS = 2000;
const ROUTES = ['ordinary', 'history', 'initial_names', 'create', 'review'];
const CONTRACT = 'first-sync-local-classification-v1';
const HELP = 'node first-sync-local-classify.js --server-root SERVER --input SCOPE.json --output-dir NEW_DIRECTORY '
  + '--expected-database NAME --actor-id ID --installation-key KEY [--offset 0] [--limit 10]\n'
  + 'Read-only exact SV identities, maximum 2000. Fresh canonical classification, not delivery approval. '
  + 'Requires unchanged companion first-sync-local-discovery.js and first-sync-initial-name-plan.js. No apply mode.';
const fail = code => { throw Object.assign(Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeCode = error => error?.code === 'EEXIST' ? 'CLASSIFY_OUTPUT_EXISTS'
  : typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'CLASSIFY_FAILED';
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('CLASSIFY_INPUT_INVALID');
};
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
async function captureFailure(operation, result) {
  try { return await operation(); }
  catch (error) { error.classificationResult = result; throw error; }
}
const brief = blockers => (blockers || []).map(row => Object.fromEntries(['code', 'target', 'scope', 'reason']
  .filter(key => typeof row?.[key] === 'string').map(key => [key, row[key]])));
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  return discovery.argumentsFor(args);
}
function validateInput(input, runtime) {
  exact(input, ['bindingRevisionId', 'expectedDefinitionHash', 'items']);
  runtime.c.identity(input.bindingRevisionId);
  if (!hex(input.expectedDefinitionHash) || !Array.isArray(input.items) || !input.items.length
    || input.items.length > MAX_ITEMS || Object.keys(input.items).length !== input.items.length) fail('CLASSIFY_INPUT_INVALID');
  for (const item of input.items) {
    exact(item, ['sku', 'productId', 'category', 'remoteProductId']);
    if (typeof item.sku !== 'string' || !item.sku || item.sku.length > 255 || item.sku.trim() !== item.sku
      || /[\u0000-\u001f\u007f]/.test(item.sku) || !positive(item.productId) || item.category !== 'SV'
      || item.remoteProductId !== null && !positive(item.remoteProductId)) fail('CLASSIFY_INPUT_INVALID');
  }
  for (const key of ['sku', 'productId', 'remoteProductId']) {
    const values = input.items.map(item => item[key]).filter(value => value !== null);
    if (new Set(values).size !== values.length) fail('CLASSIFY_DUPLICATE_IDENTITY');
  }
}
function getOnly(fetchImpl) {
  const guarded = discovery.getOnly(fetchImpl);
  return (url, init = {}) => {
    if (url && typeof url === 'object' && url.body != null) fail('CLASSIFY_REMOTE_WRITE_DENIED');
    return guarded(url, init);
  };
}
function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  return { ...discovery.createRuntime(serverRoot), initialNameSelection: selectionFor,
    admission: local('./src/services/magento/first-sync-cutover-admission') };
}
function sourceIdentity(item) {
  return { sku: item.sku, productId: item.productId, category: item.category,
    expectedRemoteProductId: item.remoteProductId, observedRemoteProductId: null };
}
async function classifyItem(runtime, config, item, publication, options) {
  let observation;
  const report = await runtime.preview(config, { databasePool: options.databasePool, fetchImpl: options.fetchImpl,
    sensitiveValues: options.sensitiveValues, sku: item.sku, bindingRevisionId: publication.bindingRevisionId,
    onObservation: value => { observation = value; } });
  const product = observation?.amber?.product, identity = report.identity;
  const result = { ...sourceIdentity(item), route: 'review', reviewKind: 'blocked',
    observedAt: report.generatedAt, eligibilityMode: null, inspectionMode: null,
    blockers: [], ordinaryBlockers: brief(report.blockers), eligibilityBlockers: [], fieldBlockers: [],
    freshRemoteEquivalenceEstablished: false, requiresFreshActionPreview: true };
  const block = code => { result.blockers.push({ code }); return result; };
  if (positive(identity?.observedMagentoId)) result.observedRemoteProductId = identity.observedMagentoId;
  if (!product || product.id !== item.productId || product.public_sku !== item.sku || product.category !== item.category
    || report.amberProduct?.publicSku !== item.sku || identity?.article !== item.sku) return block('CLASSIFY_LOCAL_IDENTITY_CHANGED');
  const revision = observation.amber.revision;
  if (revision?.id !== publication.bindingRevisionId || revision.state !== 'published'
    || revision.installationKey !== options.installation || revision.definitionHash !== publication.expectedDefinitionHash
    || observation.amber.compiled?.hash !== publication.expectedDefinitionHash) fail('CLASSIFY_PUBLICATION_CHANGED');
  const found = identity.state === 'found' && report.mode === 'update' && positive(identity.observedMagentoId)
    && observation.raw?.id === identity.observedMagentoId && observation.raw?.sku === item.sku;
  const absent = identity.state === 'absent' && report.mode === 'create'
    && identity.observedMagentoId === null && observation.raw === null;
  if (!found && !absent || item.remoteProductId !== null && (!found || item.remoteProductId !== identity.observedMagentoId))
    return block('CLASSIFY_REMOTE_IDENTITY_CHANGED');
  result.remoteIdentityState = found ? 'found' : 'absent';
  result.sourceSnapshot = structuredClone(runtime.batch.source(product));
  result.sourceHash = runtime.c.hash(result.sourceSnapshot);
  const lifecycle = structuredClone({ exportState: product.exportState, isTestProduct: product.is_test_product });
  const base = await captureFailure(() => runtime.first.inspect(config, observation, options), result);
  result.eligibilityMode = base.first?.mode ?? null;
  result.inspectionMode = base.mode;
  result.eligibilityBlockers = brief(base.first?.blockers);
  result.fieldBlockers = base.first?.mode === 'first' ? brief(base.blockers) : [];
  result.fields = structuredClone(base.fields || []);
  result.historyReviewAssessment = structuredClone(base.historyReviewAssessment || null);
  result.historyReview = structuredClone(base.historyReview || null);
  // An earlier ACK selects a lane; neither that ACK nor these flags certify current equality.
  result.ordinarySendable = report.sendable === true;
  result.inspectionReadyForOutbound = base.readyForOutbound === true;
  const fresh = await captureFailure(() => runtime.readSnapshot(options.databasePool,
    { sku: item.sku, bindingRevisionId: publication.bindingRevisionId }), result);
  if (!same(runtime, runtime.batch.source(fresh.product), result.sourceSnapshot)
    || !same(runtime, { exportState: fresh.product.exportState, isTestProduct: fresh.product.is_test_product }, lifecycle))
    return block('CLASSIFY_SOURCE_CHANGED_DURING_READ');
  if (product.status !== 'active' || product.corrected_to_product_id != null || product.is_test_product !== false
    || Number(product.exclude_from_export) !== 0 || product.exportState?.route !== 'normal'
    || product.exportState.business_exclusion_state !== 'none' || product.exportState.recount_compatibility_excluded !== false
    || product.exportState.independentExclusion === true) return block('CLASSIFY_LIFECYCLE_NOT_NORMAL');
  if (!['ordinary', 'first', 'create', 'review'].includes(result.eligibilityMode)
    || !['ordinary', 'first', 'create', 'review'].includes(base.mode)) return block('CLASSIFY_MODE_UNPROVEN');
  if (base.first.mode === 'ordinary' && base.mode === 'ordinary' && found) result.route = 'ordinary';
  else if (base.first.mode === 'create' && base.mode === 'create' && absent) result.route = 'create';
  else if (found && base.first.mode === 'review' && base.mode === 'review') {
    const proposal = base.historyReview, assessment = base.historyReviewAssessment;
    if (base.blockers?.length === 1 && base.blockers[0].code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'
      && assessment?.status === 'available' && assessment.legacySnapshotFlag === true
      && assessment.code === 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE'
      && proposal?.scope === 'first_sync_review_only' && proposal.doesNotAcknowledgeExport === true
      && proposal.legacySnapshotFlag === true && proposal.sku === item.sku
      && proposal.remoteProductId === result.observedRemoteProductId && hex(proposal.previewToken)) result.route = 'history';
    else block('CLASSIFY_CANONICAL_REVIEW_REQUIRED');
  } else if (found && base.first.mode === 'first' && base.mode === 'first') {
    const needsNames = (base.prepared?.rows || []).some(row => row.target === 'name' && !row.received
      && ['imported', 'name_received'].includes(row.record?.state))
      || [...result.ordinaryBlockers, ...result.fieldBlockers].some(row => row.target === 'name' || row.code === 'NAME_BASELINE_REQUIRED');
    if (!needsNames) {
      result.reviewKind = result.ordinaryBlockers.length ? 'blocked' : 'field_stage';
      return block('CLASSIFY_FIRST_SYNC_FIELD_REVIEW_REQUIRED');
    }
    const exactItem = { sku: item.sku, productId: item.productId, remoteProductId: result.observedRemoteProductId };
    const scope = { bindingRevisionId: publication.bindingRevisionId, expectedDefinitionHash: publication.expectedDefinitionHash,
      installationKey: options.installation, choice: 'magento', items: [exactItem] };
    try {
      // Pure existing validator, on the original proof-owning observation. Discard its apply payload.
      const selection = runtime.initialNameSelection(runtime, scope, exactItem, base, report, options);
      result.historyRootAuditEventId = selection.historyRoot;
      result.initialNames = selection.preview.initialImports;
      result.route = 'initial_names';
    } catch (error) {
      const code = safeCode(error);
      if (!code.startsWith('INITIAL_NAMES_')) throw error;
      result.reviewKind = code === 'INITIAL_NAMES_NO_NEW_NAMES' ? 'field_stage' : 'blocked';
      block(code);
    }
  } else block('CLASSIFY_CANONICAL_REVIEW_REQUIRED');
  if (result.route !== 'review') result.reviewKind = null;
  return result;
}
async function readBytes(io, file) {
  const handle = await io.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('CLASSIFY_INPUT_LIMIT');
    const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    if (length > MAX_BYTES) fail('CLASSIFY_INPUT_LIMIT');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function syncDirectory(io, directory) {
  // Windows does not expose directory fsync; file fsync and the incomplete marker still apply.
  if (process.platform === 'win32') return;
  const handle = await io.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeRecord(handle, value, runtime, config, secrets) {
  runtime.audit.assertEvidenceSafe(value, config, secrets);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  return writeBytes(handle, bytes);
}
async function writeBytes(handle, bytes) {
  if (bytes.length > MAX_BYTES || (await handle.stat()).size + bytes.length > MAX_JOURNAL) fail('CLASSIFY_OUTPUT_LIMIT');
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) fail('CLASSIFY_OUTPUT_WRITE_FAILED'); offset += bytesWritten;
  }
  await handle.sync(); return hash(bytes);
}
async function writeNew(io, file, value, runtime, config, secrets) {
  const handle = await io.open(file, 'wx', 0o600);
  try { return await writeRecord(handle, value, runtime, config, secrets); } finally { await handle.close(); }
}
function subset(route, results, input, installation) {
  const rows = results.filter(row => row.route === route);
  const common = { bindingRevisionId: input.bindingRevisionId, expectedDefinitionHash: input.expectedDefinitionHash,
    installationKey: installation };
  if (route === 'history' || route === 'initial_names') return { ...common,
    ...(route === 'initial_names' ? { choice: 'magento' } : {}),
    items: rows.map(row => ({ sku: row.sku, productId: row.productId, remoteProductId: row.observedRemoteProductId })) };
  return { ...common, route, requiresFreshActionPreview: true, items: rows.map(row => ({
    sku: row.sku, productId: row.productId, category: row.category, expectedRemoteProductId: row.expectedRemoteProductId,
    observedRemoteProductId: row.observedRemoteProductId, inputIndex: row.inputIndex })) };
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error, io = fs } = dependencies;
  let owned, journal, interrupted = false, checked = 0, marker, sealed = false;
  const stop = () => { interrupted = true; };
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    const bytes = await readBytes(io, cli.input), input = JSON.parse(bytes.toString('utf8'));
    validateInput(input, runtime); runtime.c.installation(cli.installation);
    if (cli.offset >= input.items.length) fail('CLASSIFY_OFFSET_OUT_OF_RANGE');
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const pool = dependencies.pool || (owned = runtime.pool.createReadOnlyPool(env));
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CLASSIFY_DATABASE_MISMATCH');
    if ((await pool.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only !== 'on')
      fail('CLASSIFY_READ_ONLY_DATABASE_REQUIRED');
    const options = { databasePool: pool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: runtime.pool.databaseSecrets(env), fetchImpl: getOnly(dependencies.fetchImpl || globalThis.fetch) };
    const authority = async () => {
      try { return await (dependencies.readAuthority || discovery.readAuthority)(runtime, config, options); }
      catch (error) { error.classificationAuthorityFailure = true; throw error; }
    };
    const publication = await authority();
    if (publication.bindingRevisionId !== input.bindingRevisionId || publication.expectedDefinitionHash !== input.expectedDefinitionHash
      || !hex(publication.publicationHash)) fail('CLASSIFY_PUBLICATION_CHANGED');
    await io.mkdir(cli.output, { mode: 0o700 });
    marker = path.join(cli.output, 'incomplete');
    await writeNew(io, marker, { contract: CONTRACT, complete: false }, runtime, config, options.sensitiveValues);
    runtime.audit.assertEvidenceSafe(input, config, options.sensitiveValues);
    const savedScope = await io.open(path.join(cli.output, 'scope.json'), 'wx', 0o600);
    try { await writeBytes(savedScope, bytes); } finally { await savedScope.close(); }
    journal = await io.open(path.join(cli.output, 'results.jsonl'), 'wx', 0o600);
    await syncDirectory(io, cli.output);
    const selected = input.items.slice(cli.offset, cli.offset + cli.limit), results = [];
    const header = { contract: CONTRACT, readOnly: true, database: cli.database, actorUserId: cli.actor,
      installationKey: cli.installation, publication, inputSha256: hash(bytes), canonicalInputSha256: runtime.c.hash(input),
      offset: cli.offset, selected: selected.length, total: input.items.length, startedAt: new Date().toISOString(),
      directRemoteWrites: 0, directlyEnqueuedJobs: 0, localBusinessWrites: 0, requiresFreshActionPreview: true };
    await writeRecord(journal, { kind: 'start', ...header }, runtime, config, options.sensitiveValues);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let globalFailure = null;
    for (const [index, item] of selected.entries()) {
      if (interrupted) { globalFailure = 'CLASSIFY_INTERRUPTED'; break; }
      let result;
      try {
        if (!same(runtime, publication, await authority())) fail('CLASSIFY_PUBLICATION_CHANGED');
        result = await classifyItem(runtime, config, item, publication, options);
        if (!same(runtime, publication, await authority())) fail('CLASSIFY_PUBLICATION_CHANGED');
      } catch (error) {
        const code = safeCode(error);
        result = { ...sourceIdentity(item), eligibilityMode: null, inspectionMode: null,
          ordinaryBlockers: [], eligibilityBlockers: [], fieldBlockers: [], ...error.classificationResult,
          route: 'review', reviewKind: 'read_failure', blockers: [{ code }],
          freshRemoteEquivalenceEstablished: false, requiresFreshActionPreview: true };
        if (error.classificationAuthorityFailure || [401, 403].includes(error.statusCode)
          || /PUBLICATION|PERMISSION|ACTOR|ADMINISTRATOR|CUTOVER|LIFECYCLE_WRITER/.test(code)) globalFailure = code;
      }
      result.inputIndex = cli.offset + index;
      await writeRecord(journal, { kind: 'result', ...result }, runtime, config, options.sensitiveValues);
      results.push(result); checked = results.length;
      print(JSON.stringify({ stage: 'classification', checked, selected: selected.length, sku: item.sku,
        route: result.route, nextOffset: result.inputIndex + 1 }));
      if (globalFailure) break;
    }
    if (!globalFailure) try {
      if (interrupted) fail('CLASSIFY_INTERRUPTED');
      if (!same(runtime, publication, await authority())) fail('CLASSIFY_PUBLICATION_CHANGED');
      if (hash(await readBytes(io, cli.input)) !== header.inputSha256) fail('CLASSIFY_SCOPE_CHANGED_DURING_READ');
      const remoteIds = results.map(row => row.observedRemoteProductId).filter(positive);
      if (new Set(remoteIds).size !== remoteIds.length) fail('CLASSIFY_DUPLICATE_OBSERVED_IDENTITY');
    } catch (error) { globalFailure = safeCode(error); }
    const subsets = [], counts = Object.fromEntries(ROUTES.map(route => [route, results.filter(row => row.route === route).length]));
    if (!globalFailure) for (const route of ROUTES) {
      if (!counts[route]) continue;
      const file = route + '-scope.json';
      const sha256 = await writeNew(io, path.join(cli.output, file), subset(route, results, input, cli.installation),
        runtime, config, options.sensitiveValues);
      subsets.push({ route, file, sha256, count: counts[route] });
    }
    const manifest = { ...header, complete: !globalFailure && checked === selected.length, globalFailure, counts, subsets,
      checked, notChecked: selected.length - checked, nextOffset: cli.offset + checked,
      remainingInput: input.items.length - cli.offset - checked, finishedAt: new Date().toISOString() };
    await writeRecord(journal, { kind: 'complete', ...manifest }, runtime, config, options.sensitiveValues);
    await writeNew(io, path.join(cli.output, 'manifest.json'), manifest, runtime, config, options.sensitiveValues);
    await syncDirectory(io, cli.output);
    // A readable manifest is usable only after this marker is gone, and only if complete/no global failure.
    await io.unlink(marker); await syncDirectory(io, cli.output); marker = null; sealed = true;
    print(JSON.stringify({ stage: 'complete', output: cli.output, ...manifest }));
    return globalFailure || counts.review ? 2 : 0;
  } catch (error) {
    // In particular, restore the marker if its unlink succeeded but the directory fsync failed.
    if (marker) try {
      const incomplete = await io.open(marker, 'wx', 0o600);
      try { await writeBytes(incomplete, Buffer.from('{"complete":false}\n')); } finally { await incomplete.close(); }
      await syncDirectory(io, path.dirname(marker));
    } catch { /* An existing marker already blocks use; a failed output is never a usable checkpoint. */ }
    printError(JSON.stringify({ ok: false, code: safeCode(error), complete: false, checked,
      directRemoteWrites: 0, localBusinessWrites: 0, directlyEnqueuedJobs: 0, sealed,
      incompleteMarkerRequired: marker !== undefined && marker !== null }));
    return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, validateInput, getOnly, createRuntime, classifyItem, main, MAX_ITEMS };
