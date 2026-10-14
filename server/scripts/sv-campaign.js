'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const classifier = require('./first-sync-local-classify');
const discovery = require('./first-sync-local-discovery');
const journalFiles = require('./sv-campaign-journal');
const stagesDefault = require('./sv-campaign-stages');
const POLICY = 'sv-manager-v1';
const ROUTES = ['ordinary', 'history', 'initial_names', 'create', 'review'];
const STAGES = ['history', 'names', 'fields', 'equal', 'handoff'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const same = (runtime, a, b) => runtime.c.hash(a) === runtime.c.hash(b);
const globalFailure = error => error.svAuthorityFailure === true || [401, 403].includes(error.statusCode)
  || /PUBLICATION|PUBLISHED_CURRENT_BINDING|BINDING_CHANGED|BINDING_CONFLICT|INSTALLATION_MISMATCH|PERMISSION|ACTOR|ADMINISTRATOR|AUTHORI|CUTOVER|LIFECYCLE_WRITER/.test(error.code || '');
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code)
  ? error.code : 'SV_CAMPAIGN_FAILED';
const HELP = 'node sv-campaign.js --mode run|resume --server-root /app --input ORIGINAL.json --input-sha256 RAW_SHA256 '
  + '--classification CLASSIFIER_DIRECTORY --classification-sha256 RAW_MANIFEST_SHA256 --expected-count 746 '
  + '--output RUN_DIRECTORY --expected-database amber --actor-id 1 --installation-key amber\n'
  + 'Exact SV workflow: fresh scoped history, initial Magento names, Manager price and proven rounded physical weight, '
  + 'then canonical controlled outbound handoff. Local writes and automatic delivery are possible. '
  + 'No direct Magento writes, no unresolved-work replay, no worker or application startup.';
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--server-root': 'serverRoot', '--input': 'input', '--input-sha256': 'inputHash',
    '--classification': 'classification', '--classification-sha256': 'classificationHash', '--expected-count': 'count',
    '--output': 'output', '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation' }, out = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('SV_CAMPAIGN_ARGUMENTS');
    out[key] = value;
  }
  if (!['run', 'resume'].includes(out.mode) || !out.serverRoot || !out.input || !out.classification || !out.output
    || !out.database || !out.installation || !hex(out.inputHash) || !hex(out.classificationHash)
    || !/^[1-9][0-9]*$/.test(out.count || '') || !Number.isSafeInteger(Number(out.count)) || Number(out.count) > 2000
    || !/^[1-9][0-9]*$/.test(out.actor || '') || !Number.isSafeInteger(Number(out.actor))) fail('SV_CAMPAIGN_ARGUMENTS');
  out.count = Number(out.count); out.actor = Number(out.actor); out.serverRoot = path.resolve(out.serverRoot);
  return out;
}
function subsetFor(route, rows, input, installationKey) {
  const common = { bindingRevisionId: input.bindingRevisionId, expectedDefinitionHash: input.expectedDefinitionHash, installationKey };
  if (route === 'history' || route === 'initial_names') return { ...common,
    ...(route === 'initial_names' ? { choice: 'magento' } : {}),
    items: rows.map(row => ({ sku: row.sku, productId: row.productId, remoteProductId: row.observedRemoteProductId })) };
  return { ...common, route, requiresFreshActionPreview: true, items: rows.map(row => ({ sku: row.sku,
    productId: row.productId, category: row.category, expectedRemoteProductId: row.expectedRemoteProductId,
    observedRemoteProductId: row.observedRemoteProductId, inputIndex: row.inputIndex })) };
}
async function loadClassification(inputFile, inputHash, directory, manifestHash, expectedCount, runtime, io = fs) {
  if (!hex(inputHash) || !hex(manifestHash) || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 2000)
    fail('SV_CAMPAIGN_CLASSIFIER_INVALID');
  try { await io.lstat(path.join(directory, 'incomplete')); fail('SV_CAMPAIGN_CLASSIFIER_INCOMPLETE'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const inputBytes = await journalFiles.readLimited(io, inputFile, 4 * 1024 * 1024);
  const savedScope = await journalFiles.readLimited(io, path.join(directory, 'scope.json'), 4 * 1024 * 1024);
  const manifestBytes = await journalFiles.readLimited(io, path.join(directory, 'manifest.json'), 4 * 1024 * 1024);
  if (hash(inputBytes) !== inputHash || !inputBytes.equals(savedScope) || hash(manifestBytes) !== manifestHash)
    fail('SV_CAMPAIGN_CLASSIFIER_HASH_CHANGED');
  const input = JSON.parse(inputBytes), manifest = JSON.parse(manifestBytes);
  classifier.validateInput(input, runtime);
  if (input.items.length !== expectedCount || manifest.contract !== 'first-sync-local-classification-v1'
    || manifest.readOnly !== true || manifest.complete !== true || manifest.globalFailure !== null
    || manifest.requiresFreshActionPreview !== true || manifest.directRemoteWrites !== 0 || manifest.directlyEnqueuedJobs !== 0
    || manifest.localBusinessWrites !== 0 || manifest.inputSha256 !== inputHash
    || manifest.canonicalInputSha256 !== runtime.c.hash(input) || manifest.offset !== 0
    || manifest.selected !== expectedCount || manifest.total !== expectedCount || manifest.checked !== expectedCount
    || manifest.notChecked !== 0 || manifest.nextOffset !== expectedCount || manifest.remainingInput !== 0
    || manifest.publication?.bindingRevisionId !== input.bindingRevisionId
    || manifest.publication.expectedDefinitionHash !== input.expectedDefinitionHash || !hex(manifest.publication.publicationHash))
    fail('SV_CAMPAIGN_CLASSIFIER_INCOMPLETE');
  const journalBytes = await journalFiles.readLimited(io, path.join(directory, 'results.jsonl'));
  if (!journalBytes.length || journalBytes.at(-1) !== 10) fail('SV_CAMPAIGN_CLASSIFIER_JOURNAL_INVALID');
  const records = journalBytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const headerKeys = ['contract', 'readOnly', 'database', 'actorUserId', 'installationKey', 'publication', 'inputSha256',
    'canonicalInputSha256', 'offset', 'selected', 'total', 'startedAt', 'directRemoteWrites', 'directlyEnqueuedJobs',
    'localBusinessWrites', 'requiresFreshActionPreview'];
  if (records.length !== expectedCount + 2
    || !same(runtime, records[0], { kind: 'start', ...Object.fromEntries(headerKeys.map(key => [key, manifest[key]])) })
    || !same(runtime, records.at(-1), { kind: 'complete', ...manifest })) fail('SV_CAMPAIGN_CLASSIFIER_JOURNAL_CHANGED');
  const rows = records.slice(1, -1), remoteIds = new Set();
  for (const [index, row] of rows.entries()) {
    const item = input.items[index];
    if (row.kind !== 'result' || row.inputIndex !== index || row.sku !== item.sku || row.productId !== item.productId
      || row.category !== 'SV' || row.expectedRemoteProductId !== item.remoteProductId || !ROUTES.includes(row.route)
      || row.requiresFreshActionPreview !== true || row.freshRemoteEquivalenceEstablished !== false)
      fail('SV_CAMPAIGN_CLASSIFIER_IDENTITY_CHANGED');
    if (row.observedRemoteProductId !== null) {
      if (!Number.isSafeInteger(row.observedRemoteProductId) || row.observedRemoteProductId < 1 || remoteIds.has(row.observedRemoteProductId))
        fail('SV_CAMPAIGN_CLASSIFIER_IDENTITY_CHANGED');
      remoteIds.add(row.observedRemoteProductId);
      if (item.remoteProductId !== null && item.remoteProductId !== row.observedRemoteProductId && row.route !== 'review')
        fail('SV_CAMPAIGN_CLASSIFIER_IDENTITY_CHANGED');
    }
    if (row.sourceSnapshot && (row.sourceHash !== runtime.c.hash(row.sourceSnapshot) || row.sourceSnapshot.id !== item.productId
      || row.sourceSnapshot.public_sku !== item.sku || row.sourceSnapshot.category !== 'SV')) fail('SV_CAMPAIGN_CLASSIFIER_SOURCE_CHANGED');
  }
  if (!manifest.counts || !Array.isArray(manifest.subsets)) fail('SV_CAMPAIGN_CLASSIFIER_SUBSETS_INVALID');
  const seen = new Set();
  for (const route of ROUTES) if (manifest.counts[route] !== rows.filter(row => row.route === route).length)
    fail('SV_CAMPAIGN_CLASSIFIER_COUNTS_CHANGED');
  for (const descriptor of manifest.subsets) {
    if (!ROUTES.includes(descriptor.route) || seen.has(descriptor.route) || descriptor.file !== descriptor.route + '-scope.json'
      || !hex(descriptor.sha256) || descriptor.count !== manifest.counts[descriptor.route] || descriptor.count < 1)
      fail('SV_CAMPAIGN_CLASSIFIER_SUBSETS_INVALID');
    seen.add(descriptor.route);
    const bytes = await journalFiles.readLimited(io, path.join(directory, descriptor.file), 4 * 1024 * 1024);
    if (hash(bytes) !== descriptor.sha256 || !same(runtime, JSON.parse(bytes),
      subsetFor(descriptor.route, rows.filter(row => row.route === descriptor.route), input, manifest.installationKey)))
      fail('SV_CAMPAIGN_CLASSIFIER_SUBSETS_CHANGED');
  }
  if (ROUTES.some(route => manifest.counts[route] > 0 && !seen.has(route))) fail('SV_CAMPAIGN_CLASSIFIER_SUBSETS_INVALID');
  return { input, manifest, rows, inputBytes, manifestBytes, classifierJournalSha256: hash(journalBytes) };
}
function progress(records, input, runtime) {
  const result = new Map(input.items.map(item => [item.sku, { receipts: [], pending: new Map(), terminal: null }]));
  for (const record of records.slice(1)) {
    if (record.type === 'summary') continue;
    const row = result.get(record.sku);
    if (!row || !['claim', 'prepared', 'receipt', 'terminal'].includes(record.type)) fail('SV_CAMPAIGN_JOURNAL_SCOPE_CHANGED');
    if (row.terminal) fail('SV_CAMPAIGN_JOURNAL_AFTER_TERMINAL');
    if (record.type === 'claim') continue;
    if (record.type === 'terminal') { row.terminal = record; continue; }
    if (!STAGES.includes(record.stage)) fail('SV_CAMPAIGN_JOURNAL_STAGE_INVALID');
    if (record.type === 'prepared') {
      if (row.pending.has(record.stage) || row.receipts.some(saved => saved.stage === record.stage)) fail('SV_CAMPAIGN_JOURNAL_STAGE_REPEATED');
      row.pending.set(record.stage, record);
    } else {
      if (row.receipts.some(saved => saved.stage === record.stage)) fail('SV_CAMPAIGN_JOURNAL_STAGE_REPEATED');
      const pending = row.pending.get(record.stage);
      if (pending && !same(runtime, pending.prepared, record.prepared)) fail('SV_CAMPAIGN_JOURNAL_INTENT_CHANGED');
      row.pending.delete(record.stage); row.receipts.push(record);
    }
  }
  return result;
}
async function runProducts(runtime, config, loaded, run, { journal, authority, stopping = () => false,
  stages = stagesDefault, outbound, print = () => {} }) {
  const scope = { bindingRevisionId: loaded.input.bindingRevisionId, expectedDefinitionHash: loaded.input.expectedDefinitionHash,
    installationKey: run.installation, publicationHash: loaded.manifest.publication.publicationHash },
    states = progress(journal.records, loaded.input, runtime);
  let global = null, checked = 0;
  const assertAuthority = async () => {
    try { await authority(); }
    catch (error) { error.svAuthorityFailure = true; throw error; }
  };
  const append = async record => {
    runtime.audit.assertEvidenceSafe(record, config, run.sensitiveValues || []);
    await journal.append(record);
  };
  for (const [index, original] of loaded.input.items.entries()) {
    if (stopping()) break;
    const prior = states.get(original.sku), classified = loaded.rows[index];
    const item = { ...original, remoteProductId: classified.observedRemoteProductId };
    let lane, outcome = null;
    const terminal = async record => { await append(record); outcome = record; };
    try {
      await assertAuthority();
      for (const saved of prior.receipts) {
        const status = saved.receipt?.status;
        if (status === 'blocked') continue;
        if (saved.stage === 'handoff') await outbound.verifyReceipt(runtime, config, item, scope, saved, run);
        else await stages.verifyReceipt(runtime, config, item, scope, saved, run);
      }
      if (prior.terminal) { outcome = prior.terminal; continue; }
      const handedReceipt = prior.receipts.find(record => record.stage === 'handoff');
      if (handedReceipt) {
        await terminal({ type: 'terminal', sku: item.sku,
          status: handedReceipt.receipt?.kind === 'automatic_request' ? 'already_pending' : 'queued',
          receipt: handedReceipt.receipt });
        continue;
      }
      const blockedReceipt = prior.receipts.find(record => record.receipt?.status === 'blocked');
      if (blockedReceipt) {
        await terminal({ type: 'terminal', sku: item.sku, status: 'review',
          reason: blockedReceipt.receipt.code || 'SV_CAMPAIGN_STAGE_BLOCKED' });
        continue;
      }
      if (prior.pending.size) {
        await terminal({ type: 'terminal', sku: item.sku, status: 'uncertain', reason: 'SV_CAMPAIGN_UNRESOLVED_INTENT',
          stages: [...prior.pending.keys()] });
        continue;
      }
      if (!Number.isSafeInteger(item.remoteProductId) || item.remoteProductId < 1 || classified.route === 'create'
        || original.remoteProductId !== null && original.remoteProductId !== item.remoteProductId) {
        await terminal({ type: 'terminal', sku: item.sku, status: 'review', reason: 'SV_CAMPAIGN_EXISTING_REMOTE_IDENTITY_REQUIRED' });
        continue;
      }
      lane = await outbound.acquireLane(runtime, config, item, run);
      if (lane.status !== 'acquired') {
        await terminal({ type: 'terminal', sku: item.sku, status: 'review', reason: lane.reason || 'SV_CAMPAIGN_EXISTING_WORK' });
        continue;
      }
      await append({ type: 'claim', sku: item.sku, productId: item.productId, remoteProductId: item.remoteProductId,
        publicIdentityId: lane.publicIdentityId, inputIndex: index, policyVersion: POLICY });
      const completedStages = new Set(prior.receipts.filter(record => record.receipt?.status !== 'blocked').map(record => record.stage));
      let pending = null;
      const checkpoint = async record => {
        if (record.sku !== item.sku || !STAGES.includes(record.stage) || !['prepared', 'receipt'].includes(record.type))
          fail('SV_CAMPAIGN_CHECKPOINT_SCOPE_CHANGED');
        if (completedStages.has(record.stage) || record.type === 'prepared' && pending) fail('SV_CAMPAIGN_STAGE_ALREADY_RECORDED');
        if (record.type === 'receipt' && pending && (pending.stage !== record.stage
          || !same(runtime, pending.prepared, record.prepared))) fail('SV_CAMPAIGN_CHECKPOINT_INTENT_CHANGED');
        await append(record);
        if (record.type === 'prepared') pending = record;
        else { pending = null; if (record.receipt?.status !== 'blocked') completedStages.add(record.stage); }
      };
      const hooks = { checkpoint, authority: assertAuthority, stopping, completedStages };
      const advanced = await stages.advance(runtime, config, item, scope, run, hooks);
      if (stopping()) break;
      if (advanced.status !== 'ready') {
        if (globalFailure({ code: advanced.reason })) { global = advanced.reason; break; }
        const unresolved = progress(journal.records, loaded.input, runtime).get(item.sku).pending.size > 0;
        await terminal({ type: 'terminal', sku: item.sku, status: unresolved ? 'uncertain' : 'review',
          reason: advanced.reason || 'SV_CAMPAIGN_REVIEW_REQUIRED' });
        continue;
      }
      const handed = await outbound.handoff(runtime, config, item, scope, run, hooks);
      if (globalFailure({ code: handed.reason })) { global = handed.reason; break; }
      await terminal({ type: 'terminal', sku: item.sku, status: handed.status,
        ...(handed.reason ? { reason: handed.reason } : {}), ...(handed.receipt ? { receipt: handed.receipt } : {}) });
    } catch (error) {
      if (error.journalFailure) throw error;
      if (globalFailure(error)) { global = safeCode(error); break; }
      if (stopping() || error.code === 'SV_CAMPAIGN_INTERRUPTED') break;
      // A failed verifier or unknown canonical result never permits replay.
      const state = progress(journal.records, loaded.input, runtime).get(item.sku);
      if (state.terminal) { global = safeCode(error); break; }
      await terminal({ type: 'terminal', sku: item.sku,
        status: error.uncertain || error.unconfirmed || state.pending.size ? 'uncertain' : 'review', reason: safeCode(error) });
    } finally {
      if (lane?.release) await lane.release();
      if (outcome) print(JSON.stringify({ sku: item.sku, status: outcome.status, inputIndex: index,
        checked: ++checked, total: loaded.input.items.length,
        resumed: Boolean(prior.terminal || prior.receipts.length || prior.pending.size) }));
    }
  }
  const final = progress(journal.records, loaded.input, runtime);
  const counts = { total: loaded.input.items.length, queued: 0, already_pending: 0, review: 0, uncertain: 0, notChecked: 0 };
  for (const value of final.values()) {
    if (!value.terminal) counts.notChecked++;
    else if (Object.hasOwn(counts, value.terminal.status)) counts[value.terminal.status]++;
    else counts.review++;
  }
  const summary = { type: 'summary', complete: !global && !stopping() && counts.notChecked === 0,
    globalFailure: global, counts, directRemoteWrites: 0, deliveryConfirmed: false };
  await append(summary); return summary;
}
async function implementationHash(serverRoot, runtime, io = fs) {
  const scripts = [__filename, require.resolve('./sv-campaign-journal'), require.resolve('./sv-campaign-stages'),
    require.resolve('./sv-campaign-outbound'), require.resolve('./sv-campaign-policy'), require.resolve('./first-sync-local-classify'),
    require.resolve('./first-sync-local-discovery'), require.resolve('./first-sync-initial-name-plan')];
  // Pin the deployed dependency closure, not only the small adapter entrypoints.
  const collect = async directory => {
    const found = [];
    for (const entry of (await io.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await collect(file));
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(file);
    }
    return found;
  };
  const services = await collect(path.join(serverRoot, 'src'));
  const installedScripts = path.join(serverRoot, 'scripts');
  const helpers = (await io.readdir(installedScripts)).filter(name => name.endsWith('.js')).sort()
    .map(name => path.join(installedScripts, name));
  const hashes = [];
  for (const file of [...scripts, ...services, ...helpers, path.join(serverRoot, 'package-lock.json')])
    hashes.push(hash(await io.readFile(file)));
  return runtime.c.hash(hashes);
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error, io = fs } = dependencies;
  let pool, journal, interrupted = false;
  const stop = () => { interrupted = true; };
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const outbound = dependencies.outbound || require('./sv-campaign-outbound');
    const runtime = dependencies.runtime || stagesDefault.createRuntime(cli.serverRoot);
    if (outbound.extendRuntime) Object.assign(runtime, outbound.extendRuntime(cli.serverRoot));
    if (typeof runtime.first?.applyWithPreparedValidation !== 'function') fail('SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED');
    if (runtime.controlled?.handoffExclusivityVersion !== 1) fail('SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED');
    if (runtime.initialNames?.pristineFirstVersion !== 1) fail('SV_CAMPAIGN_PRISTINE_NAMES_CONTRACT_REQUIRED');
    runtime.c.installation(cli.installation);
    const loaded = await loadClassification(cli.input, cli.inputHash, cli.classification, cli.classificationHash, cli.count, runtime, io);
    if (loaded.manifest.database !== cli.database || loaded.manifest.actorUserId !== cli.actor
      || loaded.manifest.installationKey !== cli.installation) fail('SV_CAMPAIGN_CLASSIFIER_OWNER_CHANGED');
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const databasePool = dependencies.pool || (pool = runtime.createPool(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('SV_CAMPAIGN_DATABASE_MISMATCH');
    const run = { databasePool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: runtime.pool.databaseSecrets(env), fetchImpl: classifier.getOnly(dependencies.fetchImpl || globalThis.fetch) };
    const authority = async () => {
      const observed = await (dependencies.readAuthority || discovery.readAuthority)(runtime, config, run);
      if (!same(runtime, observed, loaded.manifest.publication)) fail('SV_CAMPAIGN_PUBLICATION_CHANGED');
    };
    await authority();
    const header = { contract: 'sv-campaign-v1', scopeSha256: cli.inputHash, classifierSha256: cli.classificationHash,
      classifierJournalSha256: loaded.classifierJournalSha256, actorUserId: cli.actor, database: cli.database,
      installationKey: cli.installation, policyVersion: POLICY, expectedCount: cli.count, publication: loaded.manifest.publication,
      implementationSha256: await (dependencies.implementationHash || implementationHash)(cli.serverRoot, runtime, io) };
    journal = await journalFiles.openJournal({ directory: cli.output, mode: cli.mode, header, runtime, io });
    run.runId = journal.runId; run.requestId = journal.runId;
    for (const [name, bytes] of [['scope.json', loaded.inputBytes], ['classifier-manifest.json', loaded.manifestBytes]]) {
      const file = path.join(cli.output, name);
      if (cli.mode === 'resume') {
        if (!(await journalFiles.readLimited(io, file)).equals(bytes)) fail('SV_CAMPAIGN_SAVED_INPUT_CHANGED');
      } else {
        const handle = await io.open(file, 'wx', 0o600);
        try { await journalFiles.writeAll(handle, bytes); } finally { await handle.close(); }
      }
    }
    await journalFiles.syncDirectory(io, cli.output);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const summary = await runProducts(runtime, config, loaded, run, { journal, authority, stopping: () => interrupted,
      stages: dependencies.stages || stagesDefault, outbound, print });
    print(JSON.stringify({ output: cli.output, ...summary }));
    await journal.close(); journal = null;
    return summary.complete && !summary.counts.review && !summary.counts.uncertain ? 0 : 2;
  } catch (error) { printError(JSON.stringify({ complete: false, code: safeCode(error), directRemoteWrites: 0 })); return 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(error => printError(JSON.stringify({ code: safeCode(error), journalCleanupFailed: true })));
    if (pool) await pool.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, loadClassification, progress, runProducts, main, implementationHash, POLICY };
