const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { evaluateProduct, evaluateBatch, legacyPreview } = require('../src/services/export-templates/evaluate');
const legacy = require('../src/services/magento-products-v1');
const { catalog, product, attributes, dictionaries } = require('./fixtures/magento-v1/contract');
const { headers, cases } = require('./fixtures/magento-v1/expected-rows');
const goldens = require('./fixtures/magento-v1/goldens.json');
const differences = require('./fixtures/export-templates/differences');

test('PR1A replay: every original mapping, branch and negative assertion executes the candidate', (t) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--require', './test/fixtures/export-templates/replay.cjs', '--test',
    'test/magento-v1-characterization.test.js', 'test/magento-v1-categories.test.js', 'test/magento-v1-goldens.test.js'],
  { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summaries = [...result.stdout.matchAll(/PR1B_REPLAY (\{[^\n]+\})/g)].map((m) => JSON.parse(m[1]));
  assert.ok(summaries.length >= 3);
  const total = { maps: {}, batches: {}, differences: {} };
  for (const summary of summaries) for (const kind of Object.keys(total)) {
    for (const [key, count] of Object.entries(summary[kind])) total[kind][key] = (total[kind][key] || 0) + count;
  }
  for (const group of Object.keys(headers)) assert.ok(total.maps[group] > 20 && total.batches[group] > 20, group);
  assert.deepEqual(Object.keys(total.differences).sort(), differences.cases.map((c) => c.id).sort());
  assert.match(result.stdout, /# pass 83/);
  t.diagnostic(JSON.stringify(total));
});

for (const fixture of cases) test(`candidate exact independent UTF-8 golden and every cell: ${fixture.id}`, () => {
  const rules = catalog();
  for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
  const definition = materializeMagentoV1(rules);
  const compiled = compileDefinition(JSON.parse(JSON.stringify(definition)));
  const input = product(fixture.group, fixture.answers, fixture.product);
  const before = structuredClone(input);
  const mapped = evaluateProduct(compiled, input);
  assert.deepEqual(mapped, legacy.mapProduct(input, rules));
  for (const side of ['base', 'english']) for (const field of headers[fixture.group]) {
    assert.equal(mapped[side][field] ?? '', fixture[side][field] ?? '', `${side}.${field}`);
  }
  const result = evaluateBatch(compiled, [input]);
  assert.equal(result.status, 'ready');
  assert.deepEqual(Buffer.from(result.artifacts[0].csvContent, 'utf8'), Buffer.from(goldens[fixture.id], 'utf8'));
  assert.deepEqual(legacyPreview(result), legacy.buildMagentoPayload([input], rules));
  assert.deepEqual(input, before);
});

test('candidate inventory: all 164 positions, 41 bindings and 392 semantic number/string values', () => {
  const d = materializeMagentoV1(catalog());
  const compiled = compileDefinition(d);
  assert.equal(d.groups.reduce((n, g) => n + g.columns.length, 0), 164);
  let bindings = 0; let checks = 0;
  for (const [group, entries] of Object.entries(attributes)) {
    assert.deepEqual(d.groups.find((g) => g.route === group).columns, headers[group]);
    for (const [key, field, dictionary] of entries) {
      bindings++;
      for (const [id, expected] of Object.entries(dictionaries[dictionary])) for (const value of [id, Number(id)]) {
        const input = product(group, { [key]: value }, group === 'SV' ? { magento_name_subject_ua: 'Сова', magento_name_subject_en: 'owl' } : {});
        const actual = evaluateProduct(compiled, input);
        assert.equal(actual.base[field], expected);
        assert.deepEqual(actual, legacy.mapProduct(input, catalog()));
        checks++;
      }
    }
  }
  assert.equal(bindings, 41); assert.equal(checks, 392);
});

test('KL.addit=0 legacy inclusion presence: visible fails, hidden ready; zero remains zero', () => {
  for (const addit of [0, '0']) for (const hidden of [false, true]) {
    const rules = catalog();
    Object.assign(rules.get('KL').get('addit'), { required: 1, visible_if_json: hidden ? { raw_type: 2 } : null });
    const c = compileDefinition(materializeMagentoV1(rules));
    const input = product('KL', { addit });
    const row = evaluateProduct(c, input);
    assert.ok(row.base.categories.endsWith(',Default/Кулони/З інклюзом'));
    assert.equal(row.base.kulony_dodatkovo, '');
    assert.deepEqual(row, legacy.mapProduct(input, rules));
    const result = evaluateBatch(c, [input]);
    assert.equal(result.readyCount, hidden ? 1 : 0);
    assert.equal(result.status, hidden ? 'ready' : 'not-ready');
    assert.equal(input.details.answers.addit, addit);
  }
});

for (const entry of differences.cases) test(`intentional NON-parity ${entry.id}: ${entry.code}`, () => {
  differences.assertOld(entry, legacy.mapProduct(entry.input, entry.rules));
  assert.throws(() => evaluateProduct(compileDefinition(materializeMagentoV1(entry.rules)), entry.input), { code: entry.code });
  assert.throws(() => evaluateBatch(compileDefinition(materializeMagentoV1(entry.rules)), [entry.input]), { code: entry.code });
});
for (const entry of differences.supplemental) test(`intentional NON-parity ${entry.id}: INPUT_INVALID`, () => {
  const rules = catalog();
  differences.assertOld(entry, legacy.mapProduct(entry.input, rules));
  assert.throws(() => evaluateBatch(compileDefinition(materializeMagentoV1(rules)), [entry.input]), { code: 'INPUT_INVALID' });
});
for (const value of [0, false]) test(`intentional NON-parity category ${JSON.stringify(value)}: INPUT_INVALID`, () => {
  const input = product('BR', {}, { category: value });
  assert.deepEqual(legacy.mapProduct(input, catalog()), { group: '', sku: input.full_sku,
    errors: [{ field: 'attribute_set_code', message: 'Немає Magento-профілю для категорії.' }] });
  assert.throws(() => evaluateBatch(compileDefinition(materializeMagentoV1(catalog())), [input]), { code: 'INPUT_INVALID' });
});
for (const entry of differences.catalogCases) test(`intentional NON-parity ${entry.id}: TEMPLATE_INVALID`, () => {
  differences.assertOld(entry, legacy.mapProduct(entry.input, entry.rules));
  assert.throws(() => materializeMagentoV1(entry.rules), { code: 'TEMPLATE_INVALID' });
});
