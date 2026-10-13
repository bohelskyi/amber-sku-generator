const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const discovery = require('../scripts/first-sync-local-discovery');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const c = require('../src/services/magento/binding-contract');
const normalize = require('../src/services/magento/first-sync-field-plan').normalizeDecimal;
const audit = require('../src/services/magento/binding-evidence-audit');

const binding = '11111111-1111-4111-8111-111111111111';
const definitionHash = 'a'.repeat(64);
const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, publicationHash: 'b'.repeat(64) };
const config = { configured: true, baseUrl: 'https://discovery.example.invalid' };
const clone = value => structuredClone(value);
const field = (target = 'meta_title', scope = 'all', local = 'Amber title', remote = 'Magento title') => ({ target, scope, local, remote });
const candidate = (id = 1, fields = [field()]) => ({ sku: 'NM' + id, productId: id, category: 'NM', remoteProductId: null, fields });

function scenario(item = candidate()) {
  const product = { id: item.productId, public_product_identity_id: binding, full_sku: item.sku + '-internal',
    public_sku: item.sku, category: item.category, status: 'active', exclude_from_export: 0,
    corrected_to_product_id: null, sku_schema_version_id: binding, characteristic_version_id: null,
    weight: '12.400', total_price_uah: '1200.00', details: { answers: { color: '1' } },
    exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false, independentExclusion: false },
    is_test_product: false };
  const observation = { amber: { product, revision: { id: binding }, compiled: { hash: definitionHash } },
    raw: { id: 1000 + item.productId, sku: item.sku } };
  const report = { generatedAt: '2026-10-12T00:00:00.000Z', mode: 'update',
    identity: { state: 'found', article: item.sku, observedMagentoId: observation.raw.id },
    amberProduct: { publicSku: item.sku }, evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true, blockers: [] };
  const base = { mode: 'first', observation, blockers: [], first: { progress: { fields: [] } },
    fields: item.fields.map(f => ({ target: f.target, scope: f.scope,
      local: { known: true, present: true, value: f.local }, remote: { known: true, present: true, value: f.remote }, canKeepLocal: true })),
    projection: { projection: item.fields.map(f => ({ target: f.target, scope: f.scope,
      persistence: ['decor_weight', 'vaha_vyrobu'].includes(f.target) ? 'weight' : f.target })) } };
  return { item, product, observation, report, base, remainingBlockers: [], preparedRows: null, freshProduct: null };
}

function runtimeFor(scenarios) {
  const calls = [];
  const runtime = { c, batch, normalize, audit, pool: { databaseSecrets: () => [] },
    preview: async (_config, options) => {
      calls.push({ stage: 'preview', sku: options.sku, options });
      const current = scenarios.find(s => s.item.sku === options.sku);
      options.onObservation(current.observation);
      return current.report;
    },
    first: {
      inspect: async (_config, observation) => {
        calls.push({ stage: 'inspect', sku: observation.raw.sku });
        return scenarios.find(s => s.observation === observation).base;
      },
      prepareDecision: async (_config, base, choices) => {
        calls.push({ stage: 'prepare', sku: base.observation.raw.sku, choices });
        const current = scenarios.find(s => s.base === base);
        return { prepared: { blockers: current.remainingBlockers,
          rows: current.preparedRows || choices.map(f => ({ target: f.target, scope: f.scope, received: false,
            record: { state: 'pending_outward_confirmation' } })) } };
      },
    },
    readSnapshot: async (_pool, input) => {
      calls.push({ stage: 'snapshot', sku: input.sku });
      const current = scenarios.find(s => s.item.sku === input.sku);
      return { product: current.freshProduct || clone(current.product) };
    },
  };
  return { runtime, calls };
}

