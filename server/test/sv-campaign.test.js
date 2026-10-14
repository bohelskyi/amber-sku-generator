'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const runner = require('../scripts/sv-campaign');
const journals = require('../scripts/sv-campaign-journal');
const c = require('../src/services/magento/binding-contract');

const binding = '11111111-1111-4111-8111-111111111111';
const definition = 'a'.repeat(64);
const publication = { bindingRevisionId: binding, expectedDefinitionHash: definition, publicationHash: 'b'.repeat(64) };
const runtime = { c, audit: { assertEvidenceSafe() {} } };
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFor = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const clone = value => structuredClone(value);
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const resources = new WeakMap();

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sv-campaign-test-'));
  const handles = []; resources.set(t, handles);
  t.after(async () => {
    for (const close of handles.reverse()) await close().catch(() => {});
    const resolved = path.resolve(directory), root = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(root));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function sourceFor(item) {
  return { id: item.productId, public_product_identity_id: String(item.productId), full_sku: item.sku,
    public_sku: item.sku, category: 'SV', status: 'active', exclude_from_export: 0,
    corrected_to_product_id: null, sku_schema_version_id: binding, characteristic_version_id: null,
    weight_numeric: '12.4', total_price_uah: '125.00', answers: { souvenir: 5, weight: 12.4 },
    magento_name_subject_ua: null, magento_name_subject_en: null, magento_name_override: null };
}

function classified(item, index) {
  const sourceSnapshot = sourceFor(item);
  return { kind: 'result', sku: item.sku, productId: item.productId, category: 'SV',
    expectedRemoteProductId: item.remoteProductId, observedRemoteProductId: 1000 + item.productId,
    route: 'ordinary', reviewKind: null, observedAt: '2026-10-14T00:00:00.000Z',
    eligibilityMode: 'ordinary', inspectionMode: 'ordinary', blockers: [], ordinaryBlockers: [],
    eligibilityBlockers: [], fieldBlockers: [], freshRemoteEquivalenceEstablished: false,
    requiresFreshActionPreview: true, remoteIdentityState: 'found', sourceSnapshot,
    sourceHash: c.hash(sourceSnapshot), fields: [], historyReviewAssessment: null, historyReview: null,
    ordinarySendable: true, inspectionReadyForOutbound: true, inputIndex: index };
}

async function sealedClassification(t, count = 2) {
  const directory = await temporary(t), classification = path.join(directory, 'classification');
  await fs.mkdir(classification);
  const items = Array.from({ length: count }, (_, index) => ({ sku: index % 2 ? 'AG-SYNTHETIC-' + (index + 1) : 'SV-SYNTHETIC-' + (index + 1),
    productId: index + 1, category: 'SV', remoteProductId: null }));
  const input = { bindingRevisionId: binding, expectedDefinitionHash: definition, items }, rows = items.map(classified);
  const inputBytes = bytesFor(input), inputFile = path.join(directory, 'input.json');
  await fs.writeFile(inputFile, inputBytes);
  await fs.writeFile(path.join(classification, 'scope.json'), inputBytes);
  const header = { contract: 'first-sync-local-classification-v1', readOnly: true, database: 'sv_campaign_test',
    actorUserId: 7, installationKey: 'synthetic', publication: clone(publication), inputSha256: rawHash(inputBytes),
    canonicalInputSha256: c.hash(input), offset: 0, selected: count, total: count,
    startedAt: '2026-10-14T00:00:00.000Z', directRemoteWrites: 0, directlyEnqueuedJobs: 0,
    localBusinessWrites: 0, requiresFreshActionPreview: true };
  const subset = { bindingRevisionId: binding, expectedDefinitionHash: definition, installationKey: 'synthetic',
    route: 'ordinary', requiresFreshActionPreview: true, items: rows.map(row => ({ sku: row.sku,
      productId: row.productId, category: row.category, expectedRemoteProductId: row.expectedRemoteProductId,
      observedRemoteProductId: row.observedRemoteProductId, inputIndex: row.inputIndex })) };
  const subsetBytes = bytesFor(subset);
  await fs.writeFile(path.join(classification, 'ordinary-scope.json'), subsetBytes);
  const manifest = { ...header, complete: true, globalFailure: null,
    counts: { ordinary: count, history: 0, initial_names: 0, create: 0, review: 0 },
    subsets: [{ route: 'ordinary', file: 'ordinary-scope.json', sha256: rawHash(subsetBytes), count }],
    checked: count, notChecked: 0, nextOffset: count, remainingInput: 0, finishedAt: '2026-10-14T00:00:01.000Z' };
  const fixture = { directory, classification, inputFile, input, inputBytes, header, manifest, rows, subset, count };
  await seal(fixture);
  return fixture;
}

async function seal(fixture) {
  fixture.manifestBytes = bytesFor(fixture.manifest);
  await fs.writeFile(path.join(fixture.classification, 'manifest.json'), fixture.manifestBytes);
  await fs.writeFile(path.join(fixture.classification, 'results.jsonl'),
    encode([{ kind: 'start', ...fixture.header }, ...fixture.rows, { kind: 'complete', ...fixture.manifest }]));
}

async function reclassify(fixture, mutateRows) {
  mutateRows(fixture.rows);
  fixture.manifest.subsets = [];
  for (const route of ['ordinary', 'history', 'initial_names', 'create', 'review']) {
    const rows = fixture.rows.filter(row => row.route === route);
    fixture.manifest.counts[route] = rows.length;
    if (!rows.length) continue;
    const common = { bindingRevisionId: binding, expectedDefinitionHash: definition, installationKey: 'synthetic' };
    const subset = ['history', 'initial_names'].includes(route) ? { ...common,
      ...(route === 'initial_names' ? { choice: 'magento' } : {}),
      items: rows.map(row => ({ sku: row.sku, productId: row.productId, remoteProductId: row.observedRemoteProductId })) }
      : { ...common, route, requiresFreshActionPreview: true, items: rows.map(row => ({ sku: row.sku,
        productId: row.productId, category: row.category, expectedRemoteProductId: row.expectedRemoteProductId,
        observedRemoteProductId: row.observedRemoteProductId, inputIndex: row.inputIndex })) };
    const bytes = bytesFor(subset), file = route + '-scope.json';
    await fs.writeFile(path.join(fixture.classification, file), bytes);
    fixture.manifest.subsets.push({ route, file, sha256: rawHash(bytes), count: rows.length });
  }
  await seal(fixture);
}

const load = (fixture, count = fixture.count) => runner.loadClassification(fixture.inputFile, rawHash(fixture.inputBytes),
  fixture.classification, rawHash(fixture.manifestBytes), count, runtime);

const cliArguments = () => ['--mode', 'run', '--server-root', path.join(__dirname, '..'),
  '--input', 'synthetic-scope.json', '--input-sha256', '1'.repeat(64), '--classification', 'synthetic-classifier',
  '--classification-sha256', '2'.repeat(64), '--expected-count', '2', '--output', 'synthetic-run',
  '--expected-database', 'sv_campaign_test', '--actor-id', '7', '--installation-key', 'synthetic'];

test('missing deployed prepared validator stops before reading artifacts or opening database or journal', async () => {
  const errors = [], calls = [];
  const forbidden = name => () => { calls.push(name); throw Error('Unexpected ' + name); };
  const code = await runner.main(cliArguments(), {
    env: {}, outbound: {}, runtime: { c: { ...c, installation: forbidden('installation') },
      createPool: forbidden('createPool') },
    pool: { query: forbidden('database') },
    io: { readFile: forbidden('readFile'), open: forbidden('open'), mkdir: forbidden('mkdir'), readdir: forbidden('readdir') },
    print: forbidden('print'), printError: value => errors.push(JSON.parse(value)),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, [{ complete: false, code: 'SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED', directRemoteWrites: 0 }]);
});

for (const [missing, expectedCode] of [
  ['controlled', 'SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED'],
  ['initialNames', 'SV_CAMPAIGN_PRISTINE_NAMES_CONTRACT_REQUIRED'],
]) test('missing deployed ' + missing + ' contract stops before all business or artifact I/O', async () => {
  const errors = [], calls = [], forbidden = name => () => { calls.push(name); throw Error('Unexpected ' + name); };
  const deployed = { first: { applyWithPreparedValidation() {} }, controlled: { handoffExclusivityVersion: 1 },
    initialNames: { pristineFirstVersion: 1 }, c: { ...c, installation: forbidden('installation') }, createPool: forbidden('createPool') };
  delete deployed[missing];
  const code = await runner.main(cliArguments(), { env: {}, outbound: {}, runtime: deployed,
    io: { readFile: forbidden('readFile'), open: forbidden('open'), mkdir: forbidden('mkdir'), readdir: forbidden('readdir') },
    pool: { query: forbidden('database') }, print: forbidden('print'), printError: value => errors.push(JSON.parse(value)) });
  assert.equal(code, 1); assert.deepEqual(calls, []);
  assert.deepEqual(errors, [{ complete: false, code: expectedCode, directRemoteWrites: 0 }]);
});

test('CLI requires exact sealed input, classifier digest, count and explicit run mode', () => {
  assert.doesNotThrow(() => runner.argumentsFor(cliArguments()));
  assert.doesNotThrow(() => runner.argumentsFor(cliArguments().map(value => value === 'run' ? 'resume' : value)));
  for (const flag of ['--input-sha256', '--classification-sha256', '--expected-count', '--actor-id']) {
    const args = cliArguments(); args.splice(args.indexOf(flag), 2);
    assert.throws(() => runner.argumentsFor(args));
  }
  for (const [flag, value] of [['--mode', 'force'], ['--expected-count', '0'], ['--expected-count', '2.5'],
    ['--actor-id', '0'], ['--input-sha256', 'not-a-digest']]) {
    const args = cliArguments(); args[args.indexOf(flag) + 1] = value;
    assert.throws(() => runner.argumentsFor(args));
  }
  assert.throws(() => runner.argumentsFor([...cliArguments(), '--expected-count', '2']));
  assert.throws(() => runner.argumentsFor([...cliArguments(), '--force', 'true']));
});

test('sealed classifier loader accepts an exact complete synthetic SV scope including AG public identities', async t => {
  const f = await sealedClassification(t), loaded = await load(f);
  assert.deepEqual(loaded.input, f.input);
  assert.deepEqual(loaded.manifest, f.manifest);
  assert.deepEqual(loaded.rows, f.rows);
  assert.deepEqual(loaded.inputBytes, f.inputBytes);
  assert.deepEqual(loaded.manifestBytes, f.manifestBytes);
});

test('classification requires the caller-approved exact count rather than a nonempty or partial scope', async t => {
  const f = await sealedClassification(t);
  await assert.rejects(load(f, f.count + 1));
  await assert.rejects(load(f, f.count - 1));
});

for (const [label, mutate] of [
  ['incomplete marker', async f => fs.writeFile(path.join(f.classification, 'incomplete'), '{}\n')],
  ['changed raw input bytes', async f => fs.appendFile(f.inputFile, ' ')],
  ['changed saved scope', async f => fs.appendFile(path.join(f.classification, 'scope.json'), ' ')],
  ['changed raw manifest bytes', async f => fs.appendFile(path.join(f.classification, 'manifest.json'), ' ')],
  ['changed subset bytes', async f => fs.appendFile(path.join(f.classification, 'ordinary-scope.json'), ' ')],
  ['truncated classifier journal', async f => {
    const file = path.join(f.classification, 'results.jsonl'), bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes.subarray(0, bytes.length - 1));
  }],
  ['result appended after completion', async f => fs.appendFile(path.join(f.classification, 'results.jsonl'), encode([f.rows[0]]))],
]) test('classification rejects ' + label, async t => {
  const f = await sealedClassification(t); await mutate(f); await assert.rejects(load(f));
});

for (const [label, mutate] of [
  ['partial offset', f => { f.header.offset = f.manifest.offset = 1; }],
  ['unchecked tail', f => { f.manifest.checked--; f.manifest.notChecked++; }],
  ['remaining input', f => { f.manifest.remainingInput = 1; }],
  ['global failure', f => { f.manifest.globalFailure = 'CLASSIFY_PUBLICATION_CHANGED'; }],
  ['not complete', f => { f.manifest.complete = false; }],
  ['different publication', f => { f.header.publication.expectedDefinitionHash = 'c'.repeat(64); f.manifest.publication = clone(f.header.publication); }],
  ['duplicate result identity', f => { f.rows[1] = { ...clone(f.rows[0]), inputIndex: 1 }; }],
  ['duplicate result position', f => { f.rows[1].inputIndex = 0; }],
  ['changed source hash', f => { f.rows[0].sourceSnapshot.total_price_uah = '999.00'; }],
  ['different local category', f => { f.rows[0].category = 'NM'; }],
  ['different observed identity', f => { f.rows[1].observedRemoteProductId = f.rows[0].observedRemoteProductId; }],
  ['route counts not matching rows', f => { f.manifest.counts.ordinary--; f.manifest.counts.review++; }],
  ['subset path traversal', f => { f.manifest.subsets[0].file = '../input.json'; }],
]) test('classification rejects coherently resealed ' + label, async t => {
  const f = await sealedClassification(t); mutate(f); await seal(f); await assert.rejects(load(f));
});

function journalHeader() {
  return { contract: 'sv-campaign-v1', scopeSha256: '1'.repeat(64), classifierSha256: '2'.repeat(64),
    actorUserId: 7, database: 'sv_campaign_test', installationKey: 'synthetic', policyVersion: 'synthetic-policy-v1',
    implementationSha256: '3'.repeat(64), publication: clone(publication), expectedCount: 2 };
}

async function newJournal(t, io = fs) {
  const directory = path.join(await temporary(t), 'run'), header = journalHeader();
  const journal = await journals.openJournal({ directory, mode: 'run', header, runtime, io });
  resources.get(t).push(() => journal.close());
  return { directory, header, journal };
}

test('journal opens an exclusive run and retains its run identity and records on resume', async t => {
  const f = await newJournal(t), record = { type: 'diagnostic', sku: 'SV-SYNTHETIC-1', code: 'SYNTHETIC_REVIEW' };
  await f.journal.append(record);
  const runId = f.journal.runId;
  assert.equal(typeof runId, 'string'); assert.ok(runId.length > 0);
  await f.journal.close();
  const resumed = await journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime });
  resources.get(t).push(() => resumed.close());
  assert.equal(resumed.runId, runId);
  assert.ok(resumed.records.some(row => row.type === record.type && row.sku === record.sku && row.code === record.code));
});

