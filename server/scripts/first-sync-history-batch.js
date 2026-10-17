// Standalone adapter for the existing cutover admission service. No app startup.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 50;
const SCOPE = 'first_sync_review_only';
const HELP = 'node first-sync-history-batch.js --server-root /app --mode preview|apply '
  + '--input SCOPE.json --scope-sha256 SHA256 --output NEW_JOURNAL.jsonl '
  + '--expected-database NAME --actor-id ID [--schema-cache-seconds 0-600] [--preview-all]\n'
  + 'Exact 1..50 SKU history admissions using fresh canonical review and admission. '
  + 'Only scoped audit records may be written; no field choices, enqueue or Magento writes. '
  + 'Stops on the first uncertainty. No automatic retry or resume.';
const hashBytes = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const safeCode = e => e?.code === 'EEXIST' ? 'HISTORY_BATCH_OUTPUT_EXISTS'
  : typeof e?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(e.code) ? e.code : 'HISTORY_BATCH_FAILED';
const { schemaReadCache, parseSeconds } = require('./magento-schema-read-cache');
const GLOBAL = /PUBLICATION|BINDING_CHANGED|INSTALLATION|PERMISSION|ADMINISTRATOR|AUTHORI|ACTOR|DATABASE|INTERRUPTED|NOT_CONFIGURED|JOURNAL|OUTPUT|LIMIT/;
const positiveId = n => Number.isSafeInteger(n) && n > 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--server-root': 'serverRoot', '--mode': 'mode', '--input': 'input',
    '--scope-sha256': 'scopeHash', '--output': 'output', '--expected-database': 'database', '--actor-id': 'actor',
    '--schema-cache-seconds': 'schemaCacheSeconds' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--preview-all' && !Object.hasOwn(out, 'previewAll')) { out.previewAll = true; i--; continue; }
    const key = names[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('HISTORY_BATCH_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply'].includes(out.mode) || !out.input || !out.output || !out.database
    || !hex(out.scopeHash) || !/^[1-9][0-9]*$/.test(out.actor || '') || !positiveId(Number(out.actor))
    || out.previewAll && out.mode !== 'preview' || parseSeconds(out.schemaCacheSeconds) === null) fail('HISTORY_BATCH_ARGUMENTS');
  out.actor = Number(out.actor); out.schemaCacheSeconds = parseSeconds(out.schemaCacheSeconds); out.previewAll = out.previewAll === true; out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}