async function inspect(s) {
  const f = runtimeFor([s]);
  f.result = await discovery.inspectCandidate(f.runtime, config, s.item, publication,
    { databasePool: {}, actorUserId: 7, installation: 'amber', sensitiveValues: [], fetchImpl: async () => { throw Error('Unexpected fetch'); } });
  return f;
}
const hasBlocker = (result, code) => assert.ok(result.blockers.some(b => b.code === code), JSON.stringify(result));

async function fixture(t, items = [candidate()]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-discovery-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenarios = items.map(item => scenario(item)), f = runtimeFor(scenarios), messages = [], errors = [], queries = [];
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'results');
  await fs.writeFile(input, JSON.stringify({ items }));
  const dependencies = { runtime: f.runtime, config, env: {}, print: value => messages.push(JSON.parse(value)),
    printError: value => errors.push(JSON.parse(value)), readAuthority: async () => clone(publication),
    pool: { query: async sql => {
      queries.push(sql);
      if (sql === 'SELECT current_database() AS name') return { rows: [{ name: 'discovery_fixture_test' }] };
      if (sql === 'SHOW default_transaction_read_only') return { rows: [{ default_transaction_read_only: 'on' }] };
      assert.fail('Unexpected SQL: ' + sql);
    } } };
  return { ...f, dir, input, output, scenarios, messages, errors, queries, dependencies };
}
const args = f => ['--input', f.input, '--output-dir', f.output, '--expected-database', 'discovery_fixture_test',
  '--actor-id', '7', '--installation-key', 'amber'];
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const journal = async f => (await fs.readFile(path.join(f.output, 'results.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('runtime loads the direct ordinary preview and existing services without invoking them', () => {
  const runtime = discovery.createRuntime(path.join(__dirname, '..'));
  assert.equal(runtime.preview, require('../src/services/magento/sync-preview').previewProduct);
  assert.equal(runtime.first, require('../src/services/magento/first-sync.service'));
  assert.equal(runtime.batch, batch);
  assert.equal(runtime.readSnapshot, require('../src/services/magento/sync-preview-db').readPreviewProduct);
});

test('approved Manager price, rounding-only weight and bilingual SEO produce a canonical local-batch packet', async () => {
  const fields = [field('price', 'all', 1200, '1500.00'), field('decor_weight', 'all', '12.400', 12),
    field(), field('meta_title', 'en', 'Amber English', 'Magento English'),
    field('meta_description', 'all', 'Опис Amber', 'Опис Magento'), field('meta_description', 'en', 'Amber description', 'Magento description')];
  const s = scenario(candidate(1, fields));
  s.item.expectedProduct = batch.source(s.product);
  const { result, calls } = await inspect(s);
  assert.equal(result.status, 'candidate');
  assert.equal(result.remoteProductId, 1001);
  assert.deepEqual(result.packetItem, { sku: 'NM1', expectedProduct: batch.source(s.product), remoteProductId: 1001, fields });
  assert.doesNotThrow(() => batch.command({ bindingRevisionId: binding, expectedDefinitionHash: definitionHash, items: [result.packetItem] }));
  assert.deepEqual(calls.map(call => call.stage), ['preview', 'inspect', 'prepare', 'snapshot']);
  assert.ok(calls[2].choices.every(choice => choice.choice === 'keep_local'));
  assert.equal(calls[0].options.sku, 'NM1');
  assert.equal(calls[0].options.bindingRevisionId, binding);
});

test('identity is exact across local SKU, product ID/category and observed Magento identity', async t => {
  const cases = {
    'remote SKU differs': s => { s.observation.raw.sku = 'NM10'; },
    'reported article differs': s => { s.report.identity.article = 'nm1'; },
    'local SKU differs': s => { s.product.public_sku = 'NM10'; },
    'reported local SKU differs': s => { s.report.amberProduct.publicSku = 'NM10'; },
    'local product ID differs': s => { s.product.id = 2; },
    'local category differs': s => { s.product.category = 'SV'; },
    'remote ID differs from observation': s => { s.observation.raw.id = 1002; },
    'frozen remote ID differs': s => { s.item.remoteProductId = 1002; },
    'missing remote identity': s => { s.report.identity.state = 'missing'; },
    'unsafe remote ID': s => { s.report.identity.observedMagentoId = Number.MAX_SAFE_INTEGER + 1; },
    'create preview': s => { s.report.mode = 'create'; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const s = scenario(); change(s);
    const { result, calls } = await inspect(s);
    hasBlocker(result, 'DISCOVERY_EXACT_IDENTITY_REQUIRED');
    assert.equal(result.packetItem, undefined);
    assert.deepEqual(calls.map(call => call.stage), ['preview']);
  });
});

test('frozen SEO drift is retained for review and never replaced silently', async () => {
  const s = scenario(), original = clone(s.item);
  s.base.fields[0].remote.value = 'Changed Magento title';
  const { result, calls } = await inspect(s);
  hasBlocker(result, 'DISCOVERY_FROZEN_FIELD_CHANGED');
  assert.deepEqual(result.changes, [{ target: 'meta_title', scope: 'all',
    frozen: { local: 'Amber title', remote: 'Magento title' }, fresh: { local: 'Amber title', remote: 'Changed Magento title' } }]);
  assert.deepEqual(s.item, original);
  assert.deepEqual(result.sourceSnapshot, batch.source(s.product));
  assert.ok(!calls.some(call => call.stage === 'prepare'));
  assert.equal(result.packetItem, undefined);
});

test('numeric representations use canonical scale comparison and preserve freshly observed values', async () => {
  const s = scenario(candidate(1, [field('price', 'all', '1200.00', 1500)]));
  s.base.fields[0].local.value = 1200;
  s.base.fields[0].remote.value = '1500.000';
  const { result } = await inspect(s);
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.packetItem.fields, [field('price', 'all', 1200, '1500.000')]);
  assert.equal(s.item.fields[0].local, '1200.00');
});

