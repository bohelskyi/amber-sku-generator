'use strict';
// Exact canonical first receipt of names. No local-choice or delivery command.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const preview = require('./first-sync-campaign-preview');
const campaign = require('./first-sync-campaign');
const { runNameCommit } = require('./first-sync-name-commit');
const MAX_FILE = 4 * 1024 * 1024, MAX_JOURNAL = 32 * 1024 * 1024;
const CONTRACT = 'first-sync-campaign-names-journal-v1';
const TERMINAL = new Set(['imported', 'equal', 'optional_empty', 'outward_verified', 'name_received', 'seo_received']);
const RECORD_KEYS = ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'];
const deliveryEffect = Object.freeze({ directRemoteWrites: 0, directlyEnqueuedJobs: 0,
  ordinaryAutomaticRequest: 'Canonical name source updates may create or update an ordinary automatic sync request and generation when automatic sync is enabled.' });
const HELP = 'node first-sync-campaign-names.js --mode preview|apply|resume --review DIRECTORY --review-sha256 RAW_SHA256 '
  + '--output DIRECTORY --server-root SERVER --expected-database NAME --actor-id ID --installation-key KEY\n'
  + 'Only sealed nameOnlyPreview entries; fresh exact canonical inspection; no local choices or direct enqueue/Magento writes. '
  + deliveryEffect.ordinaryAutomaticRequest + ' Unknown or unfinished outcomes stop resume without repeating the write.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const key = field => field.scope + '/' + field.target;