test('a second run cannot overwrite an existing output or take another process lock', async t => {
  const f = await newJournal(t);
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'run', header: f.header, runtime }));
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
  await f.journal.append({ type: 'diagnostic', code: 'ORIGINAL_OWNER_STILL_WRITES' });
});

test('resume refuses changed actor, scope, publication, implementation and expected membership', async t => {
  const f = await newJournal(t); await f.journal.close();
  for (const changed of [
    { actorUserId: 8 }, { scopeSha256: '4'.repeat(64) }, { classifierSha256: '5'.repeat(64) },
    { publication: { ...publication, publicationHash: '6'.repeat(64) } },
    { implementationSha256: '7'.repeat(64) }, { expectedCount: 3 },
  ]) await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume',
    header: { ...f.header, ...changed }, runtime }));
});

async function journalFile(directory) {
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  return path.join(directory, files[0]);
}

for (const [label, mutate] of [
  ['changed previously written value', bytes => Buffer.from(bytes.toString().replace('SYNTHETIC_REVIEW_A', 'SYNTHETIC_REVIEW_B'))],
  ['removed interior record', bytes => {
    const rows = bytes.toString().trimEnd().split('\n'); rows.splice(1, 1); return Buffer.from(rows.join('\n') + '\n');
  }],
  ['duplicated record', bytes => {
    const rows = bytes.toString().trimEnd().split('\n'); rows.splice(2, 0, rows[1]); return Buffer.from(rows.join('\n') + '\n');
  }],
  ['truncated trailing record', bytes => bytes.subarray(0, bytes.length - 1)],
]) test('hash-chained journal rejects ' + label, async t => {
  const f = await newJournal(t);
  await f.journal.append({ type: 'diagnostic', code: 'SYNTHETIC_REVIEW_A' });
  await f.journal.append({ type: 'diagnostic', code: 'SYNTHETIC_REVIEW_C' });
  await f.journal.close();
  const file = await journalFile(f.directory); await fs.writeFile(file, mutate(await fs.readFile(file)));
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
});