test('only repository-proven rounding differences in physical weight are candidates', async t => {
  for (const [local, remote, ready] of [['12.4', 12, true], ['12.6', 13, true], ['12.5', 12, true],
    ['12.5', 13, true], ['12.4', 13, false], ['12.4', '12.3', false], ['12', 13, false], ['-1.4', -1, false]]) {
    await t.test(local + ' to ' + remote, async () => {
      const { result } = await inspect(scenario(candidate(1, [field('decor_weight', 'all', local, remote)])));
      assert.equal(batch.roundedWeight(local, remote), ready);
      if (ready) assert.equal(result.status, 'candidate');
      else { hasBlocker(result, 'DISCOVERY_WEIGHT_NOT_ROUNDING_ONLY'); assert.equal(result.packetItem, undefined); }
    });
  }
  const s = scenario(candidate(1, [field('vaha_vyrobu', 'all', '12.4', 12)]));
  s.base.projection.projection[0].persistence = 'answer';
  hasBlocker((await inspect(s)).result, 'DISCOVERY_PHYSICAL_WEIGHT_NOT_PROVEN');
});

test('unknown, empty and inherited SEO retain existing eligibility blockers', async t => {
  for (const side of ['local', 'remote']) {
    await t.test(side + ' unknown', async () => {
      const s = scenario(); s.base.fields[0][side].known = false;
      hasBlocker((await inspect(s)).result, 'DISCOVERY_FIELD_UNKNOWN');
    });
    await t.test(side + ' empty', async () => {
      const s = scenario(); s.item.fields[0][side] = ''; s.base.fields[0][side] = { known: true, present: false, value: '' };
      hasBlocker((await inspect(s)).result, 'DISCOVERY_EMPTY_FIELD_REVIEW_REQUIRED');
    });
  }
  const inherited = scenario(candidate(1, [field('meta_title', 'en')]));
  inherited.base.fields[0].remote.inherited = true;
  inherited.base.fields[0].canKeepLocal = false;
  const { result, calls } = await inspect(inherited);
  hasBlocker(result, 'DISCOVERY_LOCAL_CHOICE_UNAVAILABLE');
  assert.ok(!calls.some(call => call.stage === 'prepare'));
});

