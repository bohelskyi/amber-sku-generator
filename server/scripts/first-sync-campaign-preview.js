// Standalone campaign preview: local evidence files only; no business mutations.
'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_PACKET_BYTES = 64 * 1024 * 1024;
const REVIEW = 'first-sync-campaign-review-v1';
const PLAN = 'first-sync-campaign-packet-review-v1';
const POLICY = { price: 'manager_price', decor_weight: 'manager_weight_rounding',
  vaha_vyrobu: 'manager_weight_rounding', meta_title: 'amber_seo', meta_description: 'amber_seo' };
const HELP = 'node first-sync-campaign-preview.js --server-root SERVER --input CANDIDATES.json '
  + '--scope-sha256 RAW_SHA256 --discovery-manifest DISCOVERY/manifest.json --output-dir NEW_DIRECTORY '
  + '--expected-database NAME --actor-id ID --installation-key KEY\n'
  + 'Read-only canonical preview of completed discovery packets, sequentially, at most 10 products per packet. '
  + 'Only approved local choices with no initial imports or remaining blockers are selected. No apply or enqueue.';
const fail = code => { throw Object.assign(Error(code), { code }); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const safeCode = error => error?.code === 'EEXIST' ? 'CAMPAIGN_OUTPUT_EXISTS'
  : typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'CAMPAIGN_PREVIEW_FAILED';
const exact = (value, required, optional = []) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('CAMPAIGN_STRUCTURE_INVALID');
};
const allowedField = field => Object.hasOwn(POLICY, field.target)
  && (field.scope === 'all' || field.scope === 'en' && field.target.startsWith('meta_'));
const fieldKey = field => field.scope + '/' + field.target;
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const keys = { '--server-root': 'serverRoot', '--input': 'input', '--scope-sha256': 'scopeHash',
    '--discovery-manifest': 'manifest', '--output-dir': 'output', '--expected-database': 'database',
    '--actor-id': 'actor', '--installation-key': 'installation' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('CAMPAIGN_ARGUMENTS');
    out[key] = value;
  }
  if (!out.input || !out.manifest || !out.output || !out.database || !out.installation || !hex(out.scopeHash)
    || !/^[1-9][0-9]*$/.test(out.actor || '') || !positive(Number(out.actor))) fail('CAMPAIGN_ARGUMENTS');
  out.actor = Number(out.actor); out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}