function validateInput(input, runtime) {
  runtime.c.command(input, ['bindingRevisionId', 'expectedDefinitionHash', 'installationKey', 'items']);
  runtime.c.identity(input.bindingRevisionId);
  runtime.c.installation(input.installationKey);
  if (!hex(input.expectedDefinitionHash)
    || !Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ITEMS
    || Object.keys(input.items).length !== input.items.length) fail('HISTORY_BATCH_INPUT_INVALID');
  for (const item of input.items) {
    runtime.c.command(item, ['sku', 'productId', 'remoteProductId']);
    if (typeof item.sku !== 'string' || !item.sku.length || item.sku.length > 255 || item.sku.trim() !== item.sku
      || /[\u0000-\u001f\u007f]/.test(item.sku) || !positiveId(item.productId) || !positiveId(item.remoteProductId)) fail('HISTORY_BATCH_INPUT_INVALID');
  }
  for (const key of ['sku', 'productId', 'remoteProductId'])
    if (new Set(input.items.map(item => item[key])).size !== input.items.length) fail('HISTORY_BATCH_DUPLICATE_IDENTITY');
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null) fail('HISTORY_BATCH_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}
function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  const service = name => local('./src/services/' + name);
  return { c: service('magento/binding-contract'), first: service('magento/first-sync.service'),
    admission: service('magento/first-sync-cutover-admission'), eligibility: service('magento/first-sync-eligibility'),
    preview: service('magento/sync-preview').previewProduct, batch: service('magento/first-sync-batch-preflight'),
    publication: service('magento/binding-publication'), bindings: service('magento/binding.service'),
    access: service('access-admin-transaction'), audit: service('magento/binding-evidence-audit'),
    config: local('./src/config/magento'), databaseSecrets: local('./scripts/magento-binding-evidence-audit').databaseSecrets,
    createPool: env => {
      const configuration = local('./src/config/env').loadConfig(env);
      return new (local('pg').Pool)({ ...configuration.databaseOptions,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false, max: 4,
        connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 });
    } };
}
async function authority(runtime, config, scope, run) {
  const client = await run.databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await runtime.access.assertActorStillAuthorized(client, run.actorUserId, 'export_templates.publish', runtime.c.error, { readOnly: true });
    await runtime.publication.administrator(client, run.actorUserId);
    const current = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`, [scope.installationKey])).rows[0];
    if (current?.id !== scope.bindingRevisionId) fail('HISTORY_BATCH_PUBLICATION_CHANGED');
    const revision = await runtime.bindings.readRevisionOnClient(client, current.id);
    if (revision.state !== 'published' || revision.installationKey !== scope.installationKey
      || revision.definitionHash !== scope.expectedDefinitionHash || revision.originHash !== runtime.c.originHash(config.baseUrl)
      || revision.schema.storeCode !== 'all') fail('HISTORY_BATCH_PUBLICATION_CHANGED');
    await client.query('COMMIT'); return runtime.c.hash(revision);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
function identityPreview(runtime, item, scope, capture, expectedSourceHash) {
  return async (config, options) => {
    let observation;
    const report = await runtime.preview(config, { ...options, onObservation: value => { observation = value; } });
    const p = observation?.amber?.product, revision = observation?.amber?.revision;
    if (!p || p.id !== item.productId || p.public_sku !== item.sku || report.mode !== 'update'
      || report.identity?.state !== 'found' || report.identity.article !== item.sku
      || report.amberProduct?.publicSku !== item.sku || report.identity.observedMagentoId !== item.remoteProductId
      || observation.raw?.sku !== item.sku || observation.raw?.id !== item.remoteProductId) fail('HISTORY_BATCH_IDENTITY_CHANGED');
    if (revision?.id !== scope.bindingRevisionId || revision.installationKey !== scope.installationKey
      || revision.definitionHash !== scope.expectedDefinitionHash
      || observation.amber.compiled?.hash !== scope.expectedDefinitionHash) fail('HISTORY_BATCH_PUBLICATION_CHANGED');
    const sourceHash = runtime.c.hash(runtime.batch.source(p));
    if (expectedSourceHash && sourceHash !== expectedSourceHash) fail('HISTORY_BATCH_SOURCE_CHANGED');
    capture({ observation, report, sourceHash });
    if (options.onObservation) await options.onObservation(observation);
    return report;
  };
}
async function existingAdmission(runtime, config, observation, run) {
  const client = await run.databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const fresh = await runtime.eligibility.readFirstSyncEligibility(client, config, observation);
    const root = runtime.admission.rootId(fresh.historyAdmission);
    if (fresh.mode !== 'first' || fresh.admissionGuards?.protectedWork || fresh.admissionGuards?.otherOrigin
      || !runtime.admission.allows(observation, fresh.historyAdmission) || !/^[1-9][0-9]*$/.test(root || ''))
      fail('HISTORY_BATCH_EXISTING_ADMISSION_UNCONFIRMED');
    await client.query('COMMIT'); return { rootAuditEventId: root, verifiedCurrentAdmission: true };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
async function runItem(runtime, config, item, scope, run, { mode, append, stopping = () => false }) {
  let started = false, observed, prepared;
  try {
    if (stopping()) fail('HISTORY_BATCH_INTERRUPTED');
    const publicationHash = await authority(runtime, config, scope, run);
    const review = await runtime.first.review(config, { sku: item.sku, bindingRevisionId: scope.bindingRevisionId },
      { ...run, preview: identityPreview(runtime, item, scope, value => { observed = value; }) });
    if (!observed || review.sku !== item.sku) fail('HISTORY_BATCH_OBSERVATION_REQUIRED');
    const diagnostics = { ordinaryBlockers: (observed.report.blockers || []).map(row => ({ code: row.code })),
      sourceHash: observed.sourceHash, publicationHash };
    if (review.mode === 'first') {
      const existing = await existingAdmission(runtime, config, observed.observation, run);
      if (await authority(runtime, config, scope, run) !== publicationHash) fail('HISTORY_BATCH_PUBLICATION_CHANGED');
      return { ...item, status: 'already_admitted', scope: SCOPE, doesNotAcknowledgeExport: true, existing, ...diagnostics };
    }
    const proposal = review.historyReview, assessment = review.historyReviewAssessment;
    if (review.mode !== 'review' || review.blockers?.length !== 1 || review.blockers[0].code !== 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'
      || assessment?.status !== 'available' || assessment.legacySnapshotFlag !== true
      || assessment.code !== 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE'
      || proposal?.scope !== SCOPE || proposal.doesNotAcknowledgeExport !== true || proposal.legacySnapshotFlag !== true
      || proposal.sku !== item.sku || proposal.remoteProductId !== item.remoteProductId || !hex(proposal.previewToken))
      fail('HISTORY_BATCH_ADMISSION_NOT_AVAILABLE');
    prepared = { ...item, command: { sku: item.sku, bindingRevisionId: scope.bindingRevisionId, previewToken: proposal.previewToken }, ...diagnostics };
    try { await append({ type: 'prepared', ...prepared }); }
    catch (e) { e.journalFailure = true; throw e; }
    if (stopping()) fail('HISTORY_BATCH_INTERRUPTED');
    if (await authority(runtime, config, scope, run) !== publicationHash) fail('HISTORY_BATCH_PUBLICATION_CHANGED');
    if (mode === 'preview') return { ...item, status: 'available', ...diagnostics };
    // The same exact-identity/source validator also runs inside canonical apply's fresh observation.
    if (stopping()) fail('HISTORY_BATCH_INTERRUPTED');
    started = true;
    const result = await runtime.admission.apply(config, prepared.command,
      { ...run, preview: identityPreview(runtime, item, scope, () => {}, observed.sourceHash) });
    if (result?.sku !== item.sku || result.scope !== SCOPE || result.doesNotAcknowledgeExport !== true
      || typeof result.receipt?.auditEventId !== 'string' || !/^[1-9][0-9]*$/.test(result.receipt.auditEventId)
      || typeof result.receipt.alreadyApplied !== 'boolean') throw Error('Unconfirmed receipt');
    return { ...item, status: result.receipt.alreadyApplied ? 'already_admitted' : 'recorded', ...result, ...diagnostics };
  } catch (e) {
    if (e.journalFailure) throw e;
    return { ...item, status: started && !(e.statusCode >= 400 && e.statusCode < 500) ? 'unconfirmed' : 'blocked',
      code: safeCode(e), ...(prepared ? { previewToken: prepared.command.previewToken } : {}),
      ...(observed ? { ordinaryBlockers: (observed.report.blockers || []).map(row => ({ code: row.code })) } : {}) };
  }
}
async function readBytes(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_BYTES) fail('HISTORY_BATCH_INPUT_LIMIT');
    const data = Buffer.alloc(MAX_BYTES + 1); let bytes = 0;
    while (bytes < data.length) { const read = await handle.read(data, bytes, data.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    if (bytes > MAX_BYTES) fail('HISTORY_BATCH_INPUT_LIMIT');
    return data.subarray(0, bytes);
  } finally { await handle.close(); }
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, output, unconfirmed = false, interrupted = false;
  const stop = () => { interrupted = true; };
  try {
    const options = argumentsFor(args); if (options.help) { print(HELP); return 0; }
    const bytes = await (dependencies.read || readBytes)(options.input);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || hashBytes(bytes) !== options.scopeHash) fail('HISTORY_BATCH_SCOPE_HASH_MISMATCH');
    const scope = JSON.parse(bytes.toString('utf8')), runtime = dependencies.runtime || createRuntime(options.serverRoot);
    validateInput(scope, runtime);
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const pool = dependencies.pool || (owned = runtime.createPool(env));
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== options.database) fail('HISTORY_BATCH_DATABASE_MISMATCH');
    output = await fs.open(options.output, 'wx', 0o600);
    const directory = await fs.open(path.dirname(path.resolve(options.output)), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    const run = { databasePool: pool, actorUserId: options.actor,
      fetchImpl: getOnly(schemaReadCache(dependencies.fetchImpl || globalThis.fetch, options.schemaCacheSeconds)),
      sensitiveValues: runtime.databaseSecrets(env) };
    const append = async value => {
      const artifact = { contract: 'first-sync-history-batch-journal-v1', at: new Date().toISOString(), ...value };
      runtime.audit.assertEvidenceSafe(artifact, config, run.sensitiveValues);
      const data = Buffer.from(JSON.stringify(artifact) + '\n');
      if ((await output.stat()).size + data.length > MAX_BYTES) fail('HISTORY_BATCH_OUTPUT_LIMIT');
      for (let offset = 0; offset < data.length;) {
        const { bytesWritten } = await output.write(data, offset, data.length - offset, null);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) fail('HISTORY_BATCH_JOURNAL_WRITE_FAILED');
        offset += bytesWritten;
      }
      await output.sync();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    await append({ type: 'start', mode: options.mode, scopeHash: options.scopeHash, actorUserId: options.actor, database: options.database, scope });
    const results = [];
    for (const item of scope.items) {
      const result = await runItem(runtime, config, item, scope, run, { mode: options.mode, append, stopping: () => interrupted });
      unconfirmed = ['recorded', 'unconfirmed'].includes(result.status);
      await append({ type: 'receipt', ...result });
      unconfirmed = result.status === 'unconfirmed'; results.push(result);
      print(JSON.stringify({ sku: result.sku, status: result.status, checked: results.length, total: scope.items.length }));
      // Preview writes nothing: --preview-all reports every item-level blocker in one run.
      const continuable = options.previewAll && result.status === 'blocked' && !GLOBAL.test(result.code || '');
      if (!['recorded', 'already_admitted', 'available'].includes(result.status) && !continuable || interrupted) break;
    }
    const summary = { type: 'complete', mode: options.mode, scopeHash: options.scopeHash, total: scope.items.length,
      checked: results.length, notChecked: scope.items.length - results.length,
      ...Object.fromEntries(['recorded', 'already_admitted', 'available', 'blocked', 'unconfirmed'].map(status => [status, results.filter(r => r.status === status).length])),
      complete: results.length === scope.items.length && results.every(r => ['recorded', 'already_admitted', 'available'].includes(r.status)),
      directRemoteWrites: 0, directlyEnqueuedJobs: 0 };
    await append(summary); print(JSON.stringify({ ...summary, output: options.output })); return summary.complete ? 0 : 2;
  } catch (e) { printError(JSON.stringify({ ok: false, code: safeCode(e), ...(unconfirmed ? { localResultUnconfirmed: true } : {}) })); return 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (output) await output.close().catch(() => {});
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, validateInput, getOnly, identityPreview, runItem, main, createRuntime, MAX_ITEMS };
