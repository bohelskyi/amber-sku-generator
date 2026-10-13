// Sequential history admission orchestration over the unchanged canonical adapter.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const history = require('./first-sync-history-batch');
const MAX_ITEMS = 2000;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_JOURNAL = 32 * 1024 * 1024;
const CONTRACT = 'first-sync-campaign-history-journal-v1';
const SCOPE = 'first_sync_review_only';
const EVENT = 'product.magento_first_sync_cutover_reviewed';
const KNOWN_BLOCKERS = new Set(['HISTORY_BATCH_ADMISSION_NOT_AVAILABLE', 'HISTORY_BATCH_EXISTING_ADMISSION_UNCONFIRMED',
  'HISTORY_BATCH_IDENTITY_CHANGED', 'HISTORY_BATCH_SOURCE_CHANGED', 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const auditId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const fail = code => { throw Object.assign(Error(code), { code }); };
const safeCode = cause => cause?.code === 'EEXIST' ? 'CAMPAIGN_HISTORY_OUTPUT_EXISTS'
  : typeof cause?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(cause.code) ? cause.code : 'CAMPAIGN_HISTORY_FAILED';
const HELP = 'node first-sync-campaign-history.js --mode preview|apply|resume --input SCOPE.json '
  + '--scope-sha256 RAW_SHA256 --output DIRECTORY --server-root SERVER_ROOT --expected-database NAME --actor-id ID\n'
  + 'Exact 1..2000 history candidates; sequential unchanged canonical review/admission. '
  + 'Known per-SKU blockers are retained; global or unknown failures stop. '
  + 'Resume skips confirmed historical receipts and retained exceptions only. '
  + 'Unconfirmed, unfinished, truncated journals and stale locks require reconciliation. No enqueue or remote writes.';
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--input': 'input', '--scope-sha256': 'scopeHash', '--output': 'output',
    '--server-root': 'serverRoot', '--expected-database': 'database', '--actor-id': 'actor' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('CAMPAIGN_HISTORY_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply', 'resume'].includes(out.mode) || !out.input || !out.output || !out.database
    || !hex(out.scopeHash) || !/^[1-9][0-9]*$/.test(out.actor || '') || !Number.isSafeInteger(Number(out.actor)))
    fail('CAMPAIGN_HISTORY_ARGUMENTS');
  out.actor = Number(out.actor);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  out.output = path.resolve(out.output);
  return out;
}
function validateInput(scope, runtime) {
  if (!scope || !Array.isArray(scope.items) || !scope.items.length || scope.items.length > MAX_ITEMS
    || Object.keys(scope.items).length !== scope.items.length) fail('CAMPAIGN_HISTORY_INPUT_INVALID');
  // Keep the existing exact schema and its 50-product bound. The aggregate only
  // partitions validation; every domain operation still uses history.runItem.
  for (let offset = 0; offset < scope.items.length; offset += history.MAX_ITEMS)
    history.validateInput({ ...scope, items: scope.items.slice(offset, offset + history.MAX_ITEMS) }, runtime);
  for (const key of ['sku', 'productId', 'remoteProductId'])
    if (new Set(scope.items.map(item => item[key])).size !== scope.items.length) fail('CAMPAIGN_HISTORY_DUPLICATE_IDENTITY');
}
function globalFailure(code) {
  return typeof code === 'string' && /PUBLICATION|PUBLISHED_CURRENT_BINDING|BINDING_CHANGED|DEFINITION_CHANGED|PERMISSION|ACTOR|ADMINISTRATOR|AUTHORI|CUTOVER|LIFECYCLE_WRITER/.test(code);
}
function continueAfter(result) {
  return ['recorded', 'already_admitted', 'available'].includes(result.status)
    || result.status === 'blocked' && KNOWN_BLOCKERS.has(result.code) && !globalFailure(result.code);
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readLimited(file, limit = MAX_FILE) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('CAMPAIGN_HISTORY_FILE_LIMIT');
  const handle = await fs.open(file, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > limit) fail('CAMPAIGN_HISTORY_FILE_LIMIT');
    const data = Buffer.alloc(limit + 1); let size = 0;
    while (size < data.length) {
      const read = await handle.read(data, size, data.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) fail('CAMPAIGN_HISTORY_FILE_LIMIT');
    return data.subarray(0, size);
  } finally { await handle.close(); }
}
async function writeNew(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function durableWrite(handle, record, runtime, config, secrets) {
  try {
    runtime.audit.assertEvidenceSafe(record, config, secrets);
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > MAX_FILE || (await handle.stat()).size + bytes.length > MAX_JOURNAL)
      fail('CAMPAIGN_HISTORY_JOURNAL_LIMIT');
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) fail('CAMPAIGN_HISTORY_JOURNAL_WRITE_FAILED');
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (cause) { cause.journalFailure = true; throw cause; }
}
function validDiagnostics(record) {
  return hex(record.sourceHash) && hex(record.publicationHash) && Array.isArray(record.ordinaryBlockers)
    && record.ordinaryBlockers.every(row => row && Object.keys(row).length === 1
      && typeof row.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(row.code));
}
function readJournal(bytes, header, scope, runtime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_JOURNAL || bytes.at(-1) !== 10)
    fail('CAMPAIGN_HISTORY_JOURNAL_INCOMPLETE');
  let records;
  try {
    const lines = bytes.toString('utf8').slice(0, -1).split('\n');
    if (lines.some(line => Buffer.byteLength(line, 'utf8') + 1 > MAX_FILE)) fail('CAMPAIGN_HISTORY_FILE_LIMIT');
    records = lines.map(line => JSON.parse(line));
  } catch { fail('CAMPAIGN_HISTORY_JOURNAL_INVALID'); }
  if (runtime.c.hash(records[0]) !== runtime.c.hash(header)) fail('CAMPAIGN_HISTORY_JOURNAL_SCOPE_CHANGED');
  const results = []; let pending = null, stopped = false;
  for (const record of records.slice(1)) {
    if (!record || record.contract !== CONTRACT) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
    if (record.type === 'complete') {
      if (pending || record.checked !== results.length || record.total !== scope.items.length
        || record.scopeSha256 !== header.scopeSha256) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      continue;
    }
    if (stopped) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
    const item = scope.items[results.length];
    if (!item || record.index !== results.length
      || ['sku', 'productId', 'remoteProductId'].some(key => record[key] !== item[key])) fail('CAMPAIGN_HISTORY_JOURNAL_SCOPE_CHANGED');
    if (record.type === 'prepared') {
      const command = record.command;
      if (pending || !command || Object.keys(command).sort().join(',') !== 'bindingRevisionId,previewToken,sku'
        || command.sku !== item.sku || command.bindingRevisionId !== scope.bindingRevisionId || !hex(command.previewToken)
        || !validDiagnostics(record)) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      pending = record; continue;
    }
    if (record.type !== 'receipt' || !['recorded', 'already_admitted', 'available', 'blocked', 'unconfirmed'].includes(record.status))
      fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
    if (record.status === 'unconfirmed') fail('CAMPAIGN_HISTORY_JOURNAL_UNCONFIRMED');
    if (record.status === 'blocked') {
      if (safeCode(record) !== record.code) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      if (record.previewToken !== undefined && record.previewToken !== pending?.command.previewToken)
        fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      if (!KNOWN_BLOCKERS.has(record.code) && record.code !== 'HISTORY_BATCH_INTERRUPTED' || globalFailure(record.code)) stopped = true;
    } else {
      if (!validDiagnostics(record)) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      if (record.status === 'available') {
        if (header.mode !== 'preview' || !pending) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      } else {
        if (record.scope !== SCOPE || record.doesNotAcknowledgeExport !== true) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
        if (record.existing) {
          if (record.status !== 'already_admitted' || pending || record.receipt !== undefined
            || record.existing.verifiedCurrentAdmission !== true || !auditId(record.existing.rootAuditEventId))
            fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
        } else if (!pending || !auditId(record.receipt?.auditEventId)
          || record.receipt.alreadyApplied !== (record.status === 'already_admitted')) fail('CAMPAIGN_HISTORY_JOURNAL_INVALID');
      }
    }
    results.push({ ...record, ...(pending ? { preparedCommand: pending.command } : {}) });
    pending = null;
  }
  if (pending) fail('CAMPAIGN_HISTORY_JOURNAL_UNCONFIRMED');
  if (stopped) fail('CAMPAIGN_HISTORY_STOPPED_REQUIRES_REVIEW');
  return results;
}
async function implementationHash(serverRoot, runtime) {
  const sources = [__filename, require.resolve('./first-sync-history-batch'),
    ...['first-sync.service', 'first-sync-cutover-admission', 'first-sync-history-admission', 'first-sync-eligibility',
      'first-sync-source-snapshot', 'first-sync-batch-preflight', 'sync-job.service', 'sync-job-transaction', 'sync-preview', 'recovery-history']
      .map(name => path.join(serverRoot, 'src/services/magento', name + '.js'))];
  const values = [];
  for (const file of sources) values.push(hash(await readLimited(file)));
  return runtime.c.hash(values);
}
async function verifyHistoricalReceipt(runtime, config, scope, record, pool) {
  if (!['recorded', 'already_admitted'].includes(record.status)) return;
  const id = record.receipt?.auditEventId || record.existing?.rootAuditEventId;
  const row = (await pool.query(`SELECT id::text,event_key,subject_type,subject_id,details FROM audit_events WHERE id=$1`, [id])).rows[0];
  const envelope = row?.details?.admission, identity = envelope?.identity;
  if (!row || String(row.id) !== id || row.event_key !== EVENT || row.subject_type !== 'magento_first_sync_cutover_admission'
    || !hex(row.subject_id) || row.details?.previewToken !== row.subject_id
    || row.details.remoteWrites !== 0 || row.details.enqueued !== false
    || envelope?.format !== 'magento-first-sync-cutover-admission-v1' || envelope.scope !== SCOPE
    || envelope.doesNotAcknowledgeExport !== true || identity?.productId !== record.productId
    || identity.sku !== record.sku || identity.remoteId !== record.remoteProductId
    || identity.installationKey !== scope.installationKey || identity.originHash !== runtime.c.originHash(config.baseUrl)
    || record.preparedCommand && (row.subject_id !== record.preparedCommand.previewToken || identity.bindingRevisionId !== scope.bindingRevisionId)
    || record.existing && envelope.rootAdmissionEventId !== null) fail('CAMPAIGN_HISTORY_RECORDED_RECEIPT_UNCONFIRMED');
  // This SELECT confirms the immutable historical commit only. It deliberately
  // grants no live admission, field readiness, or permission to enqueue.
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, journal, lock, lockPath, unresolved = false, interrupted = false;
  const stop = () => { interrupted = true; };
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const bytes = await (dependencies.read || readLimited)(cli.input);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE || hash(bytes) !== cli.scopeHash) fail('CAMPAIGN_HISTORY_SCOPE_HASH_MISMATCH');
    const scope = JSON.parse(bytes.toString('utf8')), runtime = dependencies.runtime || history.createRuntime(cli.serverRoot);
    validateInput(scope, runtime);
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const pool = dependencies.pool || (owned = runtime.createPool(env));
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CAMPAIGN_HISTORY_DATABASE_MISMATCH');
    const secrets = runtime.databaseSecrets(env), run = { databasePool: pool, actorUserId: cli.actor,
      sensitiveValues: secrets, fetchImpl: history.getOnly(dependencies.fetchImpl || globalThis.fetch) };
    const header = { contract: CONTRACT, type: 'start', mode: cli.mode === 'preview' ? 'preview' : 'apply',
      scopeSha256: cli.scopeHash, actorUserId: cli.actor, database: cli.database, installationKey: scope.installationKey,
      bindingRevisionId: scope.bindingRevisionId, expectedDefinitionHash: scope.expectedDefinitionHash,
      originHash: runtime.c.originHash(config.baseUrl), total: scope.items.length,
      implementationSha256: await (dependencies.implementationHash || implementationHash)(cli.serverRoot, runtime) };
    if (!hex(header.implementationSha256)) fail('CAMPAIGN_HISTORY_IMPLEMENTATION_INVALID');
    runtime.audit.assertEvidenceSafe(scope, config, secrets);
    if (cli.mode !== 'resume') await fs.mkdir(cli.output, { mode: 0o700 });
    const directory = await fs.lstat(cli.output);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('CAMPAIGN_HISTORY_OUTPUT_INVALID');
    lockPath = path.join(cli.output, 'run.lock'); lock = await fs.open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, scopeSha256: cli.scopeHash }) + '\n');
    await lock.sync(); await syncDirectory(cli.output);
    const file = path.join(cli.output, 'journal.jsonl'), savedScope = path.join(cli.output, 'scope.json');
    let results = [];
    if (cli.mode === 'resume') {
      if (!(await readLimited(savedScope)).equals(bytes)) fail('CAMPAIGN_HISTORY_SCOPE_HASH_MISMATCH');
      results = readJournal(await readLimited(file, MAX_JOURNAL), header, scope, runtime);
      for (const record of results) await verifyHistoricalReceipt(runtime, config, scope, record, pool);
    } else { await writeNew(savedScope, bytes); await syncDirectory(cli.output); }
    journal = await fs.open(file, cli.mode === 'resume' ? 'a' : 'wx', 0o600);
    await syncDirectory(cli.output);
    const append = record => durableWrite(journal, { ...record, contract: CONTRACT }, runtime, config, secrets);
    if (cli.mode !== 'resume') await append(header);
    const historicalSkipped = results.length;
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let stoppedCode = null;
    for (let index = results.length; index < scope.items.length; index++) {
      if (interrupted) { stoppedCode = 'HISTORY_BATCH_INTERRUPTED'; break; }
      const result = await history.runItem(runtime, config, scope.items[index], scope, run,
        { mode: header.mode, stopping: () => interrupted, append: async record => {
          await append({ ...record, index }); unresolved = true;
        } });
      if (['recorded', 'unconfirmed'].includes(result.status)) unresolved = true;
      await append({ type: 'receipt', index, ...result });
      unresolved = result.status === 'unconfirmed'; results.push(result);
      print(JSON.stringify({ sku: result.sku, status: result.status, checked: results.length, total: scope.items.length }));
      if (!continueAfter(result) || interrupted) { stoppedCode = interrupted ? 'HISTORY_BATCH_INTERRUPTED' : result.code || 'CAMPAIGN_HISTORY_UNKNOWN_RESULT'; break; }
    }
    const blockerGroups = new Map();
    for (const result of results.filter(row => row.status === 'blocked')) {
      const group = blockerGroups.get(result.code) || { code: result.code, known: KNOWN_BLOCKERS.has(result.code), count: 0, sampleSkus: [] };
      group.count++;
      if (group.sampleSkus.length < 10) group.sampleSkus.push(result.sku);
      blockerGroups.set(result.code, group);
    }
    const summary = { type: 'complete', scopeSha256: cli.scopeHash, mode: header.mode, total: scope.items.length,
      checked: results.length, notChecked: scope.items.length - results.length, historicalSkipped,
      ...Object.fromEntries(['recorded', 'already_admitted', 'available', 'blocked', 'unconfirmed'].map(status => [status, results.filter(row => row.status === status).length])),
      complete: !stoppedCode && results.length === scope.items.length && !unresolved,
      stoppedCode, blockerGroups: [...blockerGroups.values()].sort((a, b) => a.code.localeCompare(b.code, 'en')),
      resumeSkipsAreHistoricalOnly: true, directRemoteWrites: 0, directlyEnqueuedJobs: 0 };
    await append(summary); print(JSON.stringify({ ...summary, output: cli.output }));
    return summary.complete && !summary.blocked ? 0 : 2;
  } catch (cause) {
    printError(JSON.stringify({ ok: false, code: safeCode(cause), ...(unresolved ? { localResultUnconfirmed: true } : {}) }));
    return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (lock) {
      await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {});
      await syncDirectory(path.dirname(lockPath)).catch(() => {});
    }
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, validateInput, readJournal, main, MAX_ITEMS, hash, globalFailure, continueAfter,
  implementationHash, verifyHistoricalReceipt, durableWrite };
