'use strict';
// Bounded initial-name receipts through the complete canonical first-sync plan.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const names = require('./first-sync-campaign-names');
const campaignPreview = require('./first-sync-campaign-preview');
const plan = require('./first-sync-initial-name-plan');
const { runNameCommit } = require('./first-sync-name-commit');
const MAX_INPUT = 4 * 1024 * 1024, MAX_REVIEW = 32 * 1024 * 1024;
const REVIEW = 'first-sync-initial-names-review-v1', JOURNAL = 'first-sync-initial-names-journal-v1';
const deliveryEffect = names.deliveryEffect;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const safeCode = error => error?.code === 'EEXIST' ? 'INITIAL_NAMES_OUTPUT_EXISTS'
  : typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'INITIAL_NAMES_FAILED';
const brief = blockers => (blockers || []).map(row => Object.fromEntries(['code', 'target', 'scope', 'reason']
  .filter(key => typeof row[key] === 'string').map(key => [key, row[key]])));
const globalFailure = code => /PUBLICATION|BINDING_CHANGED|PERMISSION|ACTOR|ADMINISTRATOR|AUTHORI|CUTOVER_PREPARING/.test(code);
const HELP = 'node first-sync-initial-names.js --mode preview --input SCOPE.json --scope-sha256 RAW_SHA256 '
  + '--output NEW_DIRECTORY --server-root SERVER --expected-database NAME --actor-id ID\n'
  + 'Apply/resume: --mode apply|resume --review PREVIEW_DIRECTORY --review-sha256 RAW_REVIEW_SHA256 '
  + '--output RUN_DIRECTORY --server-root SERVER --expected-database NAME --actor-id ID\n'
  + 'Exact reviewed legacy first-sync names only, with existing history admission. Preview is read-only. '
  + 'No price/SEO choices, history admission, direct enqueue or Magento writes. ' + deliveryEffect.ordinaryAutomaticRequest;
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--input': 'input', '--scope-sha256': 'scopeHash', '--review': 'review',
    '--review-sha256': 'reviewHash', '--output': 'output', '--server-root': 'serverRoot',
    '--expected-database': 'database', '--actor-id': 'actor' }, out = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = flags[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('INITIAL_NAMES_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply', 'resume'].includes(out.mode) || !out.output || !out.database
    || !/^[1-9][0-9]*$/.test(out.actor || '') || !positive(Number(out.actor))) fail('INITIAL_NAMES_ARGUMENTS');
  if (out.mode === 'preview' ? !out.input || !hex(out.scopeHash) || out.review || out.reviewHash
    : !out.review || !hex(out.reviewHash) || out.input || out.scopeHash) fail('INITIAL_NAMES_ARGUMENTS');
  out.actor = Number(out.actor); out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  out.output = path.resolve(out.output); return out;
}
function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  return { ...names.createRuntime(serverRoot), preview: local('./src/services/magento/sync-preview').previewProduct };
}
async function readBytes(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('INITIAL_NAMES_FILE_LIMIT');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break; size += read.bytesRead;
    }
    if (size > limit || size !== stat.size) fail('INITIAL_NAMES_FILE_LIMIT');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(directory, file, bytes) {
  const handle = await fs.open(path.join(directory, file), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(directory);
}
function jsonBytes(value, runtime, config, secrets) {
  runtime.audit.assertEvidenceSafe(value, config, secrets);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > MAX_REVIEW) fail('INITIAL_NAMES_FILE_LIMIT'); return bytes;
}
async function implementationHash(serverRoot, runtime) {
  return runtime.c.hash({ names: await names.implementationHash(serverRoot, runtime),
    files: await Promise.all([__filename, require.resolve('./first-sync-initial-name-plan')]
      .map(async file => hash(await fs.readFile(file)))) });
}
function validateReview(review, scope, cli, runtime, codeHash) {
  runtime.c.command(review, ['contract', 'readOnly', 'scopeSha256', 'scopeHash', 'actorUserId', 'database',
    'installationKey', 'publication', 'implementationHash', 'deliveryEffect', 'complete', 'globalFailure',
    'results', 'counts']);
  const publication = review.publication;
  runtime.c.command(publication, ['bindingRevisionId', 'expectedDefinitionHash', 'publicationHash']);
  if (review.contract !== REVIEW || review.readOnly !== true || review.complete !== true || review.globalFailure !== null
    || review.actorUserId !== cli.actor || review.database !== cli.database || review.installationKey !== scope.installationKey
    || review.implementationHash !== codeHash || !same(runtime, review.deliveryEffect, deliveryEffect)
    || review.scopeHash !== runtime.c.hash(scope) || !hex(review.scopeSha256)
    || publication.bindingRevisionId !== scope.bindingRevisionId || publication.expectedDefinitionHash !== scope.expectedDefinitionHash
    || !hex(publication.publicationHash) || !Array.isArray(review.results) || review.results.length !== scope.items.length)
    fail('INITIAL_NAMES_REVIEW_INVALID');
  const selections = [];
  for (const [index, row] of review.results.entries()) {
    const item = scope.items[index];
    if (row?.index !== index || row.sku !== item.sku || !['available', 'blocked'].includes(row.status)) fail('INITIAL_NAMES_REVIEW_INVALID');
    if (row.status === 'available') {
      runtime.c.command(row, ['index', 'sku', 'status', 'selection']);
      const selection = row.selection;
      if (!selection || selection.item?.sku !== item.sku || selection.item.expectedProduct?.id !== item.productId
        || selection.item.remoteProductId !== item.remoteProductId || !hex(selection.scopeHash)
        || selection.report?.applyInput?.sku !== item.sku || !hex(selection.report.applyInput.previewToken)) fail('INITIAL_NAMES_REVIEW_INVALID');
      const { scopeHash, ...rest } = selection;
      if (runtime.c.hash(rest) !== scopeHash) fail('INITIAL_NAMES_REVIEW_INVALID'); selections.push(selection);
    } else {
      runtime.c.command(row, ['index', 'sku', 'status', 'code', 'ordinaryBlockers', 'firstSyncBlockers']);
      if (safeCode(row) !== row.code || !Array.isArray(row.ordinaryBlockers) || !Array.isArray(row.firstSyncBlockers)) fail('INITIAL_NAMES_REVIEW_INVALID');
    }
  }
  const counts = { total: scope.items.length, checked: scope.items.length, selected: selections.length,
    blocked: scope.items.length - selections.length, notChecked: 0 };
  if (!same(runtime, review.counts, counts)) fail('INITIAL_NAMES_REVIEW_INVALID'); return selections;
}
async function loadReview(cli, runtime, codeHash) {
  try {
    await fs.lstat(path.join(cli.review, 'preview.lock'));
    fail('INITIAL_NAMES_REVIEW_INCOMPLETE');
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const bytes = await readBytes(path.join(cli.review, 'review.json'), MAX_REVIEW);
  if (hash(bytes) !== cli.reviewHash) fail('INITIAL_NAMES_REVIEW_HASH_CHANGED');
  const review = JSON.parse(bytes.toString('utf8'));
  const scopeBytes = await readBytes(path.join(cli.review, 'scope.json'), MAX_INPUT);
  if (hash(scopeBytes) !== review.scopeSha256) fail('INITIAL_NAMES_SCOPE_HASH_CHANGED');
  const scope = JSON.parse(scopeBytes.toString('utf8')); plan.validateScope(scope, runtime);
  const selections = validateReview(review, scope, cli, runtime, codeHash);
  return { review, scope, selections };
}
async function previewItem(runtime, config, scope, item, run, authority, stopping) {
  let report, base;
  try {
    await authority(); if (stopping()) fail('INITIAL_NAMES_INTERRUPTED');
    let observation;
    report = await runtime.preview(config, { ...run, sku: item.sku, bindingRevisionId: scope.bindingRevisionId,
      onObservation: value => { observation = value; } });
    if (!observation) fail('INITIAL_NAMES_OBSERVATION_REQUIRED');
    base = await runtime.first.inspect(config, observation, run);
    const selection = plan.selectionFor(runtime, scope, item, base, report, run);
    await authority(); if (stopping()) fail('INITIAL_NAMES_INTERRUPTED');
    return { sku: item.sku, status: 'available', selection };
  } catch (cause) {
    if (cause.authorityFailure || globalFailure(safeCode(cause)) || stopping()) throw cause;
    return { sku: item.sku, status: 'blocked', code: safeCode(cause),
      ordinaryBlockers: brief(report?.blockers), firstSyncBlockers: brief(base?.blockers) };
  }
}
async function runItem(runtime, config, scope, selected, run, { append, authority, commit = runNameCommit, stopping = () => false }) {
  let entered = false, proof;
  try {
    await authority(); if (stopping()) fail('INITIAL_NAMES_INTERRUPTED');
    return await runtime.boundary.guard(config, { sku: selected.item.sku, bindingRevisionId: scope.bindingRevisionId }, run, async state => {
      const { observation, report } = await runtime.boundary.observe(config,
        { sku: selected.item.sku, bindingRevisionId: scope.bindingRevisionId }, run);
      const base = await runtime.first.inspect(config, observation, run);
      const item = scope.items.find(row => row.sku === selected.item.sku);
      plan.selectionFor(runtime, scope, item, base, report, run, { expected: selected });
      proof = names.commitProof(runtime, base, run);
      await authority(); if (stopping()) fail('INITIAL_NAMES_INTERRUPTED');
      await append({ type: 'prepared', sku: item.sku, scopeHash: selected.scopeHash, proof, deliveryEffect });
      if (stopping()) fail('INITIAL_NAMES_INTERRUPTED');
      entered = true;
      const result = await commit(runtime, config, state, base, { ...run, stopping });
      if (!names.expectedReceipt(runtime, selected, proof, result)) throw Object.assign(Error('Unconfirmed receipt'), { unconfirmed: true });
      return { sku: item.sku, scopeHash: selected.scopeHash, status: 'recorded', proof, result, deliveryEffect };
    });
  } catch (cause) {
    if (cause.journalFailure) throw cause;
    const unconfirmed = cause.unconfirmed === true || entered && !cause.nameCommitNotStarted && !cause.nameCommitRolledBack;
    return { sku: selected.item.sku, scopeHash: selected.scopeHash, status: unconfirmed ? 'unconfirmed' : 'blocked',
      code: safeCode(cause), ...(proof ? { proof } : {}), deliveryEffect, stop: true };
  }
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, journal, lock, lockPath, retainLock = false, reviewSealed = false, uncertain = false, interrupted = false;
  const abort = new AbortController(), stop = () => { interrupted = true; abort.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    const codeHash = await (dependencies.implementationHash || implementationHash)(cli.serverRoot, runtime);
    let scope, scopeBytes, loaded;
    if (cli.mode === 'preview') {
      scopeBytes = await readBytes(cli.input, MAX_INPUT);
      if (hash(scopeBytes) !== cli.scopeHash) fail('INITIAL_NAMES_SCOPE_HASH_CHANGED');
      scope = JSON.parse(scopeBytes.toString('utf8')); plan.validateScope(scope, runtime);
    } else { loaded = await loadReview(cli, runtime, codeHash); scope = loaded.scope; }
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const secrets = runtime.pool.databaseSecrets(env);
    runtime.audit.assertEvidenceSafe(scope, config, secrets);
    const databasePool = dependencies.pool || (owned = cli.mode === 'preview'
      ? runtime.pool.createReadOnlyPool(env) : runtime.createPool(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('INITIAL_NAMES_DATABASE_MISMATCH');
    if (cli.mode === 'preview' && (await databasePool.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only !== 'on')
      fail('INITIAL_NAMES_READ_ONLY_DATABASE_REQUIRED');
    const run = { databasePool, actorUserId: cli.actor, installation: scope.installationKey, sensitiveValues: secrets,
      fetchImpl: campaignPreview.getOnly((url, init = {}) => (dependencies.fetchImpl || globalThis.fetch)(url,
        { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) })) };
    let publication = loaded?.review.publication;
    const authority = async () => {
      try {
        if (interrupted) fail('INITIAL_NAMES_INTERRUPTED');
        const fresh = await (dependencies.readAuthority || campaignPreview.readAuthority)(runtime, config, run);
        if (fresh.bindingRevisionId !== scope.bindingRevisionId || fresh.expectedDefinitionHash !== scope.expectedDefinitionHash
          || publication && !same(runtime, publication, fresh)) fail('INITIAL_NAMES_PUBLICATION_CHANGED');
        publication ||= fresh; return fresh;
      } catch (cause) { cause.authorityFailure = true; throw cause; }
    };
    await authority();
    if (cli.mode !== 'resume') { await fs.mkdir(cli.output, { mode: 0o700 }); await syncDirectory(path.dirname(cli.output)); }
    else { const stat = await fs.lstat(cli.output); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INITIAL_NAMES_OUTPUT_INVALID'); }
    if (cli.mode === 'preview') {
      lockPath = path.join(cli.output, 'preview.lock'); lock = await fs.open(lockPath, 'wx', 0o600);
      await lock.sync(); await syncDirectory(cli.output);
      await writeNew(cli.output, 'scope.json', scopeBytes);
      journal = await fs.open(path.join(cli.output, 'results.jsonl'), 'wx', 0o600); await syncDirectory(cli.output);
      const metadata = { contract: REVIEW, readOnly: true, scopeSha256: cli.scopeHash, scopeHash: runtime.c.hash(scope),
        actorUserId: cli.actor, database: cli.database, installationKey: scope.installationKey, publication,
        implementationHash: codeHash, deliveryEffect };
      const append = row => names.durableWrite(journal, row, runtime, config, secrets);
      await append({ type: 'start', ...metadata });
      const results = []; let failure = null;
      try {
        for (const [index, item] of scope.items.entries()) {
          const row = { index, ...await previewItem(runtime, config, scope, item, run, authority, () => interrupted) };
          await append({ type: 'result', ...row }); results.push(row);
          print(JSON.stringify({ sku: item.sku, status: row.status, checked: results.length, total: scope.items.length }));
        }
        await authority();
      } catch (cause) { if (cause.journalFailure) throw cause; failure = safeCode(cause); }
      const review = { ...metadata, complete: failure === null && results.length === scope.items.length,
        globalFailure: failure, results, counts: { total: scope.items.length, checked: results.length,
          selected: results.filter(row => row.status === 'available').length, blocked: results.filter(row => row.status === 'blocked').length,
          notChecked: scope.items.length - results.length } };
      const bytes = jsonBytes(review, runtime, config, secrets);
      await append({ type: 'summary', complete: review.complete, globalFailure: failure, counts: review.counts });
      await writeNew(cli.output, 'review.json', bytes);
      reviewSealed = true;
      await lock.close(); lock = null;
      await fs.unlink(lockPath); await syncDirectory(cli.output);
      print(JSON.stringify({ complete: review.complete, readOnly: true, globalFailure: failure, counts: review.counts,
        review: path.join(cli.output, 'review.json'), reviewSha256: hash(bytes), deliveryEffect }));
      return failure || review.counts.blocked || review.counts.notChecked ? 2 : 0;
    }
    const selections = loaded.selections;
    if (!selections.length) fail('INITIAL_NAMES_NO_SELECTIONS');
    lockPath = path.join(cli.output, 'run.lock'); lock = await fs.open(lockPath, 'wx', 0o600);
    await lock.sync(); await syncDirectory(cli.output);
    const header = { type: 'start', contract: JOURNAL, mode: 'apply', reviewSha256: cli.reviewHash,
      scopeHash: runtime.c.hash(selections.map(row => row.scopeHash)), actorUserId: cli.actor, database: cli.database,
      installationKey: scope.installationKey, publication, implementationHash: codeHash, deliveryEffect };
    const file = path.join(cli.output, 'results.jsonl');
    const results = cli.mode === 'resume' ? names.readJournal(await readBytes(file, MAX_REVIEW), header, selections, runtime) : [];
    for (const [index, receipt] of results.entries())
      await (dependencies.verifyRecorded || names.verifyRecorded)(runtime, config, selections[index], receipt, run);
    await authority();
    journal = await fs.open(file, cli.mode === 'resume' ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0) : 'wx', 0o600);
    await syncDirectory(cli.output);
    const append = row => names.durableWrite(journal, row, runtime, config, secrets);
    if (cli.mode !== 'resume') await append(header);
    for (const selected of selections.slice(results.length)) {
      if (interrupted) break;
      const result = await runItem(runtime, config, scope, selected, run, { append, authority,
        commit: dependencies.runNameCommit || runNameCommit, stopping: () => interrupted });
      uncertain = ['recorded', 'unconfirmed'].includes(result.status);
      await append({ type: 'receipt', ...result }); results.push(result); uncertain = result.status === 'unconfirmed';
      if (uncertain) retainLock = true;
      print(JSON.stringify({ sku: result.sku, status: result.status, checked: results.length, total: selections.length, deliveryEffect }));
      if (result.stop || uncertain || interrupted) break;
    }
    const summary = { type: 'summary', complete: results.length === selections.length && results.every(row => row.status === 'recorded'),
      reviewed: selections.length, checked: results.length, recorded: results.filter(row => row.status === 'recorded').length,
      blocked: results.filter(row => row.status === 'blocked').length, unconfirmed: results.filter(row => row.status === 'unconfirmed').length,
      notChecked: selections.length - results.length, previewBlocked: loaded.review.counts.blocked, readOnly: false, deliveryEffect };
    await append(summary); print(JSON.stringify({ ...summary, output: cli.output })); return summary.complete ? 0 : 2;
  } catch (cause) {
    // A readable record is not proof that its fsync succeeded. Preserve the
    // durable pre-work marker after any output failure or uncertain commit.
    if (lock) retainLock = true;
    printError(JSON.stringify({ complete: false, code: safeCode(cause), ...(reviewSealed ? { reviewSealed: true } : {}),
      ...(uncertain ? { localResultUnconfirmed: true } : {}), deliveryEffect })); return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      if (!retainLock) { await fs.unlink(lockPath).catch(() => {}); await syncDirectory(path.dirname(lockPath)).catch(() => {}); }
    }
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, createRuntime, implementationHash, validateReview, loadReview, previewItem, runItem, main, deliveryEffect };