function validateInput(input, runtime) {
  exact(input, ['items'], ['bindingRevisionId', 'expectedDefinitionHash']);
  if ((input.bindingRevisionId === undefined) !== (input.expectedDefinitionHash === undefined)) fail('CAMPAIGN_SCOPE_INVALID');
  if (input.bindingRevisionId !== undefined) {
    runtime.c.identity(input.bindingRevisionId);
    if (!hex(input.expectedDefinitionHash)) fail('CAMPAIGN_SCOPE_INVALID');
  }
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ITEMS
    || Object.keys(input.items).length !== input.items.length) fail('CAMPAIGN_SCOPE_INVALID');
  for (const item of input.items) {
    exact(item, ['sku', 'productId', 'category', 'remoteProductId', 'fields'], ['expectedProduct']);
    if (typeof item.sku !== 'string' || !item.sku.length || item.sku.length > 256 || item.sku.trim() !== item.sku
      || /[\u0000-\u001f\u007f]/.test(item.sku) || !positive(item.productId)
      || typeof item.category !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.category)
      || item.remoteProductId !== null && !positive(item.remoteProductId)
      || !Array.isArray(item.fields) || !item.fields.length || item.fields.length > 8
      || Object.keys(item.fields).length !== item.fields.length) fail('CAMPAIGN_SCOPE_INVALID');
    for (const field of item.fields) {
      exact(field, ['target', 'scope', 'local', 'remote'], ['policy']);
      if (!allowedField(field) || field.policy !== undefined && field.policy !== POLICY[field.target]) fail('CAMPAIGN_FIELD_NOT_APPROVED');
      for (const value of [field.local, field.remote]) if (value !== null
        && !(typeof value === 'string' && value.length <= 4096)
        && !(typeof value === 'number' && Number.isFinite(value))) fail('CAMPAIGN_SCOPE_INVALID');
    }
    if (new Set(item.fields.map(fieldKey)).size !== item.fields.length) fail('CAMPAIGN_SCOPE_INVALID');
    if (item.expectedProduct !== undefined) runtime.c.command(item.expectedProduct, Object.keys(runtime.batch.source({})));
  }
  for (const key of ['sku', 'productId']) if (new Set(input.items.map(item => item[key])).size !== input.items.length)
    fail('CAMPAIGN_DUPLICATE_IDENTITY');
}
function publicationShape(publication, runtime) {
  exact(publication, ['bindingRevisionId', 'expectedDefinitionHash', 'publicationHash']);
  runtime.c.identity(publication.bindingRevisionId);
  if (!hex(publication.expectedDefinitionHash) || !hex(publication.publicationHash)) fail('CAMPAIGN_PUBLICATION_INVALID');
}
function validateDiscoveryManifest(manifest, input, cli, runtime) {
  const required = ['contract', 'readOnly', 'database', 'actorUserId', 'installationKey', 'inputSha256', 'publication',
    'offset', 'selected', 'total', 'startedAt', 'requiresLocalBatchPreview', 'directRemoteWrites', 'directlyEnqueuedJobs',
    'complete', 'globalFailure', 'finishedAt', 'packets', 'checked', 'candidates', 'blocked', 'invalidatedCandidates',
    'noSelectedChange', 'notChecked', 'nextOffset', 'remainingInput'];
  exact(manifest, required);
  publicationShape(manifest.publication, runtime);
  if (manifest.contract !== 'first-sync-local-discovery-v1' || manifest.readOnly !== true || manifest.complete !== true
    || manifest.globalFailure !== null || manifest.invalidatedCandidates !== 0 || manifest.notChecked !== 0
    || manifest.requiresLocalBatchPreview !== true || manifest.directRemoteWrites !== 0 || manifest.directlyEnqueuedJobs !== 0)
    fail('CAMPAIGN_DISCOVERY_INCOMPLETE');
  if (manifest.database !== cli.database || manifest.actorUserId !== cli.actor || manifest.installationKey !== cli.installation
    || manifest.inputSha256 !== runtime.c.hash(input)) fail('CAMPAIGN_DISCOVERY_OWNERSHIP_CHANGED');
  if (input.bindingRevisionId !== undefined && (input.bindingRevisionId !== manifest.publication.bindingRevisionId
    || input.expectedDefinitionHash !== manifest.publication.expectedDefinitionHash)) fail('CAMPAIGN_PUBLICATION_CHANGED');
  for (const key of ['offset', 'selected', 'total', 'checked', 'candidates', 'blocked', 'noSelectedChange', 'nextOffset', 'remainingInput'])
    if (!integer(manifest[key])) fail('CAMPAIGN_DISCOVERY_COUNTS_INVALID');
  if (!manifest.selected || manifest.total !== input.items.length || manifest.offset + manifest.selected > manifest.total
    || manifest.checked !== manifest.selected || manifest.nextOffset !== manifest.offset + manifest.checked
    || manifest.remainingInput !== manifest.total - manifest.nextOffset
    || manifest.candidates + manifest.blocked + manifest.noSelectedChange !== manifest.checked
    || !Array.isArray(manifest.packets) || manifest.packets.length > MAX_ITEMS
    || Object.keys(manifest.packets).length !== manifest.packets.length) fail('CAMPAIGN_DISCOVERY_COUNTS_INVALID');
  let count = 0;
  for (const [index, descriptor] of manifest.packets.entries()) {
    exact(descriptor, ['file', 'sha256', 'count']);
    if (descriptor.file !== 'packet-' + String(index + 1).padStart(4, '0') + '.json' || !hex(descriptor.sha256)
      || !positive(descriptor.count) || descriptor.count > Math.min(10, runtime.batch.MAX_PRODUCTS)) fail('CAMPAIGN_PACKET_INVALID');
    count += descriptor.count;
  }
  if (count !== manifest.candidates) fail('CAMPAIGN_DISCOVERY_COUNTS_INVALID');
}
function sameValue(runtime, field, expected, actual) {
  if (field.target.startsWith('meta_')) return typeof expected === 'string' && expected === actual;
  const scale = field.target === 'price' ? 2 : 3, normalized = runtime.normalize(expected, scale);
  return normalized !== null && normalized === runtime.normalize(actual, scale);
}
function validatePacket(packet, descriptor, manifest, input, runtime, seenSKUs = new Set()) {
  runtime.batch.command(packet);
  if (packet.items.length > 10 || packet.items.length !== descriptor.count || runtime.c.hash(packet) !== descriptor.sha256
    || packet.bindingRevisionId !== manifest.publication.bindingRevisionId
    || packet.expectedDefinitionHash !== manifest.publication.expectedDefinitionHash) fail('CAMPAIGN_PACKET_CHANGED');
  const selected = input.items.slice(manifest.offset, manifest.nextOffset);
  for (const item of packet.items) {
    if (seenSKUs.has(item.sku)) fail('CAMPAIGN_DUPLICATE_IDENTITY');
    const candidate = selected.find(row => row.sku === item.sku), source = item.expectedProduct;
    if (!candidate || source.id !== candidate.productId || source.public_sku !== item.sku || source.category !== candidate.category
      || candidate.remoteProductId !== null && candidate.remoteProductId !== item.remoteProductId
      || candidate.expectedProduct && runtime.c.hash(candidate.expectedProduct) !== runtime.c.hash(source)) fail('CAMPAIGN_PACKET_OWNERSHIP_CHANGED');
    for (const field of item.fields) {
      const wanted = candidate.fields.find(row => fieldKey(row) === fieldKey(field));
      if (!wanted || !allowedField(field) || !sameValue(runtime, field, wanted.local, field.local)
        || !sameValue(runtime, field, wanted.remote, field.remote)) fail('CAMPAIGN_PACKET_FIELD_CHANGED');
    }
    for (const wanted of candidate.fields) if (!sameValue(runtime, wanted, wanted.local, wanted.remote)
      && !item.fields.some(field => fieldKey(field) === fieldKey(wanted))) fail('CAMPAIGN_PACKET_FIELD_CHANGED');
    seenSKUs.add(item.sku);
  }
}
function brief(sku, blocker) {
  const row = { sku, code: typeof blocker?.code === 'string' && /^[A-Z0-9_]{1,160}$/i.test(blocker.code)
    ? blocker.code : 'CAMPAIGN_REVIEW_REQUIRED' };
  for (const key of ['target', 'scope', 'reason']) if (typeof blocker?.[key] === 'string')
    row[key] = blocker[key].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, key === 'reason' ? 500 : 160);
  return row;
}
function hasNameImportsOnly(report, row) {
  return !report.globalFailure && row.readyForApply === true && row.readyForOutboundAfterChoices === true
    && Array.isArray(row.blockers) && row.blockers.length === 0
    && Array.isArray(row.remainingBlockers) && row.remainingBlockers.length === 0
    && Array.isArray(row.initialImports) && row.initialImports.length > 0
    && row.initialImports.every(field => field && Object.getPrototypeOf(field) === Object.prototype
      && Object.keys(field).length === 4 && ['target', 'scope', 'before', 'after'].every(key => Object.hasOwn(field, key))
      && field.target === 'name' && ['all', 'en'].includes(field.scope))
    && new Set(row.initialImports.map(fieldKey)).size === row.initialImports.length;
}
function nameOnlyPreview(report, request, planFile) {
  return report.results.flatMap((row, index) => hasNameImportsOnly(report, row) ? [{ sku: row.sku,
    productId: request.items[index].expectedProduct.id, remoteProductId: request.items[index].remoteProductId,
    planFile, initialImports: structuredClone(row.initialImports) }] : []);
}
function selectReport(report, request, runtime) {
  if (!report || report.contract !== 'first-sync-local-authority-batch-v1' || report.readOnly !== true
    || report.bindingRevisionId !== request.bindingRevisionId || !Array.isArray(report.results)
    || report.results.length !== request.items.length || report.counts?.total !== request.items.length)
    fail('CAMPAIGN_PREFLIGHT_REPORT_INVALID');
  const selections = [], exceptions = [];
  for (const [index, row] of report.results.entries()) {
    const item = request.items[index];
    if (!row || row.sku !== item.sku || typeof row.readyForApply !== 'boolean' || !Array.isArray(row.blockers))
      fail('CAMPAIGN_PREFLIGHT_REPORT_INVALID');
    const reasons = row.blockers.map(blocker => brief(item.sku, blocker));
    if (row.remainingBlockers !== undefined && !Array.isArray(row.remainingBlockers)
      || row.initialImports !== undefined && !Array.isArray(row.initialImports)) fail('CAMPAIGN_PREFLIGHT_REPORT_INVALID');
    if (row.initialImports?.length) reasons.push(brief(item.sku, { code: hasNameImportsOnly(report, row)
      ? 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW' : 'CAMPAIGN_INITIAL_IMPORTS_REQUIRE_REVIEW' }));
    if (row.readyForApply && row.readyForOutboundAfterChoices !== true)
      reasons.push(brief(item.sku, { code: 'CAMPAIGN_OUTBOUND_NOT_READY' }));
    for (const blocker of row.remainingBlockers || []) reasons.push(brief(item.sku, blocker));
    if (row.readyForApply && (!Array.isArray(row.initialImports) || !Array.isArray(row.remainingBlockers)))
      fail('CAMPAIGN_PREFLIGHT_REPORT_INVALID');
    if (row.readyForApply && !reasons.length && !report.globalFailure) {
      const command = row.applyInput;
      runtime.c.command(command, ['sku', 'bindingRevisionId', 'previewToken', 'choices']);
      if (command.sku !== item.sku || command.bindingRevisionId !== request.bindingRevisionId || !hex(command.previewToken))
        fail('CAMPAIGN_SELECTION_INVALID');
      const choices = runtime.first.decisions(command);
      if (choices.some(choice => choice.choice !== 'keep_local' || !allowedField(choice)
        || !item.fields.some(field => fieldKey(field) === fieldKey(choice)))) fail('CAMPAIGN_FIELD_NOT_APPROVED');
      selections.push({ sku: item.sku, applyInput: structuredClone(command), commandSha256: runtime.c.hash(command) });
    } else {
      if (!reasons.length) reasons.push(brief(item.sku, { code: report.globalFailure || ({
        ordinary_preview_required: 'CAMPAIGN_ORDINARY_PREVIEW_REQUIRED', no_change: 'CAMPAIGN_NO_SELECTED_CHANGE',
        not_checked: 'CAMPAIGN_NOT_CHECKED' }[row.status] || 'CAMPAIGN_NOT_READY') }));
      const seen = new Set();
      for (const reason of reasons) { const key = JSON.stringify(reason); if (!seen.has(key)) { seen.add(key); exceptions.push(reason); } }
    }
  }
  return { selections, exceptions };
}
function groupExceptions(rows) {
  const groups = new Map();
  for (const { sku, ...reason } of rows) {
    const key = JSON.stringify(reason);
    if (!groups.has(key)) groups.set(key, { ...reason, skus: new Set() });
    groups.get(key).skus.add(sku);
  }
  return [...groups.values()].map(({ skus, ...reason }) => ({ ...reason, count: skus.size, skus: [...skus] }));
}
const discoveryHeaderKeys = ['contract', 'readOnly', 'database', 'actorUserId', 'installationKey', 'inputSha256',
  'publication', 'offset', 'selected', 'total', 'startedAt', 'requiresLocalBatchPreview', 'directRemoteWrites', 'directlyEnqueuedJobs'];
function discoveryRows(bytes, manifest, runtime) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== manifest.checked + 2 || lines.some(line => !line.length || Buffer.byteLength(line) > MAX_BYTES))
    fail('CAMPAIGN_DISCOVERY_JOURNAL_INVALID');
  const records = lines.map(line => JSON.parse(line));
  const header = Object.fromEntries(discoveryHeaderKeys.map(key => [key, manifest[key]]));
  if (runtime.c.hash(records[0]) !== runtime.c.hash({ kind: 'start', ...header })
    || runtime.c.hash(records.at(-1)) !== runtime.c.hash({ kind: 'complete', ...manifest })) fail('CAMPAIGN_DISCOVERY_JOURNAL_CHANGED');
  return records.slice(1, -1).map(record => {
    if (record.kind !== 'result') fail('CAMPAIGN_DISCOVERY_JOURNAL_INVALID');
    const row = { ...record }; delete row.kind; return row;
  });
}
function deriveHistoryScope(rows, manifest, input, runtime) {
  const items = [];
  const only = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
    && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).length === keys.length;
  const soleCode = (value, code) => Array.isArray(value) && value.length === 1
    && only(value[0], ['code']) && value[0].code === code;
  const empty = value => value === undefined || Array.isArray(value) && value.length === 0;
  for (const [index, row] of rows.entries()) {
    const item = input.items[manifest.offset + index], assessment = row?.historyReviewAssessment,
      proposal = row?.historyReview, source = row?.sourceSnapshot;
    if (!item || row?.inputIndex !== manifest.offset + index || row.sku !== item.sku || row.productId !== item.productId
      || row.category !== item.category || row.status !== 'blocked' || row.mode !== 'review'
      || !soleCode(row.blockers, 'DISCOVERY_FIRST_SYNC_REVIEW_REQUIRED')
      || !soleCode(row.firstSyncBlockers, 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED')
      || !Array.isArray(row.ordinaryBlockers) || row.ordinaryBlockers.length || !empty(row.remainingBlockers)
      || !empty(row.changes) || !empty(row.initialImports)
      || !only(assessment, ['status', 'legacySnapshotFlag', 'code']) || assessment.status !== 'available'
      || assessment.legacySnapshotFlag !== true || assessment.code !== 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE'
      || !only(proposal, ['scope', 'sku', 'remoteProductId', 'doesNotAcknowledgeExport', 'legacySnapshotFlag', 'previewToken'])
      || proposal.scope !== 'first_sync_review_only' || proposal.doesNotAcknowledgeExport !== true
      || proposal.legacySnapshotFlag !== true || proposal.sku !== item.sku || !hex(proposal.previewToken)
      || !positive(row.remoteProductId) || proposal.remoteProductId !== row.remoteProductId
      || item.remoteProductId !== null && item.remoteProductId !== row.remoteProductId
      || !source || source.id !== item.productId || source.public_sku !== item.sku || source.category !== item.category
      || source.status !== 'active' || ![0, '0'].includes(source.exclude_from_export) || source.corrected_to_product_id !== null
      || item.expectedProduct && runtime.c.hash(item.expectedProduct) !== runtime.c.hash(source)) continue;
    try { runtime.c.command(source, Object.keys(runtime.batch.source({}))); } catch { continue; }
    items.push({ sku: item.sku, productId: item.productId, remoteProductId: row.remoteProductId });
  }
  return items.length ? { bindingRevisionId: manifest.publication.bindingRevisionId,
    expectedDefinitionHash: manifest.publication.expectedDefinitionHash, installationKey: manifest.installationKey, items } : null;
}
function validateDiscoveryResults(rows, manifest, input, packets, runtime) {
  if (!Array.isArray(rows) || rows.length !== manifest.checked) fail('CAMPAIGN_DISCOVERY_RESULTS_INVALID');
  const candidates = packets.flatMap(packet => packet.items), exceptions = [], statuses = { candidate: 0, blocked: 0, no_selected_change: 0 };
  for (const [index, row] of rows.entries()) {
    const item = input.items[manifest.offset + index];
    if (!row || row.inputIndex !== manifest.offset + index || row.sku !== item.sku || row.productId !== item.productId
      || row.category !== item.category || !Object.hasOwn(statuses, row.status) || !Array.isArray(row.blockers))
      fail('CAMPAIGN_DISCOVERY_RESULTS_CHANGED');
    for (const key of ['ordinaryBlockers', 'firstSyncBlockers', 'remainingBlockers'])
      if (row[key] !== undefined && !Array.isArray(row[key])) fail('CAMPAIGN_DISCOVERY_RESULTS_INVALID');
    if (row.sourceSnapshot && (row.sourceSnapshot.id !== item.productId || row.sourceSnapshot.public_sku !== item.sku
      || row.sourceSnapshot.category !== item.category)) fail('CAMPAIGN_DISCOVERY_RESULTS_CHANGED');
    if (row.status === 'candidate') {
      const owned = candidates[statuses.candidate];
      if (!owned || row.blockers.length || runtime.c.hash(row.packetItem) !== runtime.c.hash(owned)
        || row.remoteProductId !== owned.remoteProductId || !row.sourceSnapshot
        || runtime.c.hash(row.sourceSnapshot) !== runtime.c.hash(owned.expectedProduct)) fail('CAMPAIGN_DISCOVERY_RESULTS_CHANGED');
    } else {
      if (row.packetItem !== undefined || row.status === 'blocked' && !row.blockers.length
        || row.status === 'no_selected_change' && row.blockers.length) fail('CAMPAIGN_DISCOVERY_RESULTS_INVALID');
      const reasons = ['blockers', 'ordinaryBlockers', 'firstSyncBlockers', 'remainingBlockers']
        .flatMap(key => (row[key] || []).map(blocker => brief(row.sku, blocker)));
      if (row.status === 'no_selected_change') reasons.push(brief(row.sku, { code: 'DISCOVERY_NO_SELECTED_CHANGE' }));
      const unique = new Set();
      for (const reason of reasons) if (!unique.has(JSON.stringify(reason))) { unique.add(JSON.stringify(reason)); exceptions.push(reason); }
    }
    statuses[row.status]++;
  }
  if (statuses.candidate !== manifest.candidates || statuses.blocked !== manifest.blocked
    || statuses.no_selected_change !== manifest.noSelectedChange) fail('CAMPAIGN_DISCOVERY_COUNTS_INVALID');
  const historyScope = deriveHistoryScope(rows, manifest, input, runtime);
  return { exceptions, historyReviewAvailable: historyScope?.items.length || 0, historyScope };
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null
      || typeof url === 'object' && url?.body != null) fail('CAMPAIGN_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}
function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json')), service = name => local('./src/services/' + name);
  return { c: service('magento/binding-contract'), batch: service('magento/first-sync-batch-preflight'),
    first: service('magento/first-sync.service'), normalize: service('magento/first-sync-field-plan').normalizeDecimal,
    access: service('access-admin-transaction'), gate: service('full-product-cutover-gate'),
    bindings: service('magento/binding.service'), publication: service('magento/binding-publication'),
    audit: service('magento/binding-evidence-audit'), pool: local('./scripts/magento-binding-evidence-audit'),
    config: local('./src/config/magento'), createPool: env => {
      const configuration = local('./src/config/env').loadConfig(env);
      return new (local('pg').Pool)({ ...configuration.databaseOptions,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false, max: 4,
        connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 });
    } };
}
async function readAuthority(runtime, config, options) {
  const client = await options.databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await runtime.access.assertActorStillAuthorized(client, options.actorUserId, 'export_templates.publish', runtime.c.error, { readOnly: true });
    await runtime.publication.administrator(client, options.actorUserId);
    if ((await runtime.gate.readGate(client)).phase === 'preparing') fail('EXPORT_CUTOVER_PREPARING');
    const current = (await client.query("SELECT id FROM magento_binding_revisions WHERE installation_key=$1 AND state='published' ORDER BY version_number DESC LIMIT 1", [options.installation])).rows[0];
    if (!current) fail('CAMPAIGN_CURRENT_PUBLICATION_REQUIRED');
    const revision = await runtime.bindings.readRevisionOnClient(client, current.id);
    if (revision.id !== current.id || revision.state !== 'published' || revision.installationKey !== options.installation
      || revision.originHash !== runtime.c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') fail('CAMPAIGN_PUBLICATION_CHANGED');
    const result = { bindingRevisionId: revision.id, expectedDefinitionHash: revision.definitionHash, publicationHash: runtime.c.hash(revision) };
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function bytesFrom(file, io = fs, limit = MAX_BYTES) {
  const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) fail('CAMPAIGN_FILE_LIMIT');
    const data = Buffer.alloc(Math.min(limit + 1, stat.size + 1)); let offset = 0;
    while (offset < data.length) { const count = (await handle.read(data, offset, data.length - offset, offset)).bytesRead;
      if (!integer(count) || count > data.length - offset) fail('CAMPAIGN_FILE_READ_FAILED');
      if (!count) break; offset += count; }
    if (offset > limit || offset !== stat.size) fail('CAMPAIGN_FILE_LIMIT'); return data.subarray(0, offset);
  } finally { await handle.close(); }
}
async function writeAll(handle, bytes) {
  if (bytes.length > MAX_BYTES) fail('CAMPAIGN_FILE_LIMIT');
  for (let offset = 0; offset < bytes.length;) {
    const count = (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
    if (!positive(count) || count > bytes.length - offset) fail('CAMPAIGN_FILE_WRITE_FAILED'); offset += count;
  }
  await handle.sync();
}
async function syncDirectory(directory, io) {
  const handle = await io.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(directory, name, bytes, io) {
  const handle = await io.open(path.join(directory, name), 'wx', 0o600);
  try { await writeAll(handle, bytes); await syncDirectory(directory, io); }
  catch (cause) { await handle.truncate(0).catch(() => {}); throw cause; }
  finally { await handle.close(); }
}
function jsonBytes(value, runtime, config, secrets, compact = false) {
  runtime.audit.assertEvidenceSafe(value, config, secrets);
  return Buffer.from(JSON.stringify(value, null, compact ? 0 : 2) + '\n');
}
async function writeDiscoveryResults(directory, rows, runtime, config, secrets, io) {
  const descriptors = []; let chunk = [], size = 3;
  const flush = async () => {
    if (!chunk.length) return;
    const file = 'discovery-results-' + String(descriptors.length + 1).padStart(4, '0') + '.json';
    await writeNew(directory, file, jsonBytes(chunk, runtime, config, secrets, true), io);
    descriptors.push({ file, sha256: runtime.c.hash(chunk), count: chunk.length }); chunk = []; size = 3;
  };
  for (const row of rows) {
    const length = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (length + 3 > MAX_BYTES) fail('CAMPAIGN_FILE_LIMIT');
    if (size + length > MAX_BYTES) await flush();
    chunk.push(row); size += length;
  }
  await flush(); return descriptors;
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error, fs: io = fs } = dependencies;
  let owned, journal, interrupted = false;
  const abort = new AbortController(), stop = () => { interrupted = true; abort.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    const read = async (file, limit = MAX_BYTES) => {
      const bytes = dependencies.read ? await dependencies.read(file) : await bytesFrom(file, io, limit);
      if (!Buffer.isBuffer(bytes) || bytes.length > limit) fail('CAMPAIGN_FILE_LIMIT'); return bytes; };
    const inputBytes = await read(cli.input);
    if (hashBytes(inputBytes) !== cli.scopeHash) fail('CAMPAIGN_SCOPE_HASH_CHANGED');
    const input = JSON.parse(inputBytes.toString('utf8')); validateInput(input, runtime);
    runtime.c.installation(cli.installation);
    const discoveryBytes = await read(cli.manifest), discovery = JSON.parse(discoveryBytes.toString('utf8'));
    validateDiscoveryManifest(discovery, input, cli, runtime);
    const packets = [], seen = new Set(); let totalBytes = 0;
    for (const descriptor of discovery.packets) {
      const bytes = await read(path.join(path.dirname(cli.manifest), descriptor.file)); totalBytes += bytes.length;
      if (totalBytes > MAX_PACKET_BYTES) fail('CAMPAIGN_PACKET_BYTES_LIMIT');
      const request = JSON.parse(bytes.toString('utf8')); validatePacket(request, descriptor, discovery, input, runtime, seen);
      packets.push(request);
    }
    const ordered = input.items.slice(discovery.offset, discovery.nextOffset).filter(item => seen.has(item.sku)).map(item => item.sku);
    if (runtime.c.hash(packets.flatMap(packet => packet.items.map(item => item.sku))) !== runtime.c.hash(ordered)) fail('CAMPAIGN_PACKET_ORDER_CHANGED');
    const discoveryJournal = await read(path.join(path.dirname(cli.manifest), 'results.jsonl'), MAX_PACKET_BYTES);
    const discoveredRows = discoveryRows(discoveryJournal, discovery, runtime);
    const discovered = validateDiscoveryResults(discoveredRows, discovery, input, packets, runtime);
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const secrets = runtime.pool.databaseSecrets(env);
    runtime.audit.assertEvidenceSafe(input, config, secrets); runtime.audit.assertEvidenceSafe(discovery, config, secrets);
    await io.mkdir(cli.output, { mode: 0o700 }); await syncDirectory(path.dirname(path.resolve(cli.output)), io);
    await writeNew(cli.output, 'scope.json', inputBytes, io);
    await writeNew(cli.output, 'discovery.json', discoveryBytes, io);
    const discoveryResults = await writeDiscoveryResults(cli.output, discoveredRows, runtime, config, secrets, io);
    journal = await io.open(path.join(cli.output, 'results.jsonl'), 'wx', 0o600); await syncDirectory(cli.output, io);
    const databasePool = dependencies.pool || (owned = (runtime.createPool || runtime.pool.createPool)(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CAMPAIGN_DATABASE_MISMATCH');
    const options = { databasePool, actorUserId: cli.actor, installation: cli.installation, sensitiveValues: secrets,
      fetchImpl: getOnly((url, init = {}) => (dependencies.fetchImpl || globalThis.fetch)(url,
        { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) })) };
    const publication = discovery.publication;
    const authority = async () => {
      if (interrupted) fail('CAMPAIGN_INTERRUPTED');
      const fresh = await (dependencies.readAuthority || readAuthority)(runtime, config, options);
      if (runtime.c.hash(fresh) !== runtime.c.hash(publication)) fail('CAMPAIGN_PUBLICATION_CHANGED');
    };
    const metadata = { readOnly: true, actorUserId: cli.actor, database: cli.database, installationKey: cli.installation,
      scopeSha256: cli.scopeHash, inputSha256: runtime.c.hash(input), publication,
      discoveryManifestSha256: hashBytes(discoveryBytes), discoveryJournalSha256: hashBytes(discoveryJournal) };
    await writeAll(journal, jsonBytes({ kind: 'start', ...metadata, packetCount: packets.length }, runtime, config, secrets, true));
    const plans = [], exceptions = [...discovered.exceptions], namePreviews = [];
    let checked = 0, selected = 0, globalFailure = null, planBytes = 0;
    try {
      await authority();
      for (const [index, request] of packets.entries()) {
        await authority();
        const preflightRequest = structuredClone(request);
        const report = await (dependencies.preflight || runtime.batch.preflight)(config, preflightRequest, options);
        if (runtime.c.hash(preflightRequest) !== runtime.c.hash(request)) fail('CAMPAIGN_PACKET_CHANGED');
        const selection = selectReport(report, request, runtime);
        if (report.globalFailure) throw Object.assign(Error(), { code: safeCode({ code: report.globalFailure }) });
        await authority();
        const plan = { contract: PLAN, ...metadata, request, report, ...selection };
        const file = 'plan-' + String(index + 1).padStart(4, '0') + '.json';
        const bytes = jsonBytes(plan, runtime, config, secrets); planBytes += bytes.length;
        if (planBytes > MAX_PACKET_BYTES) fail('CAMPAIGN_PACKET_BYTES_LIMIT');
        await writeNew(cli.output, file, bytes, io);
        plans.push({ file, sha256: runtime.c.hash(plan), count: request.items.length, selectedCount: selection.selections.length });
        checked += request.items.length; selected += selection.selections.length; exceptions.push(...selection.exceptions);
        namePreviews.push(...nameOnlyPreview(report, request, file));
        await writeAll(journal, jsonBytes({ kind: 'packet', ...plans.at(-1), checked, selected }, runtime, config, secrets, true));
        print(JSON.stringify({ stage: 'preview', packet: index + 1, packets: packets.length, checked, selected }));
      }
      await authority();
    } catch (error) { globalFailure = safeCode(error); }
    let historyScope = null;
    if (!globalFailure && discovered.historyScope) {
      const file = 'history-scope.json', bytes = jsonBytes(discovered.historyScope, runtime, config, secrets);
      await writeNew(cli.output, file, bytes, io);
      historyScope = { file, sha256: hashBytes(bytes), count: discovered.historyScope.items.length };
    }
    const review = { contract: REVIEW, ...metadata, complete: globalFailure === null && checked === discovery.candidates,
      globalFailure, plans, discoveryResults, historyScope, counts: { total: discovery.selected, candidates: discovery.candidates, checked,
        selected: globalFailure ? 0 : selected, excluded: checked - selected, notChecked: discovery.candidates - checked,
        invalidatedSelections: globalFailure ? selected : 0, discoveryBlocked: discovery.blocked,
        discoveryNoSelectedChange: discovery.noSelectedChange, discoveryHistoryReviewAvailable: discovered.historyReviewAvailable,
        remainingInput: discovery.remainingInput },
      exceptions: groupExceptions(exceptions), nameOnlyPreview: namePreviews, directRemoteWrites: 0, directlyEnqueuedJobs: 0 };
    await writeAll(journal, jsonBytes({ kind: 'complete', ...review }, runtime, config, secrets, true));
    const output = jsonBytes(review, runtime, config, secrets);
    await writeNew(cli.output, 'review.json', output, io);
    print(JSON.stringify({ stage: 'complete', output: path.join(path.resolve(cli.output), 'review.json'),
      reviewSha256: hashBytes(output), reviewCanonicalSha256: runtime.c.hash(review), complete: review.complete,
      globalFailure, counts: review.counts, historyScope, directRemoteWrites: 0, directlyEnqueuedJobs: 0 }));
    return globalFailure || review.counts.excluded || discovery.blocked || discovery.remainingInput ? 2 : 0;
  } catch (error) { printError(JSON.stringify({ complete: false, readOnly: true, code: safeCode(error), directRemoteWrites: 0, directlyEnqueuedJobs: 0 })); return 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {}); if (owned) await owned.end().catch(() => {});
  }
}
async function loadReview(directory, expectedRawReviewHash, runtime, cli) {
  if (!hex(expectedRawReviewHash)) fail('CAMPAIGN_REVIEW_HASH_REQUIRED');
  const bytes = await bytesFrom(path.join(directory, 'review.json'));
  if (hashBytes(bytes) !== expectedRawReviewHash) fail('CAMPAIGN_REVIEW_HASH_CHANGED');
  const review = JSON.parse(bytes.toString('utf8'));
  if (review.contract !== REVIEW || review.complete !== true || review.readOnly !== true || review.globalFailure !== null
    || review.actorUserId !== cli.actor || review.database !== cli.database || review.installationKey !== cli.installation
    || cli.scopeHash && review.scopeSha256 !== cli.scopeHash || !hex(review.scopeSha256)
    || !hex(review.discoveryManifestSha256) || !hex(review.discoveryJournalSha256)
    || !Array.isArray(review.plans) || !Array.isArray(review.discoveryResults)
    || !Array.isArray(review.nameOnlyPreview)) fail('CAMPAIGN_REVIEW_INVALID');
  publicationShape(review.publication, runtime);
  const inputBytes = await bytesFrom(path.join(directory, 'scope.json'));
  if (hashBytes(inputBytes) !== review.scopeSha256) fail('CAMPAIGN_SCOPE_HASH_CHANGED');
  const input = JSON.parse(inputBytes.toString('utf8')); validateInput(input, runtime);
  if (runtime.c.hash(input) !== review.inputSha256) fail('CAMPAIGN_SCOPE_HASH_CHANGED');
  const discoveryBytes = await bytesFrom(path.join(directory, 'discovery.json'));
  if (hashBytes(discoveryBytes) !== review.discoveryManifestSha256) fail('CAMPAIGN_DISCOVERY_OWNERSHIP_CHANGED');
  const discovery = JSON.parse(discoveryBytes.toString('utf8')); validateDiscoveryManifest(discovery, input, cli, runtime);
  if (runtime.c.hash(discovery.publication) !== runtime.c.hash(review.publication) || review.plans.length !== discovery.packets.length)
    fail('CAMPAIGN_REVIEW_INVALID');
  const discoveredRows = []; let evidenceBytes = 0;
  if (!review.discoveryResults.length || review.discoveryResults.length > MAX_ITEMS) fail('CAMPAIGN_REVIEW_INVALID');
  for (const [index, descriptor] of review.discoveryResults.entries()) {
    exact(descriptor, ['file', 'sha256', 'count']);
    if (descriptor.file !== 'discovery-results-' + String(index + 1).padStart(4, '0') + '.json'
      || !hex(descriptor.sha256) || !positive(descriptor.count) || descriptor.count > MAX_ITEMS) fail('CAMPAIGN_REVIEW_INVALID');
    const evidence = await bytesFrom(path.join(directory, descriptor.file)); evidenceBytes += evidence.length;
    if (evidenceBytes > MAX_PACKET_BYTES) fail('CAMPAIGN_PACKET_BYTES_LIMIT');
    const rows = JSON.parse(evidence.toString('utf8'));
    if (!Array.isArray(rows) || rows.length !== descriptor.count || runtime.c.hash(rows) !== descriptor.sha256) fail('CAMPAIGN_DISCOVERY_RESULTS_CHANGED');
    discoveredRows.push(...rows);
    if (discoveredRows.length > discovery.checked) fail('CAMPAIGN_DISCOVERY_RESULTS_CHANGED');
  }
  const plans = [], seen = new Set(), exceptions = [], namePreviews = []; let totalBytes = 0, checked = 0, selected = 0;
  for (const [index, descriptor] of review.plans.entries()) {
    exact(descriptor, ['file', 'sha256', 'count', 'selectedCount']);
    if (descriptor.file !== 'plan-' + String(index + 1).padStart(4, '0') + '.json' || !hex(descriptor.sha256)) fail('CAMPAIGN_REVIEW_INVALID');
    const planBytes = await bytesFrom(path.join(directory, descriptor.file)); totalBytes += planBytes.length;
    if (totalBytes > MAX_PACKET_BYTES) fail('CAMPAIGN_PACKET_BYTES_LIMIT');
    const plan = JSON.parse(planBytes.toString('utf8'));
    if (runtime.c.hash(plan) !== descriptor.sha256 || plan.contract !== PLAN || plan.readOnly !== true
      || ['actorUserId', 'database', 'installationKey', 'scopeSha256', 'inputSha256', 'discoveryManifestSha256', 'discoveryJournalSha256']
        .some(key => plan[key] !== review[key]) || runtime.c.hash(plan.publication) !== runtime.c.hash(review.publication)) fail('CAMPAIGN_PLAN_CHANGED');
    validatePacket(plan.request, discovery.packets[index], discovery, input, runtime, seen);
    const projection = selectReport(plan.report, plan.request, runtime);
    if (plan.report.globalFailure || runtime.c.hash(projection.selections) !== runtime.c.hash(plan.selections)
      || runtime.c.hash(projection.exceptions) !== runtime.c.hash(plan.exceptions)
      || descriptor.count !== plan.request.items.length || descriptor.selectedCount !== plan.selections.length) fail('CAMPAIGN_PLAN_CHANGED');
    checked += descriptor.count; selected += descriptor.selectedCount; exceptions.push(...plan.exceptions); plans.push(plan);
    namePreviews.push(...nameOnlyPreview(plan.report, plan.request, descriptor.file));
  }
  const discovered = validateDiscoveryResults(discoveredRows, discovery, input, plans.map(plan => plan.request), runtime);
  if (discovered.historyScope) {
    exact(review.historyScope, ['file', 'sha256', 'count']);
    if (review.historyScope.file !== 'history-scope.json' || !hex(review.historyScope.sha256)
      || review.historyScope.count !== discovered.historyScope.items.length) fail('CAMPAIGN_HISTORY_SCOPE_CHANGED');
    const historyBytes = await bytesFrom(path.join(directory, review.historyScope.file));
    if (hashBytes(historyBytes) !== review.historyScope.sha256
      || runtime.c.hash(JSON.parse(historyBytes.toString('utf8'))) !== runtime.c.hash(discovered.historyScope))
      fail('CAMPAIGN_HISTORY_SCOPE_CHANGED');
  } else if (review.historyScope != null) fail('CAMPAIGN_HISTORY_SCOPE_CHANGED');
  const counts = { total: discovery.selected, candidates: discovery.candidates, checked, selected,
    excluded: checked - selected, notChecked: discovery.candidates - checked, invalidatedSelections: 0,
    discoveryBlocked: discovery.blocked, discoveryNoSelectedChange: discovery.noSelectedChange,
    discoveryHistoryReviewAvailable: discovered.historyReviewAvailable, remainingInput: discovery.remainingInput };
  const order = input.items.slice(discovery.offset, discovery.nextOffset).filter(item => seen.has(item.sku)).map(item => item.sku);
  if (runtime.c.hash(counts) !== runtime.c.hash(review.counts)
    || runtime.c.hash(groupExceptions([...discovered.exceptions, ...exceptions])) !== runtime.c.hash(review.exceptions)
    || runtime.c.hash(namePreviews) !== runtime.c.hash(review.nameOnlyPreview)
    || checked !== discovery.candidates || review.directRemoteWrites !== 0 || review.directlyEnqueuedJobs !== 0
    || runtime.c.hash(plans.flatMap(plan => plan.request.items.map(item => item.sku))) !== runtime.c.hash(order)) fail('CAMPAIGN_REVIEW_INVALID');
  return { review, plans };
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, validateInput, validateDiscoveryManifest, validatePacket, selectReport, groupExceptions,
  validateDiscoveryResults, deriveHistoryScope, createRuntime, readAuthority, getOnly, main, loadReview, MAX_ITEMS, MAX_BYTES };
