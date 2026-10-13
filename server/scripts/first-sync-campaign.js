// Sequential orchestration of sealed canonical packet reviews; no app startup.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const preview = require('./first-sync-campaign-preview');
const discovery = require('./first-sync-local-discovery');
const MAX_JOURNAL = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'CAMPAIGN_FAILED';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = field => field.scope + '/' + field.target;
const HELP = 'node first-sync-campaign.js --mode apply|resume --review DIRECTORY --review-sha256 RAW_SHA256 '
  + '--output JOURNAL_DIRECTORY --server-root SERVER --expected-database NAME --actor-id ID --installation-key KEY\n'
  + 'Uses sealed selections from first-sync-campaign-preview. Only canonical approved local choices; no imports, enqueue or Magento writes. '
  + 'Optional --stage discovery|history|review|choices delegates to the matching bundled helper. '
  + 'Resume skips durable confirmed receipts and retained blockers. Any unresolved prepared intent or unconfirmed result stops without retry.';
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--review': 'review', '--review-sha256': 'reviewHash', '--output': 'output',
    '--server-root': 'serverRoot', '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], value = args[i + 1];
    if (!name || Object.hasOwn(out, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('CAMPAIGN_ARGUMENTS');
    out[name] = value;
  }
  if (!['apply', 'resume'].includes(out.mode) || !out.review || !out.output || !out.database || !out.installation
    || !hex(out.reviewHash) || !/^[1-9][0-9]*$/.test(out.actor || '') || !Number.isSafeInteger(Number(out.actor))) fail('CAMPAIGN_ARGUMENTS');
  out.actor = Number(out.actor); out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..')); return out;
}
function globalFailure(code) {
  return /PUBLICATION|BINDING|AUTHORITY|PERMISSION|ACTOR|ADMINISTRATOR|CUTOVER|LIFECYCLE_WRITER/.test(code);
}
function selectedCommands(runtime, review, plans) {
  const commands = [];
  for (const plan of plans) for (const selection of plan.selections) {
    const item = plan.request.items.find(candidate => candidate.sku === selection.sku);
    if (!item || selection.commandSha256 !== runtime.c.hash(selection.applyInput)) fail('CAMPAIGN_SELECTION_INVALID');
    commands.push({ request: plan.request, item, command: selection.applyInput, commandSha256: selection.commandSha256 });
  }
  if (commands.length > 2000 || new Set(commands.map(row => row.item.sku)).size !== commands.length) fail('CAMPAIGN_SELECTION_INVALID');
  if (!review.complete || review.globalFailure) fail('CAMPAIGN_REVIEW_INCOMPLETE');
  return commands;
}
function expectedReceipt(runtime, command, result) {
  return result?.sku === command.sku && runtime.c.hash(result.choices) === runtime.c.hash(command.choices)
    && typeof result.receipt?.sessionId === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.receipt.sessionId)
    && typeof result.receipt.revision === 'string' && /^[1-9][0-9]*$/.test(result.receipt.revision)
    && result.receipt.alreadyApplied === false && result.complete === false && result.readyForOutbound === true
    && runtime.c.hash(result.receipt.fields) === runtime.c.hash(command.choices.map(field => ({
      target: field.target, scope: field.scope, state: 'pending_outward_confirmation' })));
}
async function validateDecision(runtime, config, selected, base, report, choices, run) {
  if (runtime.c.hash(choices) !== runtime.c.hash(selected.command.choices) || base.previewToken !== selected.command.previewToken)
    fail('CAMPAIGN_CHOICE_CHANGED');
  runtime.batch.validatePacketDecision(base, report, selected.request, selected.item, choices);
  const identity = report?.identity;
  if (identity?.state !== 'found' || identity.observedMagentoId !== selected.item.remoteProductId
    || identity.article !== selected.item.sku || report.mode !== 'update' || report.blockers?.length)
    fail('CAMPAIGN_IDENTITY_OR_ORDINARY_CHANGED');
  for (const choice of choices) {
    const rows = (base.fields || []).filter(field => key(field) === key(choice));
    if (rows.length !== 1 || rows[0].local?.known !== true || rows[0].local.present !== true
      || rows[0].remote?.known !== true || rows[0].remote.present !== true) fail('CAMPAIGN_EMPTY_OR_UNKNOWN_FIELD');
  }
  const { prepared } = await runtime.first.prepareDecision(config, base, choices, run);
  if (!Array.isArray(prepared?.rows) || prepared.blockers?.length || prepared.readyForOutbound !== true || prepared.complete !== false)
    fail('CAMPAIGN_REMAINING_BLOCKERS');
  if (prepared.rows.some(row => !row.received && ['imported', 'name_received'].includes(row.record.state)))
    fail('CAMPAIGN_UNAPPROVED_INITIAL_IMPORT');
  for (const choice of choices) {
    const rows = prepared.rows.filter(row => key(row) === key(choice));
    if (rows.length !== 1 || rows[0].received || rows[0].record.state !== 'pending_outward_confirmation'
      || rows[0].record.source?.decision !== 'keep_local') fail('CAMPAIGN_SELECTED_TRANSITION_CHANGED');
  }
}
async function runItem(runtime, config, selected, run, { append, authority, stopping = () => false }) {
  let entered = false, validated = false, authorityChecked = false;
  try {
    if (stopping()) fail('CAMPAIGN_INTERRUPTED');
    await authority(); authorityChecked = true;
    await append({ type: 'prepared', sku: selected.item.sku, commandSha256: selected.commandSha256, command: selected.command });
    if (stopping()) {
      return { sku: selected.item.sku, commandSha256: selected.commandSha256, status: 'blocked', code: 'CAMPAIGN_INTERRUPTED' };
    }
    entered = true;
    const result = await runtime.first.apply(config, selected.command, { ...run, validateFirstSyncDecision: async (base, report, choices) => {
      await validateDecision(runtime, config, selected, base, report, choices, run);
      if (stopping()) fail('CAMPAIGN_INTERRUPTED');
      validated = true;
    } });
    if (!validated || !expectedReceipt(runtime, selected.command, result)) throw Error('Unconfirmed canonical receipt');
    return { sku: selected.item.sku, commandSha256: selected.commandSha256, status: 'recorded', result };
  } catch (error) {
    if (error.journalFailure) throw error;
    return { sku: selected.item.sku, commandSha256: selected.commandSha256,
      status: entered && !(error.statusCode >= 400 && error.statusCode < 500) ? 'unconfirmed' : 'blocked', code: safeCode(error),
      globalFailure: !authorityChecked || [401, 403].includes(error.statusCode) || globalFailure(safeCode(error)) };
  }
}
async function durableWrite(handle, value, runtime, config, secrets) {
  try {
    runtime.audit.assertEvidenceSafe(value, config, secrets);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if ((await handle.stat()).size + bytes.length > MAX_JOURNAL) fail('CAMPAIGN_JOURNAL_LIMIT');
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) fail('CAMPAIGN_JOURNAL_WRITE_FAILED'); offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) { error.journalFailure = true; throw error; }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
function readJournal(bytes, header, commands, runtime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_JOURNAL || bytes.at(-1) !== 10) fail('CAMPAIGN_JOURNAL_INCOMPLETE');
  let records;
  try { records = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)); } catch { fail('CAMPAIGN_JOURNAL_INVALID'); }
  if (runtime.c.hash(records[0]) !== runtime.c.hash(header)) fail('CAMPAIGN_JOURNAL_SCOPE_CHANGED');
  const receipts = []; let pending = false, stopped = false;
  for (const record of records.slice(1)) {
    if (record.type === 'summary') {
      // Summary is informative; only complete per-item receipt sequences authorize a skip.
      if (pending) fail('CAMPAIGN_JOURNAL_UNCONFIRMED'); continue;
    }
    if (stopped) fail('CAMPAIGN_JOURNAL_INVALID');
    const selected = commands[receipts.length];
    if (!selected || record.sku !== selected.item.sku || record.commandSha256 !== selected.commandSha256) fail('CAMPAIGN_JOURNAL_SCOPE_CHANGED');
    if (record.type === 'prepared') {
      if (pending || runtime.c.hash(record.command) !== selected.commandSha256) fail('CAMPAIGN_JOURNAL_INVALID');
      pending = true; continue;
    }
    if (record.type !== 'receipt' || !['recorded', 'blocked', 'unconfirmed'].includes(record.status)) fail('CAMPAIGN_JOURNAL_INVALID');
    if (record.status === 'recorded' && (!pending || !expectedReceipt(runtime, selected.command, record.result))) fail('CAMPAIGN_JOURNAL_INVALID');
    if (record.status === 'unconfirmed') fail('CAMPAIGN_JOURNAL_UNCONFIRMED');
    if (record.status === 'blocked' && (typeof record.code !== 'string' || safeCode(record) !== record.code)) fail('CAMPAIGN_JOURNAL_INVALID');
    pending = false; receipts.push(record);
    if (record.status === 'blocked' && (record.globalFailure === true || globalFailure(record.code))) stopped = true;
  }
  if (pending) fail('CAMPAIGN_JOURNAL_UNCONFIRMED');
  if (stopped) fail('CAMPAIGN_GLOBAL_FAILURE_REQUIRES_NEW_REVIEW');
  return receipts;
}
async function readLimited(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_JOURNAL) fail('CAMPAIGN_JOURNAL_LIMIT');
    const bytes = await handle.readFile(); if (bytes.length > MAX_JOURNAL) fail('CAMPAIGN_JOURNAL_LIMIT'); return bytes;
  } finally { await handle.close(); }
}
async function implementationHash(serverRoot, runtime) {
  const localFiles = [__filename, require.resolve('./first-sync-campaign-preview'), require.resolve('./first-sync-local-discovery')];
  const services = ['first-sync.service', 'first-sync-batch-preflight', 'first-sync-ledger', 'first-sync-local-authority',
    'first-sync-eligibility', 'first-sync-field-plan', 'first-sync-progress-plan'];
  const values = [];
  for (const file of [...localFiles, ...services.map(name => path.join(serverRoot, 'src/services/magento', name + '.js'))])
    values.push(hash(await fs.readFile(file)));
  return runtime.c.hash(values);
}
async function verifyRecorded(runtime, config, selected, receipt, run) {
  // A journal skip acknowledges only this immutable historical commit. It is not
  // proof of current field readiness, history admission, or outward delivery.
  const previewHash = runtime.c.hash({ previewToken: selected.command.previewToken, choices: selected.command.choices });
  const row = (await run.databasePool.query(`SELECT p.preview_hash,p.command_hash,p.command,p.result,p.actor_user_id,
    s.public_sku,s.installation_key,s.remote_product_id,s.origin_hash
    FROM magento_first_sync_progress p JOIN magento_first_sync_sessions s ON s.id=p.session_id
    WHERE p.session_id=$1 AND p.revision=$2 AND p.preview_hash=$3`,
  [receipt.result.receipt.sessionId, receipt.result.receipt.revision, previewHash])).rows[0];
  if (!row || row.preview_hash !== previewHash || row.command_hash !== runtime.c.hash(row.command) || Number(row.actor_user_id) !== run.actorUserId
    || row.public_sku !== selected.item.sku || row.installation_key !== run.installation
    || Number(row.remote_product_id) !== selected.item.remoteProductId || row.origin_hash !== runtime.c.originHash(config.baseUrl)
    || row.result?.sessionId !== receipt.result.receipt.sessionId || row.result?.revision !== receipt.result.receipt.revision
    || row.result?.completed !== false || row.result?.readyForOutbound !== true || row.result?.alreadyApplied !== false
    || !Array.isArray(row.command?.fields) || !Array.isArray(row.result?.changedFields)
    || row.result.changedFields.some(field => ['imported', 'name_received'].includes(field.state))) fail('CAMPAIGN_RECORDED_RECEIPT_UNCONFIRMED');
  for (const choice of selected.command.choices) {
    const fields = row.command.fields.filter(field => key(field) === key(choice));
    if (fields.length !== 1 || fields[0].state !== 'pending_outward_confirmation' || fields[0].source?.decision !== 'keep_local')
      fail('CAMPAIGN_RECORDED_RECEIPT_UNCONFIRMED');
  }
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, journal, lock, lockPath, unconfirmed = false, interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || preview.createRuntime(cli.serverRoot);
    const loaded = await (dependencies.loadReview || preview.loadReview)(cli.review, cli.reviewHash, runtime, cli);
    const { review, plans } = loaded, commands = selectedCommands(runtime, review, plans);
    const config = dependencies.config || runtime.config.parseMagentoConfig(env); if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const secrets = runtime.pool.databaseSecrets(env);
    const databasePool = dependencies.pool || (owned = runtime.createPool(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CAMPAIGN_DATABASE_MISMATCH');
    const run = { databasePool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: secrets, fetchImpl: preview.getOnly(dependencies.fetchImpl || globalThis.fetch) };
    const authority = async () => {
      const fresh = await (dependencies.readAuthority || discovery.readAuthority)(runtime, config, run);
      if (runtime.c.hash(fresh) !== runtime.c.hash(review.publication)) fail('CAMPAIGN_PUBLICATION_CHANGED');
    };
    await authority();
    const header = { contract: 'first-sync-campaign-journal-v1', type: 'start', reviewSha256: cli.reviewHash,
      actorUserId: cli.actor, database: cli.database, installationKey: cli.installation,
      publication: review.publication, implementationSha256: await (dependencies.implementationHash || implementationHash)(cli.serverRoot, runtime),
      total: commands.length, commandsSha256: runtime.c.hash(commands.map(row => row.commandSha256)) };
    if (cli.mode === 'apply') await fs.mkdir(cli.output, { mode: 0o700 });
    lockPath = path.join(cli.output, 'run.lock'); lock = await fs.open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, reviewSha256: cli.reviewHash }) + '\n'); await lock.sync(); await syncDirectory(cli.output);
    const file = path.join(cli.output, 'receipts.jsonl');
    const results = cli.mode === 'resume' ? readJournal(await readLimited(file), header, commands, runtime) : [];
    for (const [index, receipt] of results.entries()) if (receipt.status === 'recorded')
      await (dependencies.verifyRecorded || verifyRecorded)(runtime, config, commands[index], receipt, run);
    await authority();
    journal = await fs.open(file, cli.mode === 'resume' ? 'a' : 'wx', 0o600);
    await syncDirectory(cli.output);
    const append = value => durableWrite(journal, value, runtime, config, secrets);
    if (cli.mode === 'apply') await append(header);
    for (const selected of commands.slice(results.length)) {
      if (interrupted) break;
      const result = await runItem(runtime, config, selected, run, { append, authority, stopping: () => interrupted });
      unconfirmed = ['recorded', 'unconfirmed'].includes(result.status);
      await append({ type: 'receipt', ...result }); results.push(result); unconfirmed = result.status === 'unconfirmed';
      print(JSON.stringify({ sku: result.sku, status: result.status, checked: results.length, total: commands.length }));
      if (unconfirmed || result.status === 'blocked' && (result.globalFailure || globalFailure(result.code)) || interrupted) break;
    }
    const exceptions = results.filter(result => result.status !== 'recorded').map(result => ({ sku: result.sku, code: result.code }));
    const summary = { type: 'summary', complete: results.length === commands.length && !unconfirmed && !results.some(row => row.globalFailure),
      allRecorded: results.length === commands.length && results.every(result => result.status === 'recorded'),
      reviewed: commands.length, checked: results.length, recorded: results.filter(result => result.status === 'recorded').length,
      blocked: results.filter(result => result.status === 'blocked').length, unconfirmed: results.filter(result => result.status === 'unconfirmed').length,
      notChecked: commands.length - results.length, exceptions, directRemoteWrites: 0, directlyEnqueuedJobs: 0 };
    await append(summary); print(JSON.stringify({ ...summary, output: cli.output })); return summary.allRecorded ? 0 : 2;
  } catch (error) {
    printError(JSON.stringify({ complete: false, code: safeCode(error), ...(unconfirmed ? { localResultUnconfirmed: true } : {}),
      directRemoteWrites: 0, directlyEnqueuedJobs: 0 })); return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (lock) { await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
    if (owned) await owned.end().catch(() => {});
  }
}
async function dispatch(args = process.argv.slice(2), dependencies = {}) {
  if (args[0] !== '--stage') return main(args, dependencies);
  const stages = { discovery: './first-sync-local-discovery', review: './first-sync-campaign-preview',
    history: './first-sync-campaign-history' };
  if (args[1] === 'choices') return main(args.slice(2), dependencies);
  if (!Object.hasOwn(stages, args[1])) {
    (dependencies.printError || console.error)(JSON.stringify({ complete: false, code: 'CAMPAIGN_STAGE_INVALID' })); return 1;
  }
  return require(stages[args[1]]).main(args.slice(2), dependencies);
}
if (require.main === module) dispatch().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, selectedCommands, expectedReceipt, validateDecision, runItem, durableWrite, readJournal, main, globalFailure, hash, implementationHash, verifyRecorded, dispatch };