test('history, ordinary workflow and unresolved ordinary payload blockers do not become packets', async t => {
  for (const mode of ['history_review', 'ordinary', 'blocked']) await t.test(mode, async () => {
    const s = scenario(); s.base.mode = mode;
    s.base.historyReview = { reason: 'HISTORICAL_EXPOSURE' };
    const { result, calls } = await inspect(s);
    hasBlocker(result, mode === 'ordinary' ? 'DISCOVERY_ORDINARY_WORKFLOW_REQUIRED' : 'DISCOVERY_FIRST_SYNC_REVIEW_REQUIRED');
    assert.deepEqual(result.historyReview, s.base.historyReview);
    assert.equal(result.packetItem, undefined);
    assert.ok(!calls.some(call => call.stage === 'prepare'));
  });
  const s = scenario(); s.report.sendable = false;
  s.report.blockers = [{ code: 'MAGENTO_ATTRIBUTE_REVIEW_REQUIRED', target: 'kolir', scope: 'all', untrusted: 'omitted' }];
  const { result } = await inspect(s);
  hasBlocker(result, 'DISCOVERY_ORDINARY_PAYLOAD_NOT_READY');
  assert.deepEqual(result.ordinaryBlockers, [{ code: 'MAGENTO_ATTRIBUTE_REVIEW_REQUIRED', target: 'kolir', scope: 'all' }]);
});

test('unselected discrepancies and first-sync planner decisions cannot be silently cleared', async () => {
  const s = scenario(); s.remainingBlockers = [{ code: 'MAGENTO_FIRST_SYNC_CONFLICT', target: 'size', scope: 'all' }];
  hasBlocker((await inspect(s)).result, 'MAGENTO_FIRST_SYNC_CONFLICT');
  s.remainingBlockers = [];
  s.preparedRows = [{ target: 'meta_title', scope: 'all', received: false, record: { state: 'imported', after: 'Magento title' } }];
  const { result } = await inspect(s);
  hasBlocker(result, 'DISCOVERY_LOCAL_CHOICE_UNAVAILABLE');
  assert.equal(result.packetItem, undefined);
});

test('lifecycle, frozen source and a changed final snapshot all block packet creation', async t => {
  const changes = [s => { s.product.status = 'archived'; }, s => { s.product.corrected_to_product_id = 2; },
    s => { s.product.exclude_from_export = 1; }, s => { s.product.is_test_product = true; },
    s => { s.product.exportState.route = 'held'; }, s => { s.product.exportState.business_exclusion_state = 'excluded'; },
    s => { s.product.exportState.recount_compatibility_excluded = true; }, s => { s.product.exportState.independentExclusion = true; }];
  for (const [index, change] of changes.entries()) await t.test('lifecycle ' + index, async () => {
    const s = scenario(); change(s); hasBlocker((await inspect(s)).result, 'DISCOVERY_LIFECYCLE_NOT_NORMAL');
  });
  const frozen = scenario(); frozen.item.expectedProduct = batch.source(frozen.product); frozen.product.weight = '12.5';
  hasBlocker((await inspect(frozen)).result, 'DISCOVERY_FROZEN_SOURCE_CHANGED');
  for (const key of ['weight', 'exportState', 'is_test_product']) await t.test('final snapshot ' + key, async () => {
    const s = scenario(); s.freshProduct = clone(s.product);
    s.freshProduct[key] = key === 'weight' ? '13.4' : key === 'exportState' ? { ...s.product.exportState, route: 'held' } : true;
    hasBlocker((await inspect(s)).result, 'DISCOVERY_SOURCE_CHANGED_DURING_READ');
  });
});