function wrapHandle(handle, overrides) {
  return new Proxy(handle, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('each journal append finishes fsync after handling partial writes', async t => {
  const events = [];
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!String(args[0]).endsWith('.jsonl')) return handle;
    return wrapHandle(handle, {
      write: async (buffer, offset, length, position) => {
        events.push('write'); return handle.write(buffer, offset, Math.min(length, 7), position);
      },
      sync: async () => { events.push('sync'); await handle.sync(); },
    });
  } };
  const f = await newJournal(t, io); events.length = 0;
  await f.journal.append({ type: 'diagnostic', code: 'PARTIAL_WRITE_RECORD' });
  assert.ok(events.filter(event => event === 'write').length > 1);
  assert.equal(events.at(-1), 'sync');
  await f.journal.close();
  const resumed = await journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime });
  resources.get(t).push(() => resumed.close());
  assert.ok(resumed.records.some(record => record.code === 'PARTIAL_WRITE_RECORD'));
});

test('a journal append that cannot fsync fails instead of confirming durable intent', async t => {
  let refuseSync = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!String(args[0]).endsWith('.jsonl')) return handle;
    return wrapHandle(handle, { sync: async () => {
      if (refuseSync) throw Object.assign(Error('Synthetic fsync failure'), { code: 'EIO' });
      await handle.sync();
    } });
  } };
  const f = await newJournal(t, io); refuseSync = true;
  await assert.rejects(f.journal.append({ type: 'intent', stage: 'names', sku: 'SV-SYNTHETIC-1' }),
    error => error.journalFailure === true);
  await assert.rejects(f.journal.append({ type: 'diagnostic', code: 'MUST_NOT_CONTINUE_AFTER_DURABILITY_FAILURE' }));
  await f.journal.close();
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
});

test('zero-progress journal writes poison the run and preserve its reconciliation lock', async t => {
  let stall = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!String(args[0]).endsWith('.jsonl')) return handle;
    return wrapHandle(handle, { write: (...values) => stall ? Promise.resolve({ bytesWritten: 0 }) : handle.write(...values) });
  } };
  const f = await newJournal(t, io); stall = true;
  await assert.rejects(f.journal.append({ type: 'intent', stage: 'names', sku: 'SV-SYNTHETIC-1' }),
    error => error.journalFailure === true);
  await f.journal.close();
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
});