const ledgerKey = field => field.target + '\u0000' + field.scope;
const sorted = rows => [...rows].sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b), 'en'));
const record = field => Object.fromEntries(RECORD_KEYS.map(name => [name, field[name]]));
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const safeCode = cause => cause?.code === 'EEXIST' ? 'CAMPAIGN_NAMES_OUTPUT_EXISTS'
  : typeof cause?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(cause.code) ? cause.code : 'CAMPAIGN_NAMES_FAILED';
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--review': 'review', '--review-sha256': 'reviewHash', '--output': 'output',
    '--server-root': 'serverRoot', '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], value = args[i + 1];
    if (!name || Object.hasOwn(out, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('CAMPAIGN_NAMES_ARGUMENTS');
    out[name] = value;
  }
  if (!['preview', 'apply', 'resume'].includes(out.mode) || !out.review || !hex(out.reviewHash) || !out.output
    || !out.database || !out.installation || !/^[1-9][0-9]*$/.test(out.actor || '') || !positive(Number(out.actor)))
    fail('CAMPAIGN_NAMES_ARGUMENTS');
  out.actor = Number(out.actor); out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  out.output = path.resolve(out.output); return out;
}
function createRuntime(serverRoot) {
  const runtime = preview.createRuntime(serverRoot), local = createRequire(path.join(serverRoot, 'package.json'));
  return { ...runtime, boundary: local('./src/services/magento/sync-job.service').recoveryBoundary,
    admission: local('./src/services/magento/first-sync-cutover-admission') };
}
function selectedNames({ review, plans }, runtime) {
  if (review?.complete !== true || review.readOnly !== true || review.globalFailure !== null
    || !Array.isArray(review.nameOnlyPreview) || review.nameOnlyPreview.length > 2000
    || !Array.isArray(plans) || !Array.isArray(review.plans) || plans.length !== review.plans.length) fail('CAMPAIGN_NAMES_REVIEW_INVALID');
  const selections = [], names = [];
  for (const [index, plan] of plans.entries()) {
    const descriptor = review.plans[index];
    if (!descriptor || descriptor.file !== 'plan-' + String(index + 1).padStart(4, '0') + '.json'
      || !same(runtime, plan.publication, review.publication) || runtime.c.hash(plan) !== descriptor.sha256) fail('CAMPAIGN_NAMES_PLAN_CHANGED');
    runtime.batch.command(plan.request);
    if (plan.request.items.length > 10 || plan.request.bindingRevisionId !== review.publication.bindingRevisionId
      || plan.request.expectedDefinitionHash !== review.publication.expectedDefinitionHash) fail('CAMPAIGN_NAMES_PLAN_CHANGED');
    const projected = preview.selectReport(plan.report, plan.request, runtime);
    if (!same(runtime, projected.selections, plan.selections) || !same(runtime, projected.exceptions, plan.exceptions)) fail('CAMPAIGN_NAMES_PLAN_CHANGED');
    for (const [itemIndex, report] of plan.report.results.entries()) {
      if (!projected.exceptions.some(row => row.sku === report.sku && row.code === 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW')) continue;
      const item = plan.request.items[itemIndex];
      const namePreview = { sku: item.sku, productId: item.expectedProduct.id, remoteProductId: item.remoteProductId,
        planFile: descriptor.file, initialImports: structuredClone(report.initialImports) };
      if (!positive(namePreview.productId) || !positive(namePreview.remoteProductId)) fail('CAMPAIGN_NAMES_IDENTITY_INVALID');
      runtime.c.command(report.applyInput, ['sku', 'bindingRevisionId', 'previewToken', 'choices']);
      if (report.applyInput.sku !== item.sku || report.applyInput.bindingRevisionId !== plan.request.bindingRevisionId
        || !hex(report.applyInput.previewToken)) fail('CAMPAIGN_NAMES_COMMAND_INVALID');
      const choices = runtime.first.decisions(report.applyInput);
      if (choices.some(choice => choice.choice !== 'keep_local'
        || !['price', 'decor_weight', 'vaha_vyrobu', 'meta_title', 'meta_description'].includes(choice.target)
        || choice.scope !== 'all' && !(choice.scope === 'en' && choice.target.startsWith('meta_'))
        || !item.fields.some(field => key(field) === key(choice)))) fail('CAMPAIGN_NAMES_COMMAND_INVALID');
      const selected = { preview: namePreview, request: plan.request, item, report };
      selected.scopeHash = runtime.c.hash(selected); selections.push(selected); names.push(namePreview);
    }
  }
  if (!same(runtime, names, review.nameOnlyPreview)
    || ['sku', 'productId', 'remoteProductId'].some(name => new Set(names.map(row => row[name])).size !== names.length))
    fail('CAMPAIGN_NAMES_SCOPE_CHANGED');
  return selections;
}
function acceptedNames(base) {
  return base.prepared.rows.filter(row => !row.received && ['imported', 'name_received'].includes(row.record.state))
    .map(row => ({ target: row.target, scope: row.scope, before: row.local, after: row.record.after }));
}
function commitProof(runtime, base, run) {
  const { first, observation, prepared } = base, product = observation.amber.product;
  const previous = first.progress, identity = previous?.session;
  const historyRoot = previous?.historyAdmissionEventId || (first.historyAdmission ? runtime.admission.rootId(first.historyAdmission) : null);
  const command = { key: first.key, identity: { installationKey: observation.amber.revision.installationKey,
    publicSku: product.public_sku, remoteProductId: String(observation.raw.id), contractVersion: 'first-sync-v1',
    initialProductId: identity?.initial_product_id || product.id,
    initialBindingRevisionId: identity?.initial_binding_revision_id || observation.amber.revision.id },
  expectedRevision: identity?.revision || '0', previewHash: base.previewToken,
  ...(historyRoot ? { historyAdmissionEventId: historyRoot } : {}),
  fields: sorted(prepared.rows.map(row => record(row.record))), actorUserId: run.actorUserId,
  requiredScopes: sorted(prepared.manifest), complete: prepared.complete === true, readyForOutbound: prepared.readyForOutbound };
  const previousFields = new Map((previous?.fields || []).map(field => [key(field), field]));
  const changed = command.fields.filter(field => !TERMINAL.has(previousFields.get(key(field))?.state));
  const latest = new Map(previousFields); for (const field of changed) latest.set(key(field), field);
  return { previewHash: base.previewToken, commandHash: runtime.c.hash(command),
    expectedSessionId: identity?.id || null, expectedRevision: String(BigInt(command.expectedRevision) + 1n),
    complete: command.complete, readyForOutbound: command.readyForOutbound,
    changedFields: changed.map(({ target, scope, state }) => ({ target, scope, state })),
    terminalScopes: sorted([...latest.values()].filter(field => TERMINAL.has(field.state)).map(({ target, scope, state }) => ({ target, scope, state }))) };
}
async function validateNames(runtime, config, selected, base, report, run) {
  const { request, item } = selected, product = base?.observation?.amber?.product, identity = report?.identity;
  if (base?.mode !== 'first' || base.previewToken !== selected.report.applyInput.previewToken || !product
    || product.id !== item.expectedProduct.id || product.public_sku !== item.sku
    || !same(runtime, runtime.batch.source(product), item.expectedProduct)
    || base.observation.amber.revision.id !== request.bindingRevisionId
    || base.observation.amber.revision.installationKey !== run.installation
    || base.observation.amber.compiled.hash !== request.expectedDefinitionHash
    || base.observation.raw?.id !== item.remoteProductId || base.observation.raw?.sku !== item.sku
    || identity?.state !== 'found' || identity.observedMagentoId !== item.remoteProductId || identity.article !== item.sku
    || report.mode !== 'update' || !Array.isArray(report.blockers) || report.blockers.length)
    fail('CAMPAIGN_NAMES_FRESH_EVIDENCE_CHANGED');
  const choices = runtime.first.decisions(selected.report.applyInput);
  runtime.batch.validatePacketDecision(base, report, request, item, choices);
  for (const choice of choices) {
    const rows = base.fields.filter(field => key(field) === key(choice));
    if (rows.length !== 1 || rows[0].local?.known !== true || rows[0].local.present !== true
      || rows[0].remote?.known !== true || rows[0].remote.present !== true) fail('CAMPAIGN_NAMES_OTHER_FIELD_UNKNOWN');
  }
  if (!Array.isArray(base.prepared?.rows) || !Array.isArray(base.prepared.manifest) || !Array.isArray(base.prepared.blockers))
    fail('CAMPAIGN_NAMES_PREPARED_INVALID');
  const original = runtime.c.hash({ prepared: base.prepared, progress: base.first.progress || null });
  const planned = await runtime.first.prepareDecision(config, base, choices, run);
  if (original !== runtime.c.hash({ prepared: base.prepared, progress: base.first.progress || null })) fail('CAMPAIGN_NAMES_BASE_CHANGED');
  if (!Array.isArray(planned.prepared?.blockers) || planned.prepared.blockers.length || planned.prepared.readyForOutbound !== true
    || !same(runtime, acceptedNames(planned), selected.preview.initialImports)) fail('CAMPAIGN_NAMES_REMAINING_BLOCKERS');
  const names = acceptedNames(base);
  if (!names.length || !same(runtime, names, selected.preview.initialImports)
    || names.some(field => field.target !== 'name' || !['all', 'en'].includes(field.scope))) fail('CAMPAIGN_NAMES_IMPORT_SCOPE_CHANGED');
  for (const field of names) {
    const rows = base.prepared.rows.filter(row => key(row) === key(field)), meta = base.projection.projection.filter(row => key(row) === key(field));
    if (rows.length !== 1 || meta.length !== 1 || meta[0].persistence !== 'name' || rows[0].record.state !== 'name_received'
      || rows[0].received || rows[0].local?.known !== true || rows[0].remote?.known !== true || rows[0].remote.present !== true
      || rows[0].remote.value !== field.after || typeof field.after !== 'string' || !field.after.trim()) fail('CAMPAIGN_NAMES_NAME_EVIDENCE_CHANGED');
  }
  const previous = new Map((base.first.progress?.fields || []).map(field => [key(field), field]));
  for (const old of previous.values()) if (TERMINAL.has(old.state) || old.state === 'seo_pending_initial_readback' || old.source?.decision) {
    const fresh = base.prepared.rows.filter(row => key(row) === key(old));
    if (fresh.length !== 1 || !same(runtime, record(old), record(fresh[0].record))) fail('CAMPAIGN_NAMES_PRIOR_RECEIPT_CHANGED');
  }
  for (const row of base.prepared.rows) {
    const prior = previous.get(key(row));
    if ((row.record.source?.decision || row.record.state === 'seo_pending_initial_readback')
      && (!prior || !same(runtime, record(prior), record(row.record)))) fail('CAMPAIGN_NAMES_NEW_DECISION_DENIED');
  }
  return commitProof(runtime, base, run);
}
function expectedReceipt(runtime, selected, proof, result) {
  if (!proof || !hex(proof.commandHash) || !hex(proof.previewHash) || !counter(proof.expectedRevision)
    || typeof proof.complete !== 'boolean' || typeof proof.readyForOutbound !== 'boolean'
    || !Array.isArray(proof.changedFields) || !Array.isArray(proof.terminalScopes)
    || !Array.isArray(result?.changedFields) || !Array.isArray(result?.terminalScopes)) return false;
  return result && typeof result.sessionId === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.sessionId)
    && (!proof.expectedSessionId || result.sessionId === proof.expectedSessionId) && result.revision === proof.expectedRevision
    && result.alreadyApplied === false && result.completed === proof.complete && result.complete === proof.complete
    && result.readyForOutbound === proof.readyForOutbound && typeof result.localChanged === 'boolean'
    && same(runtime, sorted(result.changedFields || []), sorted(proof.changedFields))
    && same(runtime, sorted(result.terminalScopes || []), sorted(proof.terminalScopes))
    && selected.preview.initialImports.every(field => result.changedFields.some(row => key(row) === key(field) && row.state === 'name_received'));
}
async function runItem(runtime, config, selected, run, { mode = 'apply', append, authority, commit = runNameCommit, stopping = () => false }) {
  let entered = false, proof;
  try {
    if (stopping()) fail('CAMPAIGN_NAMES_INTERRUPTED');
    await authority();
    return await runtime.boundary.guard(config, { sku: selected.item.sku, bindingRevisionId: selected.request.bindingRevisionId }, run, async state => {
      const { observation, report } = await runtime.boundary.observe(config,
        { sku: selected.item.sku, bindingRevisionId: selected.request.bindingRevisionId }, run);
      const base = await runtime.first.inspect(config, observation, run);
      proof = await validateNames(runtime, config, selected, base, report, run);
      await authority(); if (stopping()) fail('CAMPAIGN_NAMES_INTERRUPTED');
      if (mode === 'preview') return { sku: selected.item.sku, scopeHash: selected.scopeHash, status: 'available',
        preview: selected.preview, proof, deliveryEffect };
      await append({ type: 'prepared', sku: selected.item.sku, scopeHash: selected.scopeHash, proof, deliveryEffect });
      if (stopping()) fail('CAMPAIGN_NAMES_INTERRUPTED');
      entered = true;
      const result = await commit(runtime, config, state, base, { ...run, stopping });
      if (!expectedReceipt(runtime, selected, proof, result)) throw Object.assign(Error('Unconfirmed receipt'), { unconfirmed: true });
      return { sku: selected.item.sku, scopeHash: selected.scopeHash, status: 'recorded', proof, result, deliveryEffect };
    });
  } catch (cause) {
    if (cause.journalFailure) throw cause;
    const unconfirmed = cause.unconfirmed === true || entered && !cause.nameCommitNotStarted && !cause.nameCommitRolledBack;
    return { sku: selected.item.sku, scopeHash: selected.scopeHash, status: unconfirmed ? 'unconfirmed' : 'blocked',
      code: safeCode(cause), ...(proof ? { proof } : {}), deliveryEffect, stop: true };
  }
}
async function durableWrite(handle, value, runtime, config, secrets) {
  try {
    runtime.audit.assertEvidenceSafe(value, config, secrets);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > MAX_FILE || (await handle.stat()).size + bytes.length > MAX_JOURNAL) fail('CAMPAIGN_NAMES_JOURNAL_LIMIT');
    for (let offset = 0; offset < bytes.length;) {
      const count = (await handle.write(bytes, offset, bytes.length - offset, null)).bytesWritten;
      if (!positive(count) || count > bytes.length - offset) fail('CAMPAIGN_NAMES_JOURNAL_WRITE_FAILED'); offset += count;
    }
    await handle.sync();
  } catch (cause) { cause.journalFailure = true; throw cause; }
}
async function readLimited(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_JOURNAL) fail('CAMPAIGN_NAMES_JOURNAL_LIMIT');
    const bytes = await handle.readFile(); if (bytes.length !== stat.size || bytes.length > MAX_JOURNAL) fail('CAMPAIGN_NAMES_JOURNAL_LIMIT'); return bytes;
  } finally { await handle.close(); }
}
function readJournal(bytes, header, selections, runtime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_JOURNAL || bytes.at(-1) !== 10) fail('CAMPAIGN_NAMES_JOURNAL_INCOMPLETE');
  let rows; try { rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)); } catch { fail('CAMPAIGN_NAMES_JOURNAL_INVALID'); }
  if (!same(runtime, rows[0], header)) fail('CAMPAIGN_NAMES_JOURNAL_SCOPE_CHANGED');
  const results = []; let pending = null, stopped = false;
  for (const row of rows.slice(1)) {
    if (row.type === 'summary') { if (pending) fail('CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED'); continue; }
    if (stopped) fail('CAMPAIGN_NAMES_JOURNAL_INVALID');
    const selected = selections[results.length];
    if (!selected || row.sku !== selected.item.sku || row.scopeHash !== selected.scopeHash
      || !same(runtime, row.deliveryEffect, deliveryEffect)) fail('CAMPAIGN_NAMES_JOURNAL_SCOPE_CHANGED');
    if (row.type === 'prepared') {
      if (pending || !hex(row.proof?.commandHash) || row.proof.previewHash !== selected.report.applyInput.previewToken)
        fail('CAMPAIGN_NAMES_JOURNAL_INVALID'); pending = row; continue;
    }
    if (row.type !== 'receipt' || !['recorded', 'blocked', 'unconfirmed'].includes(row.status)) fail('CAMPAIGN_NAMES_JOURNAL_INVALID');
    if (row.status === 'unconfirmed') fail('CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED');
    if (row.status === 'recorded' && (!pending || !same(runtime, pending.proof, row.proof)
      || !expectedReceipt(runtime, selected, row.proof, row.result))) fail('CAMPAIGN_NAMES_JOURNAL_INVALID');
    if (row.status === 'blocked') {
      if (typeof row.code !== 'string' || safeCode(row) !== row.code) fail('CAMPAIGN_NAMES_JOURNAL_INVALID');
      stopped = true;
    }
    pending = null; results.push(row);
  }
  if (pending) fail('CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED');
  if (stopped) fail('CAMPAIGN_NAMES_BLOCKER_REQUIRES_NEW_REVIEW');
  return results;
}
async function verifyRecorded(runtime, config, selected, receipt, run) {
  const deny = () => fail('CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED');
  const proof = receipt.proof, result = receipt.result;
  if (!expectedReceipt(runtime, selected, proof, result)) deny();
  const row = (await run.databasePool.query(`SELECT p.preview_hash,p.command_hash,p.command,p.result,p.actor_user_id,p.audit_event_id::text,
    s.origin_hash,s.public_product_identity_id::text,s.public_sku,s.remote_product_id,s.installation_key,
    a.event_key,a.subject_type,a.subject_id,a.details
    FROM magento_first_sync_progress p JOIN magento_first_sync_sessions s ON s.id=p.session_id
    JOIN audit_events a ON a.id=p.audit_event_id WHERE p.session_id=$1 AND p.revision=$2 AND p.preview_hash=$3`,
  [result.sessionId, result.revision, proof.previewHash])).rows[0];
  if (!row || row.preview_hash !== selected.report.applyInput.previewToken || row.command_hash !== proof.commandHash
    || runtime.c.hash(row.command) !== proof.commandHash || String(row.actor_user_id) !== String(run.actorUserId)
    || row.origin_hash !== runtime.c.originHash(config.baseUrl) || row.public_sku !== selected.item.sku
    || String(row.public_product_identity_id) !== String(selected.item.expectedProduct.public_product_identity_id)
    || String(row.remote_product_id) !== String(selected.item.remoteProductId) || row.installation_key !== run.installation
    || row.event_key !== 'magento.first_sync_progress_recorded' || row.subject_type !== 'magento_first_sync'
    || row.subject_id !== result.sessionId || !counter(row.audit_event_id) || row.details?.commandHash !== proof.commandHash
    || !same(runtime, row.details.result, row.result)
    || !expectedReceipt(runtime, selected, proof, { ...row.result, complete: row.result.completed, localChanged: result.localChanged })) deny();
  for (const field of selected.preview.initialImports) {
    const matches = row.command.fields.filter(candidate => key(candidate) === key(field));
    if (matches.length !== 1 || matches[0].state !== 'name_received' || matches[0].after !== field.after
      || !same(runtime, matches[0].before, field.before) || matches[0].remote?.value !== field.after) deny();
  }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function implementationHash(serverRoot, runtime) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  const files = [__filename, require.resolve('./first-sync-name-commit'),
    ...['first-sync-local-apply', 'first-sync-source-snapshot', 'name-state', 'sync-job.service', 'sync-job-transaction',
      'binding-publication', 'first-sync-cutover-admission'].map(name => local.resolve('./src/services/magento/' + name)),
    ...['access-admin-transaction', 'full-product-cutover-gate'].map(name => local.resolve('./src/services/' + name))];
  return runtime.c.hash({ campaign: await campaign.implementationHash(serverRoot, runtime), files: await Promise.all(files.map(async file => hash(await fs.readFile(file)))) });
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, journal, lock, lockPath, unconfirmed = false, interrupted = false;
  const abort = new AbortController(), stop = () => { interrupted = true; abort.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot); runtime.c.installation(cli.installation);
    const loaded = await (dependencies.loadReview || preview.loadReview)(cli.review, cli.reviewHash, runtime, cli);
    const selections = selectedNames(loaded, runtime), config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const secrets = runtime.pool.databaseSecrets(env), databasePool = dependencies.pool || (owned = runtime.createPool(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CAMPAIGN_NAMES_DATABASE_MISMATCH');
    const run = { databasePool, actorUserId: cli.actor, installation: cli.installation, sensitiveValues: secrets,
      fetchImpl: preview.getOnly((url, init = {}) => (dependencies.fetchImpl || globalThis.fetch)(url,
        { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) })) };
    const authority = async () => {
      if (interrupted) fail('CAMPAIGN_NAMES_INTERRUPTED');
      const fresh = await (dependencies.readAuthority || preview.readAuthority)(runtime, config, run);
      if (!same(runtime, fresh, loaded.review.publication)) fail('CAMPAIGN_NAMES_PUBLICATION_CHANGED');
    };
    const header = { type: 'start', contract: CONTRACT, mode: cli.mode === 'preview' ? 'preview' : 'apply',
      reviewSha256: cli.reviewHash, scopeHash: runtime.c.hash(selections.map(row => row.scopeHash)),
      actorUserId: cli.actor, database: cli.database, installationKey: cli.installation, publication: loaded.review.publication,
      implementationHash: await (dependencies.implementationHash || implementationHash)(cli.serverRoot, runtime), deliveryEffect };
    if (cli.mode !== 'resume') { await fs.mkdir(cli.output, { mode: 0o700 }); await syncDirectory(path.dirname(cli.output)); }
    else if (!(await fs.lstat(cli.output)).isDirectory() || (await fs.lstat(cli.output)).isSymbolicLink()) fail('CAMPAIGN_NAMES_OUTPUT_INVALID');
    lockPath = path.join(cli.output, 'run.lock'); lock = await fs.open(lockPath, 'wx', 0o600); await lock.sync(); await syncDirectory(cli.output);
    const file = path.join(cli.output, 'results.jsonl');
    const results = cli.mode === 'resume' ? readJournal(await readLimited(file), header, selections, runtime) : [];
    for (const [index, receipt] of results.entries())
      await (dependencies.verifyRecorded || verifyRecorded)(runtime, config, selections[index], receipt, run);
    await authority();
    journal = await fs.open(file, cli.mode === 'resume'
      ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0) : 'wx', 0o600);
    await syncDirectory(cli.output);
    const append = row => durableWrite(journal, row, runtime, config, secrets);
    if (cli.mode !== 'resume') await append(header);
    for (const selected of selections.slice(results.length)) {
      if (interrupted) break;
      const result = await runItem(runtime, config, selected, run, { mode: cli.mode === 'preview' ? 'preview' : 'apply',
        append, authority, commit: dependencies.runNameCommit || runNameCommit, stopping: () => interrupted });
      unconfirmed = ['recorded', 'unconfirmed'].includes(result.status);
      await append({ type: 'receipt', ...result }); results.push(result); unconfirmed = result.status === 'unconfirmed';
      print(JSON.stringify({ sku: result.sku, status: result.status, checked: results.length, total: selections.length, deliveryEffect }));
      if (result.stop || unconfirmed || interrupted) break;
    }
    const summary = { type: 'summary', complete: results.length === selections.length && results.every(row => ['recorded', 'available'].includes(row.status)),
      reviewed: selections.length, checked: results.length, recorded: results.filter(row => row.status === 'recorded').length,
      available: results.filter(row => row.status === 'available').length, blocked: results.filter(row => row.status === 'blocked').length,
      unconfirmed: results.filter(row => row.status === 'unconfirmed').length, notChecked: selections.length - results.length,
      readOnly: cli.mode === 'preview', deliveryEffect };
    await append(summary); print(JSON.stringify({ ...summary, output: cli.output })); return summary.complete ? 0 : 2;
  } catch (cause) {
    printError(JSON.stringify({ complete: false, code: safeCode(cause), ...(unconfirmed ? { localResultUnconfirmed: true } : {}), deliveryEffect })); return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (lock) { await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, createRuntime, selectedNames, validateNames, runItem, expectedReceipt, readJournal,
  verifyRecorded, main, durableWrite, implementationHash, deliveryEffect };