test('equal selected values are no-change unless canonical SEO initial readback is pending', async () => {
  const s = scenario(candidate(1, [field('meta_title', 'all', 'Same', 'Same')]));
  assert.equal((await inspect(s)).result.status, 'no_selected_change');
  s.base.first.progress.fields.push({ target: 'meta_title', scope: 'all', state: 'seo_pending_initial_readback' });
  assert.equal((await inspect(s)).result.status, 'candidate');
});

test('more than ten candidates are read sequentially with per-SKU checkpoints and canonical bounded packets', async t => {
  const f = await fixture(t, Array.from({ length: 21 }, (_, index) => candidate(index + 1)));
  const original = f.runtime.preview; let active = false, count = 0;
  f.runtime.preview = async (...params) => {
    assert.equal(active, false); active = true;
    const saved = await journal(f);
    assert.equal(saved.filter(line => line.kind === 'result').length, count);
    assert.deepEqual((await fs.readdir(f.output)), ['results.jsonl']);
    await new Promise(resolve => setImmediate(resolve));
    const result = await original(...params); count++; active = false; return result;
  };
  assert.equal(await discovery.main([...args(f), '--limit', '21'], f.dependencies), 0, JSON.stringify(f.errors));
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.candidates, 21);
  assert.deepEqual(manifest.packets.map(packet => packet.count), [10, 10, 1]);
  assert.equal(manifest.directRemoteWrites, 0);
  assert.equal(manifest.directlyEnqueuedJobs, 0);
  for (const packetInfo of manifest.packets) {
    const packet = await json(path.join(f.output, packetInfo.file));
    assert.doesNotThrow(() => batch.command(packet));
    assert.equal(c.hash(packet), packetInfo.sha256);
  }
  assert.deepEqual(f.calls.filter(call => call.stage === 'preview').map(call => call.sku), f.scenarios.map(s => s.item.sku));
  assert.equal(f.messages.filter(message => message.stage === 'discovery').length, 21);
  assert.equal((await journal(f)).length, 23);
});

test('offset/default limit preserve input order and resumable nextOffset without exceeding ten', async t => {
  const f = await fixture(t, Array.from({ length: 15 }, (_, index) => candidate(index + 1)));
  assert.equal(await discovery.main([...args(f), '--offset', '2'], f.dependencies), 0);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.checked, 10);
  assert.equal(manifest.nextOffset, 12);
  assert.equal(manifest.remainingInput, 3);
  const packet = await json(path.join(f.output, manifest.packets[0].file));
  assert.deepEqual(packet.items.map(item => item.sku), Array.from({ length: 10 }, (_, index) => 'NM' + (index + 3)));
});

test('publication or permission revocation invalidates all previously discovered candidate packets', async t => {
  for (const code of ['DISCOVERY_PUBLICATION_CHANGED', 'ACTOR_NOT_ACTIVE']) await t.test(code, async t => {
    const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]); let reads = 0;
    f.dependencies.readAuthority = async () => {
      if (++reads === 5) {
        if (code === 'ACTOR_NOT_ACTIVE') throw Object.assign(Error('Revoked'), { code, statusCode: 403 });
        return { ...publication, expectedDefinitionHash: 'c'.repeat(64) };
      }
      return clone(publication);
    };
    assert.equal(await discovery.main(args(f), f.dependencies), 2);
    const manifest = await json(path.join(f.output, 'manifest.json'));
    assert.equal(manifest.complete, false);
    assert.equal(manifest.globalFailure, code);
    assert.equal(manifest.candidates, 0);
    assert.equal(manifest.invalidatedCandidates, 1);
    assert.equal(manifest.notChecked, 1);
    assert.deepEqual(manifest.packets, []);
    assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl']);
  });
});

test('final authority check also invalidates every candidate before any packet is written', async t => {
  const f = await fixture(t); let reads = 0;
  f.dependencies.readAuthority = async () => ++reads === 4 ? { ...publication, publicationHash: 'c'.repeat(64) } : clone(publication);
  assert.equal(await discovery.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.invalidatedCandidates, 1);
  assert.deepEqual(manifest.packets, []);
});