async function productRun(t, { io = fs, count = 2, classifierBlockedPolicy, mutateRows } = {}) {
  const f = await sealedClassification(t, count);
  if (mutateRows) await reclassify(f, mutateRows);
  const loaded = await load(f), directory = path.join(f.directory, 'run');
  const header = { ...journalHeader(), expectedCount: count, ...(classifierBlockedPolicy === undefined ? {} : { classifierBlockedPolicy }) };
  const journal = await journals.openJournal({ directory, mode: 'run', header, runtime, io });
  resources.get(t).push(() => journal.close());
  const state = { actions: [], localActions: [], events: [], verified: [], printed: [], stopped: false };
  const run = { databasePool: {}, actorUserId: 7, installation: 'synthetic', sensitiveValues: [], runId: journal.runId,
    fetchImpl: () => assert.fail('Synthetic runner tests must never make a network request') };
  const config = { configured: true, baseUrl: 'https://sv-campaign-fixture.invalid' };
  const stages = {
    advance: async (_runtime, _config, item, _scope, actualRun) => {
      assert.equal(actualRun, run); state.events.push('inspect:' + item.sku); return { status: 'ready' };
    },
    verifyReceipt: async (_runtime, _config, item, _scope, saved) => {
      state.verified.push(saved); state.events.push('verify-local:' + item.sku);
    },
  };
  const outbound = {
    acquireLane: async (_runtime, _config, item, actualRun) => {
      assert.equal(actualRun, run); state.events.push('acquire:' + item.sku);
      return { status: 'acquired', publicIdentityId: String(item.productId),
        release: async () => { state.events.push('release:' + item.sku); } };
    },
    handoff: async (_runtime, _config, item, _scope, actualRun, hooks) => {
      assert.equal(actualRun, run);
      const prepared = { sku: item.sku, productId: item.productId, remoteProductId: item.remoteProductId };
      await hooks.checkpoint({ type: 'prepared', stage: 'handoff', sku: item.sku, prepared });
      state.actions.push(item.sku); state.events.push('handoff:' + item.sku);
      const receipt = { status: 'queued', sku: item.sku, requestGeneration: String(item.productId) };
      await hooks.checkpoint({ type: 'receipt', stage: 'handoff', sku: item.sku, prepared, receipt });
      return { status: 'queued', receipt };
    },
    verifyReceipt: async (_runtime, _config, item, _scope, saved) => {
      state.verified.push(saved); state.events.push('verify-handoff:' + item.sku);
    },
  };
  const hooks = { journal, stages, outbound, classifierBlockedPolicy, authority: async () => { state.events.push('authority'); }, stopping: () => state.stopped,
    print: value => { const row = JSON.parse(value); state.printed.push(row); state.events.push('progress:' + row.sku); } };
  return { ...f, loaded, journal, directory, header, run, config, state, stages, outbound, hooks,
    execute: () => runner.runProducts(runtime, config, loaded, run, hooks) };
}

test('runner hands off exact found identities sequentially and reports queued without claiming delivery', async t => {
  const f = await productRun(t), summary = await f.execute();
  assert.deepEqual(f.state.actions, f.input.items.map(item => item.sku));
  assert.equal(summary.complete, true); assert.equal(summary.counts.queued, 2);
  assert.equal(summary.directRemoteWrites, 0); assert.equal(summary.deliveryConfirmed, false);
  const first = f.input.items[0].sku, second = f.input.items[1].sku;
  assert.ok(f.state.events.indexOf('release:' + first) < f.state.events.indexOf('acquire:' + second));
  assert.deepEqual(f.state.printed, f.input.items.map((item, index) => ({ sku: item.sku, status: 'queued', inputIndex: index,
    checked: index + 1, total: 2, resumed: false })));
});

test('known product review continues to the next product without handoff for the blocked item', async t => {
  const f = await productRun(t), first = f.input.items[0].sku, advance = f.stages.advance;
  f.stages.advance = async (...args) => args[2].sku === first ? { status: 'review', reason: 'SYNTHETIC_FIELD_REVIEW' } : advance(...args);
  const summary = await f.execute();
  assert.deepEqual(f.state.actions, [f.input.items[1].sku]);
  assert.equal(summary.complete, true); assert.equal(summary.counts.review, 1); assert.equal(summary.counts.queued, 1);
  assert.deepEqual(f.state.printed, [
    { sku: first, status: 'review', inputIndex: 0, checked: 1, total: 2, resumed: false },
    { sku: f.input.items[1].sku, status: 'queued', inputIndex: 1, checked: 2, total: 2, resumed: false },
  ]);
});