test('second-SKU observed publication drift invalidates prior candidates even when authority reads stay unchanged', async t => {
  const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
  f.scenarios[1].observation.amber.revision.id = '22222222-2222-4222-8222-222222222222';
  assert.equal(await discovery.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.globalFailure, 'DISCOVERY_PUBLICATION_CHANGED');
  assert.equal(manifest.complete, false);
  assert.equal(manifest.candidates, 0);
  assert.equal(manifest.invalidatedCandidates, 1);
  assert.equal(manifest.checked, 2);
  assert.equal(manifest.notChecked, 1);
  assert.deepEqual(manifest.packets, []);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl']);
  assert.deepEqual(f.calls.filter(call => call.stage === 'preview').map(call => call.sku), ['NM1', 'NM2']);
  const records = await journal(f);
  assert.deepEqual(records[2].blockers, [{ code: 'DISCOVERY_PUBLICATION_CHANGED' }]);
});

test('second-SKU authority connection failure aborts the whole run and invalidates prior candidates', async t => {
  const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
  const failure = Object.assign(Error('Private database connection detail'), { code: 'ECONNRESET' });
  let reads = 0;
  f.dependencies.readAuthority = async () => {
    if (++reads === 4) throw failure;
    return clone(publication);
  };
  assert.equal(await discovery.main(args(f), f.dependencies), 2);
  assert.equal(failure.discoveryAuthorityFailure, true);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.globalFailure, 'ECONNRESET');
  assert.equal(manifest.complete, false);
  assert.equal(manifest.candidates, 0);
  assert.equal(manifest.invalidatedCandidates, 1);
  assert.equal(manifest.checked, 2);
  assert.equal(manifest.notChecked, 1);
  assert.deepEqual(manifest.packets, []);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl']);
  assert.deepEqual(f.calls.filter(call => call.stage === 'preview').map(call => call.sku), ['NM1']);
  const records = await journal(f);
  assert.deepEqual(records[2].blockers, [{ code: 'ECONNRESET' }]);
  assert.ok(!JSON.stringify(records).includes('Private database connection detail'));
});

test('private output is exclusive and existing evidence is preserved byte for byte', async t => {
  const f = await fixture(t);
  assert.equal(await discovery.main(args(f), f.dependencies), 0);
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o700);
  const names = await fs.readdir(f.output), before = new Map();
  for (const name of names) {
    const file = path.join(f.output, name); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    before.set(name, await fs.readFile(file, 'utf8'));
  }
  const previousCalls = f.calls.length;
  assert.equal(await discovery.main(args(f), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'DISCOVERY_OUTPUT_EXISTS');
  assert.equal(f.calls.length, previousCalls);
  for (const name of names) assert.equal(await fs.readFile(path.join(f.output, name), 'utf8'), before.get(name));
});

test('database mismatch, non-read-only connection and frozen publication mismatch abort before discovery', async t => {
  for (const code of ['DISCOVERY_DATABASE_MISMATCH', 'DISCOVERY_READ_ONLY_DATABASE_REQUIRED', 'DISCOVERY_FROZEN_PUBLICATION_CHANGED']) {
    await t.test(code, async t => {
      const f = await fixture(t);
      if (code === 'DISCOVERY_DATABASE_MISMATCH') f.dependencies.pool.query = async () => ({ rows: [{ name: 'other_test' }] });
      if (code === 'DISCOVERY_READ_ONLY_DATABASE_REQUIRED') {
        f.dependencies.pool.query = async sql => ({ rows: [sql.startsWith('SELECT') ? { name: 'discovery_fixture_test' } : { default_transaction_read_only: 'off' }] });
      }
      if (code === 'DISCOVERY_FROZEN_PUBLICATION_CHANGED') await fs.writeFile(f.input, JSON.stringify({
        items: [candidate()], bindingRevisionId: binding, expectedDefinitionHash: 'c'.repeat(64) }));
      assert.equal(await discovery.main(args(f), f.dependencies), 1);
      assert.equal(f.errors[0].code, code);
      assert.equal(f.calls.length, 0);
      await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    });
  }
});