test('current publication or revoked authority stops the campaign before any action', async t => {
  const f = await productRun(t);
  f.hooks.authority = async () => { throw Object.assign(Error('Synthetic changed publication'),
    { code: 'SV_CAMPAIGN_PUBLICATION_CHANGED', statusCode: 409 }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'SV_CAMPAIGN_PUBLICATION_CHANGED');
  assert.equal(summary.complete, false); assert.equal(summary.counts.notChecked, 2);
  assert.deepEqual(f.state.actions, []); assert.ok(!f.state.events.some(event => event.startsWith('acquire:')));
  assert.deepEqual(f.state.printed, []);
});

test('progress counts only completed outcomes before a global stop leaves the remaining product untouched', async t => {
  const f = await productRun(t); let reads = 0;
  f.hooks.authority = async () => { if (++reads === 2) throw Object.assign(Error('Synthetic revoked authority'),
    { code: 'ADMIN_PERMISSION_REVOKED', statusCode: 403 }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'ADMIN_PERMISSION_REVOKED');
  assert.equal(summary.counts.queued, 1); assert.equal(summary.counts.notChecked, 1);
  assert.deepEqual(f.state.printed, [{ sku: f.input.items[0].sku, status: 'queued', inputIndex: 0,
    checked: 1, total: 2, resumed: false }]);
  assert.ok(!f.state.events.includes('acquire:' + f.input.items[1].sku));
});

test('an unavailable authority read stops the entire run even without an authorization error code', async t => {
  const f = await productRun(t);
  f.hooks.authority = async () => { throw Object.assign(Error('Synthetic unavailable authority database'), { code: 'ECONNRESET' }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'ECONNRESET');
  assert.equal(summary.complete, false); assert.equal(summary.counts.notChecked, 2);
  assert.deepEqual(f.state.actions, []); assert.ok(!f.state.events.some(event => event.startsWith('acquire:')));
});

test('a canonical binding conflict stops the remaining scope rather than becoming per-product review', async t => {
  const f = await productRun(t);
  f.outbound.handoff = async () => { throw Object.assign(Error('Synthetic canonical publication conflict'),
    { code: 'MAGENTO_BINDING_CONFLICT', statusCode: 409 }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'MAGENTO_BINDING_CONFLICT');
  assert.equal(summary.counts.notChecked, 2); assert.equal(summary.counts.review, 0);
  assert.deepEqual(f.state.actions, []);
  assert.ok(f.state.events.includes('release:' + f.input.items[0].sku));
  assert.ok(!f.state.events.includes('acquire:' + f.input.items[1].sku));
});

test('global permission failure during a stage releases its lane and leaves the tail untouched', async t => {
  const f = await productRun(t);
  f.stages.advance = async () => { throw Object.assign(Error('Synthetic permission revocation'),
    { code: 'ADMIN_PERMISSION_REVOKED', statusCode: 403 }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'ADMIN_PERMISSION_REVOKED');
  assert.equal(summary.counts.notChecked, 2); assert.deepEqual(f.state.actions, []);
  assert.ok(f.state.events.includes('release:' + f.input.items[0].sku));
  assert.ok(!f.state.events.includes('acquire:' + f.input.items[1].sku));
});

test('an unresolved durable intent is quarantined on resume and its action is never reexecuted', async t => {
  const f = await productRun(t), first = f.input.items[0].sku;
  await f.journal.append({ type: 'prepared', stage: 'names', sku: first, prepared: { previewToken: 'c'.repeat(64) } });
  const summary = await f.execute();
  assert.equal(summary.counts.uncertain, 1); assert.equal(summary.counts.queued, 1);
  assert.ok(!f.state.events.includes('acquire:' + first));
  assert.deepEqual(f.state.actions, [f.input.items[1].sku]);
  assert.deepEqual(f.state.printed, [
    { sku: first, status: 'uncertain', inputIndex: 0, checked: 1, total: 2, resumed: true },
    { sku: f.input.items[1].sku, status: 'queued', inputIndex: 1, checked: 2, total: 2, resumed: false },
  ]);
  const before = [...f.state.actions]; await f.execute();
  assert.deepEqual(f.state.actions, before);
});

test('unknown canonical result remains uncertain across resume without replay', async t => {
  const f = await productRun(t), first = f.input.items[0].sku, advance = f.stages.advance;
  f.stages.advance = async (...args) => {
    if (args[2].sku !== first) return advance(...args);
    await args[5].checkpoint({ type: 'prepared', stage: 'names', sku: first, prepared: { command: 'synthetic' } });
    f.state.localActions.push(first);
    throw Object.assign(Error('Synthetic lost response'), { uncertain: true });
  };
  const summary = await f.execute();
  assert.equal(summary.counts.uncertain, 1); assert.deepEqual(f.state.localActions, [first]);
  assert.deepEqual(f.state.printed, [
    { sku: first, status: 'uncertain', inputIndex: 0, checked: 1, total: 2, resumed: false },
    { sku: f.input.items[1].sku, status: 'queued', inputIndex: 1, checked: 2, total: 2, resumed: false },
  ]);
  await f.execute();
  assert.deepEqual(f.state.localActions, [first]);
});

for (const mismatch of ['stage', 'prepared']) test('checkpoint rejects mismatched ' + mismatch + ' without confirming or replaying the action', async t => {
  const f = await productRun(t), first = f.input.items[0].sku, advance = f.stages.advance;
  f.stages.advance = async (...args) => {
    if (args[2].sku !== first) return advance(...args);
    const prepared = { previewToken: 'c'.repeat(64) };
    await args[5].checkpoint({ type: 'prepared', stage: 'names', sku: first, prepared });
    f.state.localActions.push(first);
    await args[5].checkpoint({ type: 'receipt', stage: mismatch === 'stage' ? 'fields' : 'names', sku: first,
      prepared: mismatch === 'prepared' ? { previewToken: 'd'.repeat(64) } : prepared,
      receipt: { status: 'recorded' } });
    return { status: 'ready' };
  };
  const summary = await f.execute();
  assert.equal(summary.counts.uncertain, 1); assert.equal(summary.counts.queued, 1);
  assert.deepEqual(f.state.localActions, [first]);
  assert.deepEqual(f.state.actions, [f.input.items[1].sku]);
  assert.ok(!f.journal.records.some(row => row.sku === first && row.type === 'receipt'));
  assert.ok(f.journal.records.some(row => row.sku === first && row.type === 'terminal'
    && row.status === 'uncertain' && row.reason === 'SV_CAMPAIGN_CHECKPOINT_INTENT_CHANGED'));
  await f.execute();
  assert.deepEqual(f.state.localActions, [first]);
});

test('unchanged immutable receipts are verified before a terminal product is skipped', async t => {
  const f = await productRun(t); await f.execute();
  const previous = [...f.state.actions], records = [...f.journal.records];
  f.state.events.length = 0; f.state.printed.length = 0;
  await f.execute();
  assert.deepEqual(f.state.actions, previous);
  assert.deepEqual(f.state.verified.map(row => row.sku), f.input.items.map(item => item.sku));
  assert.ok(!f.state.events.some(event => event.startsWith('acquire:')));
  assert.deepEqual(f.state.printed, f.input.items.map((item, index) => ({ sku: item.sku, status: 'queued', inputIndex: index,
    checked: index + 1, total: 2, resumed: true })));
  for (const item of f.input.items) assert.ok(f.state.events.indexOf('verify-handoff:' + item.sku)
    < f.state.events.indexOf('progress:' + item.sku));
  assert.deepEqual(f.journal.records.slice(0, records.length), records);
  assert.deepEqual(f.journal.records.slice(records.length).map(row => row.type), ['summary']);
});

test('changed persisted receipt stops resume before skipping it or executing the untouched tail', async t => {
  const f = await productRun(t), originalHandoff = f.outbound.handoff;
  f.outbound.handoff = async (...args) => { const result = await originalHandoff(...args); f.state.stopped = true; return result; };
  await f.execute(); assert.equal(f.state.actions.length, 1); f.state.stopped = false; f.state.printed.length = 0;
  f.outbound.verifyReceipt = async () => { throw Object.assign(Error('Synthetic changed receipt'),
    { code: 'SV_CAMPAIGN_RECEIPT_UNCONFIRMED', statusCode: 409 }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'SV_CAMPAIGN_RECEIPT_UNCONFIRMED');
  assert.equal(f.state.actions.length, 1); assert.equal(summary.counts.notChecked, 1);
  assert.deepEqual(f.state.printed, []);
});

test('a progress output failure cannot duplicate the durable terminal outcome or execute the tail', async t => {
  const f = await productRun(t); let prints = 0;
  f.hooks.print = () => { prints++; throw Object.assign(Error('Synthetic output failure'), { code: 'EPIPE' }); };
  await assert.rejects(f.execute(), { code: 'EPIPE' });
  assert.equal(prints, 1); assert.equal(f.state.actions.length, 1);
  assert.equal(f.journal.records.filter(row => row.type === 'terminal').length, 1);
  assert.ok(!f.state.events.includes('acquire:' + f.input.items[1].sku));
});

test('a verified handoff receipt without its terminal checkpoint is finalized without another handoff', async t => {
  const f = await productRun(t), first = f.input.items[0].sku;
  const prepared = { sku: first, productId: 1, remoteProductId: 1001 };
  const receipt = { status: 'queued', sku: first, requestGeneration: '1' };
  await f.journal.append({ type: 'prepared', stage: 'handoff', sku: first, prepared });
  f.state.actions.push(first);
  await f.journal.append({ type: 'receipt', stage: 'handoff', sku: first, prepared, receipt });
  const summary = await f.execute();
  assert.equal(summary.counts.queued, 2);
  assert.deepEqual(f.state.actions, f.input.items.map(item => item.sku));
  assert.ok(f.state.events.includes('verify-handoff:' + first));
  assert.ok(!f.state.events.includes('acquire:' + first));
  assert.ok(!f.state.events.includes('inspect:' + first));
});

test('a known blocked stage receipt without terminal checkpoint stays in review without automatic retry', async t => {
  const f = await productRun(t), first = f.input.items[0].sku, prepared = { previewToken: 'c'.repeat(64) };
  await f.journal.append({ type: 'prepared', stage: 'names', sku: first, prepared });
  await f.journal.append({ type: 'receipt', stage: 'names', sku: first, prepared,
    receipt: { status: 'blocked', code: 'INITIAL_NAMES_REVIEW_REQUIRED' } });
  const summary = await f.execute();
  assert.equal(summary.counts.review, 1); assert.equal(summary.counts.queued, 1);
  assert.deepEqual(f.state.actions, [f.input.items[1].sku]);
  assert.ok(!f.state.events.includes('acquire:' + first));
  assert.ok(!f.state.events.includes('inspect:' + first));
});

for (const stage of ['prepared', 'receipt']) test('failed ' + stage + ' journal fsync blocks replay and later product actions', async t => {
  let failRecord = null;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!String(args[0]).endsWith('journal.jsonl')) return handle;
    return wrapHandle(handle, {
      write: async (buffer, offset, length, position) => {
        const text = buffer.subarray(offset, offset + length).toString();
        if (text.includes('"type":"' + stage + '"')) failRecord = stage;
        return handle.write(buffer, offset, length, position);
      },
      sync: async () => {
        if (failRecord) throw Object.assign(Error('Synthetic stage fsync failure'), { code: 'EIO' });
        await handle.sync();
      },
    });
  } };
  const f = await productRun(t, { io });
  await assert.rejects(f.execute(), error => error.journalFailure === true);
  assert.equal(f.state.actions.length, stage === 'prepared' ? 0 : 1);
  assert.ok(!f.state.events.includes('acquire:' + f.input.items[1].sku));
  await f.journal.close();
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
  assert.equal(f.state.actions.length, stage === 'prepared' ? 0 : 1);
});

const SKIP_KNOWN = 'skip-known-v1';
const blockedExamples = [
  { label: 'ordinary blocker', reason: 'SYNTHETIC_ORDINARY_BLOCKER', apply: row => Object.assign(row, {
    ordinarySendable: false, ordinaryBlockers: [{ code: 'SYNTHETIC_ORDINARY_BLOCKER', target: 'synthetic-field', evidence: { fixture: true } }],
  }) },
  { label: 'history blocker beyond the permitted name baseline', reason: 'SYNTHETIC_HISTORY_BLOCKER', apply: row => Object.assign(row, {
    route: 'history', eligibilityMode: 'review', inspectionMode: 'review', ordinarySendable: false,
    ordinaryBlockers: [{ code: 'NAME_BASELINE_REQUIRED' }, { code: 'SYNTHETIC_HISTORY_BLOCKER', fixture: true }],
    historyReviewAssessment: { status: 'available', code: 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE' },
  }) },
  ...['FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED', 'FIRST_SYNC_DELIVERY_HISTORY_CHANGED'].map(code => ({
    label: code, reason: code, apply: row => Object.assign(row, {
      route: 'review', eligibilityMode: 'review', inspectionMode: 'review', reviewKind: 'history',
      historyReviewAssessment: { status: 'blocked', code, fixture: { exact: true } },
    }),
  })),
];

async function originalArtifacts(fixture) {
  const result = { input: await fs.readFile(fixture.inputFile) };
  for (const name of await fs.readdir(fixture.classification)) result[name] = await fs.readFile(path.join(fixture.classification, name));
  return result;
}

test('classifier blocked policy is explicit, versioned and rejected when missing, unknown or repeated', () => {
  assert.equal(runner.argumentsFor(cliArguments()).classifierBlockedPolicy, undefined);
  assert.equal(Object.hasOwn(runner.argumentsFor(cliArguments()), 'classifierBlockedPolicy'), false);
  assert.equal(runner.argumentsFor([...cliArguments(), '--classifier-blocked-policy', SKIP_KNOWN]).classifierBlockedPolicy, SKIP_KNOWN);
  for (const extra of [
    ['--classifier-blocked-policy'], ['--classifier-blocked-policy', 'skip-known-v2'],
    ['--classifier-blocked-policy', 'skip-all'], ['--classifier-blocked-policy', ''],
    ['--classifier-blocked-policy', SKIP_KNOWN, '--classifier-blocked-policy', SKIP_KNOWN],
  ]) assert.throws(() => runner.argumentsFor([...cliArguments(), ...extra]), { code: 'SV_CAMPAIGN_ARGUMENTS' });
});

for (const example of blockedExamples) test('skip-known records exact sealed evidence without action for ' + example.label, async t => {
  const f = await productRun(t, { count: 1, classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => example.apply(rows[0]) });
  const original = await originalArtifacts(f), expected = clone(f.loaded.rows[0]), summary = await f.execute();
  assert.deepEqual(summary.counts, { total: 1, queued: 0, already_pending: 0, review: 1, uncertain: 0, notChecked: 0 });
  assert.equal(summary.complete, true);
  const terminal = f.journal.records.find(row => row.type === 'terminal');
  assert.equal(terminal.status, 'review'); assert.equal(terminal.reason, example.reason);
  assert.equal(terminal.classificationDecision, SKIP_KNOWN);
  assert.equal(terminal.classificationRowHash, c.hash(expected));
  assert.deepEqual(terminal.classification, expected);
  assert.deepEqual(await originalArtifacts(f), original);
  assert.deepEqual(f.state.actions, []);
  assert.ok(!f.state.events.some(event => /^(acquire|inspect|handoff):/.test(event)));
  assert.deepEqual(f.state.printed, [{ sku: expected.sku, status: 'review', inputIndex: 0, checked: 1, total: 1, resumed: false }]);
});

const freshExamples = [
  ['history with only name baseline', row => Object.assign(row, { route: 'history', eligibilityMode: 'review', inspectionMode: 'review',
    ordinaryBlockers: [{ code: 'NAME_BASELINE_REQUIRED' }], historyReviewAssessment: { status: 'available' } })],
  ['general review', row => Object.assign(row, { route: 'review', eligibilityMode: 'review', inspectionMode: 'review',
    historyReviewAssessment: { status: 'blocked', code: 'SYNTHETIC_OTHER_REVIEW' } })],
  ['first-sync field conflict', row => Object.assign(row, { route: 'review', eligibilityMode: 'first', inspectionMode: 'first',
    fieldBlockers: [{ code: 'FIRST_SYNC_FIELD_CONFLICT', target: 'price' }] })],
  ['pristine initial names', row => Object.assign(row, { route: 'initial_names', eligibilityMode: 'first', inspectionMode: 'first',
    ordinaryBlockers: [{ code: 'NAME_BASELINE_REQUIRED' }], historyReviewAssessment: null })],
  ['unknown assessment status', row => Object.assign(row, { route: 'review', eligibilityMode: 'review', inspectionMode: 'review',
    historyReviewAssessment: { status: 'unknown', code: 'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED' } })],
  ['first eligibility with review inspection', row => Object.assign(row, { route: 'review', eligibilityMode: 'first', inspectionMode: 'review',
    historyReviewAssessment: { status: 'blocked', code: 'FIRST_SYNC_DELIVERY_HISTORY_CHANGED' } })],
  ['review eligibility with first inspection', row => Object.assign(row, { route: 'review', eligibilityMode: 'review', inspectionMode: 'first',
    historyReviewAssessment: { status: 'blocked', code: 'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED' } })],
  ['invalid blocker codes', row => Object.assign(row, { ordinaryBlockers: [{ code: 'lowercase_invalid' }, { code: '' }, { code: 1 }] })],
];

for (const [label, mutate] of freshExamples) test('skip-known still performs fresh action stages for ' + label, async t => {
  const f = await productRun(t, { count: 1, classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => mutate(rows[0]) });
  const summary = await f.execute();
  assert.equal(summary.counts.queued, 1); assert.deepEqual(f.state.actions, [f.input.items[0].sku]);
  assert.ok(f.state.events.includes('inspect:' + f.input.items[0].sku));
  assert.ok(f.journal.records.filter(row => row.type === 'terminal').every(row => !Object.hasOwn(row, 'classificationDecision')));
});

test('omitting classifier blocked policy preserves fresh processing for every otherwise-skippable pattern', async t => {
  const f = await productRun(t, { count: blockedExamples.length,
    mutateRows: rows => rows.forEach((row, index) => blockedExamples[index].apply(row)) });
  const summary = await f.execute();
  assert.equal(summary.counts.queued, blockedExamples.length); assert.equal(summary.counts.review, 0);
  assert.deepEqual(f.state.actions, f.input.items.map(row => row.sku));
  assert.equal(Object.hasOwn(f.journal.records[0], 'classifierBlockedPolicy'), false);
});

test('exact 746-item synthetic scope records 444 skips and freshly processes all remaining 302 with complete progress', async t => {
  const f = await productRun(t, { count: 746, classifierBlockedPolicy: SKIP_KNOWN,
    mutateRows: rows => rows.slice(0, 444).forEach((row, index) => blockedExamples[index % blockedExamples.length].apply(row)) });
  const before = await originalArtifacts(f), summary = await f.execute();
  assert.deepEqual(summary.counts, { total: 746, queued: 302, already_pending: 0, review: 444, uncertain: 0, notChecked: 0 });
  assert.equal(summary.complete, true); assert.equal(summary.deliveryConfirmed, false);
  assert.deepEqual(f.state.actions, f.input.items.slice(444).map(row => row.sku));
  const terminals = f.journal.records.filter(row => row.type === 'terminal');
  assert.equal(terminals.length, 746); assert.equal(terminals.filter(row => row.classificationDecision === SKIP_KNOWN).length, 444);
  for (let index = 0; index < 746; index++) {
    assert.deepEqual(f.state.printed[index], { sku: f.input.items[index].sku, status: index < 444 ? 'review' : 'queued',
      inputIndex: index, checked: index + 1, total: 746, resumed: false });
    if (index < 444) assert.deepEqual(terminals[index].classification, f.loaded.rows[index]);
  }
  assert.deepEqual(await originalArtifacts(f), before);
});

for (const [saved, requested, code] of [
  [undefined, SKIP_KNOWN, 'SV_CAMPAIGN_CLASSIFIER_BLOCKED_POLICY_CHANGED'],
  [SKIP_KNOWN, undefined, 'SV_CAMPAIGN_CLASSIFIER_BLOCKED_POLICY_CHANGED'],
  [SKIP_KNOWN, 'skip-known-v2', 'SV_CAMPAIGN_CLASSIFIER_BLOCKED_POLICY_INVALID'],
]) test('direct runner rejects changed or unsupported classifier policy before authority or any journal/action work: ' + String(saved) + ' to ' + String(requested), async t => {
    const f = await productRun(t, { classifierBlockedPolicy: saved });
    f.hooks.classifierBlockedPolicy = requested;
    const before = clone(f.journal.records);
    await assert.rejects(f.execute(), { code });
    assert.deepEqual(f.state.events, []); assert.deepEqual(f.journal.records, before);
  });

for (const initialPolicy of [undefined, SKIP_KNOWN]) test('real main and journal pin ' + String(initialPolicy) + ' policy across resume in both directions', async t => {
  const f = await sealedClassification(t, 1); await reclassify(f, rows => blockedExamples[0].apply(rows[0]));
  const output = path.join(f.directory, 'main-run'), errors = [], actions = [];
  const deployed = { ...runtime, first: { applyWithPreparedValidation() {} }, controlled: { handoffExclusivityVersion: 1 },
    initialNames: { pristineFirstVersion: 1 }, pool: { databaseSecrets: () => [] } };
  const dependencies = { env: {}, runtime: deployed, config: { configured: true, baseUrl: 'https://synthetic-main.invalid' },
    pool: { query: async sql => { assert.equal(sql, 'SELECT current_database() AS name'); return { rows: [{ name: 'sv_campaign_test' }] }; } },
    readAuthority: async () => clone(publication), implementationHash: async () => '9'.repeat(64),
    stages: { advance: async () => { actions.push('fresh'); return { status: 'review', reason: 'SYNTHETIC_FRESH_REVIEW' }; } },
    outbound: { acquireLane: async () => { actions.push('acquire'); return { status: 'acquired', publicIdentityId: '1', release: async () => {} }; },
      handoff: () => assert.fail('Synthetic main fixture stops at fresh review') },
    fetchImpl: () => assert.fail('Synthetic main must never use a network'), print: () => {}, printError: value => errors.push(JSON.parse(value)) };
  const args = (mode, policy) => ['--mode', mode, '--server-root', path.join(__dirname, '..'), '--input', f.inputFile,
    '--input-sha256', rawHash(f.inputBytes), '--classification', f.classification, '--classification-sha256', rawHash(f.manifestBytes),
    '--expected-count', '1', '--output', output, '--expected-database', 'sv_campaign_test', '--actor-id', '7', '--installation-key', 'synthetic',
    ...(policy === undefined ? [] : ['--classifier-blocked-policy', policy])];
  assert.equal(await runner.main(args('run', initialPolicy), dependencies), 2, JSON.stringify(errors));
  const file = path.join(output, 'journal.jsonl'), bytes = await fs.readFile(file);
  const records = journals.parseJournal(bytes, runtime).map(row => row.record);
  assert.equal(Object.hasOwn(records[0], 'classifierBlockedPolicy'), initialPolicy !== undefined);
  assert.equal(records[0].classifierBlockedPolicy, initialPolicy);
  assert.deepEqual(actions, initialPolicy === undefined ? ['acquire', 'fresh'] : []);
  actions.length = 0;
  assert.equal(await runner.main(args('resume', initialPolicy === undefined ? SKIP_KNOWN : undefined), dependencies), 1);
  assert.equal(errors.at(-1).code, 'SV_CAMPAIGN_RUN_CHANGED');
  assert.deepEqual(actions, []); assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(await runner.main(args('resume', initialPolicy), dependencies), 2);
  assert.deepEqual(actions, []);
});

test('a successful local receipt is verified and continued freshly despite a skippable historical classifier row', async t => {
  const f = await productRun(t, { count: 1, classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => blockedExamples[0].apply(rows[0]) });
  const sku = f.input.items[0].sku, prepared = { proof: 'synthetic-local-proof' };
  await f.journal.append({ type: 'prepared', stage: 'names', sku, prepared });
  await f.journal.append({ type: 'receipt', stage: 'names', sku, prepared, receipt: { status: 'recorded' } });
  const summary = await f.execute();
  assert.equal(summary.counts.queued, 1); assert.deepEqual(f.state.actions, [sku]);
  assert.ok(f.state.events.indexOf('verify-local:' + sku) < f.state.events.indexOf('inspect:' + sku));
  assert.equal(f.state.verified.length, 1);
  assert.equal(Object.hasOwn(f.journal.records.find(row => row.type === 'terminal'), 'classificationDecision'), false);
});

for (const prior of ['handoff', 'pending', 'blocked']) test('classifier skip preserves existing ' + prior + ' resume semantics', async t => {
  const f = await productRun(t, { count: 1, classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => blockedExamples[0].apply(rows[0]) });
  const sku = f.input.items[0].sku, stage = prior === 'handoff' ? 'handoff' : 'names', prepared = { command: 'synthetic' };
  await f.journal.append({ type: 'prepared', stage, sku, prepared });
  if (prior !== 'pending') await f.journal.append({ type: 'receipt', stage, sku, prepared,
    receipt: prior === 'blocked' ? { status: 'blocked', code: 'SYNTHETIC_PRIOR_BLOCK' } : { status: 'queued' } });
  const summary = await f.execute(), terminal = f.journal.records.find(row => row.type === 'terminal');
  assert.equal(terminal.status, prior === 'handoff' ? 'queued' : prior === 'pending' ? 'uncertain' : 'review');
  assert.equal(Object.hasOwn(terminal, 'classificationDecision'), false);
  assert.equal(summary.counts.notChecked, 0); assert.deepEqual(f.state.actions, []);
  assert.ok(!f.state.events.some(event => /^(acquire|inspect):/.test(event)));
  assert.equal(f.state.verified.length, prior === 'handoff' ? 1 : 0);
  if (prior === 'blocked') assert.equal(terminal.reason, 'SYNTHETIC_PRIOR_BLOCK');
});

test('authority failure after a classified skip stops the untouched tail and counts only that durable skip', async t => {
  const f = await productRun(t, { classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => rows.forEach(blockedExamples[0].apply) });
  let calls = 0;
  f.hooks.authority = async () => { if (++calls === 2) throw Object.assign(Error('Synthetic authority loss'), { code: 'ECONNRESET' }); };
  const summary = await f.execute();
  assert.equal(summary.globalFailure, 'ECONNRESET'); assert.equal(summary.counts.review, 1); assert.equal(summary.counts.notChecked, 1);
  assert.equal(f.state.printed.length, 1); assert.equal(f.state.printed[0].checked, 1); assert.deepEqual(f.state.actions, []);
});

test('classified skip fsync failure never reports durable progress or processes the tail', async t => {
  let failed = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); if (!String(args[0]).endsWith('journal.jsonl')) return handle;
    return wrapHandle(handle, {
      write: async (buffer, offset, length, position) => {
        if (buffer.subarray(offset, offset + length).toString().includes('"classificationDecision":"skip-known-v1"')) failed = true;
        return handle.write(buffer, offset, length, position);
      },
      sync: async () => { if (failed) throw Object.assign(Error('Synthetic skip fsync failure'), { code: 'EIO' }); await handle.sync(); },
    });
  } };
  const f = await productRun(t, { io, classifierBlockedPolicy: SKIP_KNOWN, mutateRows: rows => rows.forEach(blockedExamples[0].apply) });
  await assert.rejects(f.execute(), error => error.journalFailure === true);
  assert.deepEqual(f.state.actions, []); assert.deepEqual(f.state.printed, []);
  assert.equal(f.state.events.filter(event => event === 'authority').length, 1);
  await f.journal.close();
  await assert.rejects(journals.openJournal({ directory: f.directory, mode: 'resume', header: f.header, runtime }));
});