test('a per-SKU read failure is sanitized, checkpointed and does not silently skip the next candidate', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]), original = f.runtime.preview;
  f.runtime.preview = async (...params) => {
    if (params[1].sku === 'NM1') throw Object.assign(Error('secret connection detail'), { code: 'ECONNRESET' });
    return original(...params);
  };
  assert.equal(await discovery.main(args(f), f.dependencies), 2);
  const records = await journal(f), manifest = await json(path.join(f.output, 'manifest.json'));
  assert.deepEqual(records[1].blockers, [{ code: 'ECONNRESET' }]);
  assert.equal(manifest.checked, 2); assert.equal(manifest.blocked, 1); assert.equal(manifest.candidates, 1);
  assert.ok(!JSON.stringify(records).includes('secret connection detail'));
});

test('help requires no configuration, dependencies, connection or output artifact', async () => {
  const lines = [];
  const dependencies = { env: {}, print: line => lines.push(line), printError: () => assert.fail('Unexpected error') };
  Object.defineProperty(dependencies, 'runtime', { get() { assert.fail('Help loaded runtime'); } });
  Object.defineProperty(dependencies, 'pool', { get() { assert.fail('Help opened database'); } });
  assert.equal(await discovery.main(['--help'], dependencies), 0);
  assert.match(lines[0], /Read-only exact SKU discovery/);
});

test('GET firewall never delegates mutations, body-bearing requests or Request method bypasses', async () => {
  const calls = [], get = discovery.getOnly(async (...params) => { calls.push(params); return 'read'; });
  assert.equal(await get('https://discovery.example.invalid'), 'read');
  assert.equal(await get('https://discovery.example.invalid', { method: 'get' }), 'read');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    assert.throws(() => get('https://discovery.example.invalid', { method }), { code: 'DISCOVERY_REMOTE_WRITE_DENIED' });
    assert.throws(() => get(new Request('https://discovery.example.invalid', { method })), { code: 'DISCOVERY_REMOTE_WRITE_DENIED' });
  }
  assert.throws(() => get('https://discovery.example.invalid', { method: 'GET', body: 'data' }), { code: 'DISCOVERY_REMOTE_WRITE_DENIED' });
  assert.equal(calls.length, 2);
});

test('input contract refuses unapproved policies, fields, duplicate identities and sparse candidates', () => {
  const runtime = { c, batch };
  assert.doesNotThrow(() => discovery.validateInput({ items: [candidate()] }, runtime));
  const changes = [i => { i.items[0].fields[0].policy = 'accept_remote'; }, i => { i.items[0].fields[0].target = 'media_gallery'; },
    i => { i.items[0].fields = [field('price', 'en', 1, 2)]; }, i => { i.items[0].sku = ' NM1'; },
    i => { i.items[0].remoteProductId = '1001'; }, i => { i.items[0].fields[0].local = {}; },
    i => { i.items.push(clone(i.items[0])); }, i => { i.items.push({ ...candidate(2), productId: 1 }); },
    i => { i.items = Array(1); }, i => { i.bindingRevisionId = binding; }, i => { i.items[0].fields.push(clone(i.items[0].fields[0])); }];
  for (const change of changes) { const input = { items: [candidate()] }; change(input); assert.throws(() => discovery.validateInput(input, runtime)); }
  for (const invalid of [[], ['--apply'], ['--help', '--limit', '1'], ['--limit', '2001'],
    ['--input', 'a', '--input', 'b'], ['--mode', 'apply']]) assert.throws(() => discovery.argumentsFor(invalid), { code: 'DISCOVERY_ARGUMENTS' });
});
