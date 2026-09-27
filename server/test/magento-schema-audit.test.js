const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { auditMagentoSchema, normalizeOptions, normalizeAttribute } = require('../src/services/magento/schema-audit');
const { describeMapper } = require('../src/services/magento/mapper-schema');
const { parseMagentoConfig } = require('../src/config/magento');
const { runSchemaAudit, parseArguments } = require('../scripts/magento-schema-audit');
const legacy = require('../src/services/magento-products-v1');
const data = require('../src/services/export-templates/magento-v1-data');

const env = { MAGENTO_BASE_URL: 'https://schema.example.invalid',
  MAGENTO_CONSUMER_KEY: 'synthetic-consumer-key', MAGENTO_CONSUMER_SECRET: 'synthetic-consumer-secret&',
  MAGENTO_ACCESS_TOKEN: 'synthetic-access-token', MAGENTO_ACCESS_TOKEN_SECRET: 'synthetic-token-secret/' };
const config = parseMagentoConfig(env);
const attr = (id, code, input = 'text') => ({ attribute_id: id, attribute_code: code,
  default_frontend_label: code, frontend_input: input, backend_type: 'varchar',
  is_required: false, is_unique: '0', is_user_defined: true, is_visible: true,
  is_searchable: '0', is_filterable: false, scope: 'store', ignored: env });
function fixture() {
  const attributes = [attr(32, 'kolir', 'select'), attr(13, 'kamin_suvenirnyi', 'multiselect'),
    attr(6, 'name'), attr(7, 'unused_attribute', 'select')];
  const sets = [{ attribute_set_id: 151, attribute_set_name: 'Сувеніри', sort_order: 3, entity_type_id: 4 },
    { attribute_set_id: 144, attribute_set_name: 'Камінь' },
    { attribute_set_id: 4, attribute_set_name: 'Браслети' },
    { attribute_set_id: 142, attribute_set_name: 'Кулони ' },
    { attribute_set_id: 141, attribute_set_name: 'Чотки' },
    { attribute_set_id: 143, attribute_set_name: 'Чотки' }];
  return {
    'store/websites': [{ id: 2, code: 'second', name: 'Second', default_group_id: 2 },
      { id: 1, code: 'base', name: 'Base', default_group_id: 1 }],
    'store/storeGroups': [{ id: 1, website_id: 1, root_category_id: 2, default_store_id: 3, name: 'Group', code: 'main_group' },
      { id: 2, website_id: 2, root_category_id: 7, default_store_id: 4, name: 'Group 2' }],
    'store/storeViews': [{ id: 4, code: 'en_custom', name: 'English', website_id: 2, store_group_id: 2, is_active: 0 },
      { id: 3, code: 'ua_custom', name: 'Українська', website_id: 1, store_group_id: 1, is_active: true }],
    'products/attribute-sets/sets/list': { items: sets, total_count: sets.length },
    'products/attributes': { items: attributes, total_count: attributes.length },
    ...Object.fromEntries(sets.map((s) => [`products/attribute-sets/${s.attribute_set_id}/attributes`,
      s.attribute_set_id === 144 ? [attributes[1], attributes[2]] : attributes])),
    'products/attributes/kolir/options': [{ value: '992', label: 'Темний', sort_order: 2, is_default: false },
      { value: '', label: 'Choose' }, { value: '881', label: 'Світлий' },
      { value: '882', label: 'Світлий' }, { value: '777', label: 'Extra' }],
    'products/attributes/kamin_suvenirnyi/options': [{ value: '600', label: 'З інклюзом' }, { value: 0, label: 'На підставці' }],
    'products/attributes/unused_attribute/options': [{ value: '999', label: 'Unreferenced option' }],
    'products/attributes/name/options': [],
  };
}
function mockFetch(routes, calls = [], storeCode = 'all') {
  return async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, config.baseUrl);
    assert.ok(parsed.pathname.startsWith(`/rest/${storeCode}/V1/`));
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'manual');
    const route = parsed.pathname.split('/V1/')[1];
    assert.notEqual(route, 'products', 'Must never enumerate products');
    assert.ok(Object.hasOwn(routes, route), `Unexpected route: ${route}`);
    calls.push(route);
    const body = typeof routes[route] === 'function' ? routes[route](parsed, options) : routes[route];
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
}
const audit = (routes = fixture()) => auditMagentoSchema(config, { fetchImpl: mockFetch(routes) });

test('product-type applicability and source model survive discovery with canonical array comparison', async () => {
  const routes = fixture();
  const input = routes['products/attributes'].items[0];
  input.apply_to = ['simple', 'bundle'];
  input.source_model = 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Boolean';
  const observed = (await audit(routes)).attributes.find((a) => a.attribute_code === input.attribute_code);
  assert.deepEqual(observed.apply_to, ['bundle', 'simple']);
  assert.equal(observed.source_model, input.source_model);
  for (const apply_to of ['simple', [null], ['../bad'], [1], {}]) {
    assert.throws(() => normalizeAttribute({ ...input, apply_to }), { code: 'MAGENTO_RESPONSE_INVALID' });
  }
  assert.equal(normalizeAttribute({ ...input, apply_to: null }).apply_to, undefined);
  routes['products/attribute-sets/151/attributes'] = routes['products/attribute-sets/151/attributes']
    .map((a) => a.attribute_code === input.attribute_code ? { ...a, apply_to: ['downloadable'] } : a);
  await assert.rejects(audit(routes), { code: 'MAGENTO_RESPONSE_INVALID' });
});

test('normalizes topology, actual set identities, membership and select/multiselect options', async () => {
  const report = await audit();
  assert.deepEqual(report.storeTopology.websites.map((w) => w.id), [1, 2]);
  assert.equal(report.storeTopology.storeGroups[0].root_category_id, 2);
  assert.equal(report.storeTopology.storeViews[0].code, 'ua_custom');
  assert.equal(report.storeTopology.storeViews[1].is_active, false);
  const set = report.attributeSets.find((s) => s.attribute_set_id === 151);
  assert.equal(set.attribute_set_name, 'Сувеніри');
  assert.equal(set.entity_type_id, 4);
  assert.deepEqual(set.attributeCodes, ['kamin_suvenirnyi', 'kolir', 'name', 'unused_attribute']);
  const color = report.attributes.find((a) => a.attribute_code === 'kolir');
  assert.equal(color.optionCount, 5);
  assert.equal(color.is_visible, true);
  assert.equal(color.is_required, false);
  assert.equal(color.is_filterable, false);
  assert.equal(color.scope, 'store');
  assert.deepEqual(color.options[0], { value: '', label: 'Choose', isEmpty: true });
  const multi = report.attributes.find((a) => a.attribute_code === 'kamin_suvenirnyi');
  assert.equal(multi.frontend_input, 'multiselect');
  assert.deepEqual(multi.options[0], { value: '0', label: 'На підставці', isEmpty: false });
  assert.deepEqual(report.unmappedMagentoAttributes, ['unused_attribute']);
  assert.equal(report.attributes.find((a) => a.attribute_code === 'unused_attribute').options[0].value, '999');
});

test('product attribute metadata follows Magento 2.4.6 field return types', async () => {
  const base = attr(1383, 'am_shipping_type', 'select');
  const boolNullable = ['is_user_defined', 'is_visible', 'is_filterable', 'is_filterable_in_search'];
  const stringNullable = ['default_frontend_label', 'backend_type', 'is_unique', 'is_searchable',
    'is_visible_on_front', 'is_used_for_promo_rules', 'scope'];
  for (const field of boolNullable) {
    for (const valid of [true, false, null]) {
      const normalized = normalizeAttribute({ ...base, [field]: valid });
      assert.equal(normalized[field], valid === null ? undefined : valid);
    }
    for (const invalid of ['true', 'false', 0, 1, [], { remoteMessage: env.MAGENTO_ACCESS_TOKEN }]) {
      assert.throws(() => normalizeAttribute({ ...base, [field]: invalid }), { code: 'MAGENTO_RESPONSE_INVALID' });
    }
  }
  for (const field of stringNullable) {
    assert.equal(normalizeAttribute({ ...base, [field]: null })[field], undefined);
    assert.equal(normalizeAttribute({ ...base, [field]: '0' })[field], '0');
    for (const invalid of [true, 0, [], { remoteMessage: env.MAGENTO_ACCESS_TOKEN }]) {
      assert.throws(() => normalizeAttribute({ ...base, [field]: invalid }), { code: 'MAGENTO_RESPONSE_INVALID' });
    }
  }
  for (const valid of [true, false]) assert.equal(normalizeAttribute({ ...base, is_required: valid }).is_required, valid);
  for (const invalid of [null, 'false', 0, [], {}]) {
    assert.throws(() => normalizeAttribute({ ...base, is_required: invalid }), { code: 'MAGENTO_RESPONSE_INVALID' });
  }
  assert.deepEqual(normalizeAttribute(base), normalizeAttribute(structuredClone(base)));

  const routes = fixture();
  routes['products/attributes'].items.push(base);
  routes['products/attributes'].total_count++;
  routes['products/attributes/am_shipping_type/options'] = [{ value: '', label: '' }];
  const report = await audit(routes);
  assert.equal(report.attributes.find((a) => a.attribute_code === 'am_shipping_type').is_filterable, false);
  assert.deepEqual(report.mapperAttributes, (await audit()).mapperAttributes);
  assert.deepEqual(report.optionComparisons, (await audit()).optionComparisons);
});

test('null frontend input remains valid schema but is reviewable on mapper targets', async () => {
  const system = { ...attr(126, 'links_exist', null), default_frontend_label: '',
    is_user_defined: false, is_visible: false };
  assert.equal(normalizeAttribute(system).frontend_input, null);
  for (const invalid of ['', 0, 1, [], { remoteMessage: env.MAGENTO_ACCESS_TOKEN }]) {
    assert.throws(() => normalizeAttribute({ ...system, frontend_input: invalid }),
      { code: 'MAGENTO_RESPONSE_INVALID' });
  }
  assert.throws(() => normalizeAttribute({ ...system, attribute_id: null }), { code: 'MAGENTO_RESPONSE_INVALID' });
  assert.throws(() => normalizeAttribute({ ...system, attribute_code: null }), { code: 'MAGENTO_RESPONSE_INVALID' });

  const baseline = await audit();
  const routes = fixture();
  routes['products/attributes'].items.push(system);
  routes['products/attributes'].total_count++;
  const report = await audit(routes);
  assert.equal(report.attributes.length, baseline.attributes.length + 1);
  assert.equal(report.attributes.find((a) => a.attribute_code === 'links_exist').frontend_input, null);
  assert.ok(report.unmappedMagentoAttributes.includes('links_exist'));
  assert.ok(!report.diagnostics.some((d) => d.code === 'ATTRIBUTE_FRONTEND_INPUT_MISSING'));
  assert.deepEqual(report.mapperAttributes, baseline.mapperAttributes);
  assert.deepEqual(report.optionComparisons, baseline.optionComparisons);
  assert.deepEqual(report, await audit(routes));
  assert.ok(!JSON.stringify(report).includes(env.MAGENTO_ACCESS_TOKEN));

  const mapped = fixture();
  mapped['products/attributes'].items[0].frontend_input = null;
  const mappedReport = await audit(mapped);
  assert.equal(mappedReport.mapperAttributes.find((a) => a.target === 'kolir').frontend_input, null);
  assert.deepEqual(mappedReport.diagnostics.filter((d) => d.code === 'ATTRIBUTE_FRONTEND_INPUT_MISSING'),
    [{ code: 'ATTRIBUTE_FRONTEND_INPUT_MISSING', severity: 'review', target: 'kolir', attribute_id: 32 }]);
  assert.ok(!baseline.diagnostics.some((d) => d.code === 'ATTRIBUTE_FRONTEND_INPUT_MISSING'));
});

test('compares exact set names without numeric/category assumptions or fuzzy guesses', async () => {
  const report = await audit();
  const sets = report.mapperAttributeSetComparison;
  assert.equal(sets.find((s) => s.amberGroup === 'KL').status, 'missing');
  assert.equal(sets.find((s) => s.amberGroup === 'CH').status, 'ambiguous');
  assert.deepEqual(sets.find((s) => s.attribute_set_code === 'Камінь').matches,
    [{ attribute_set_id: 144, attribute_set_name: 'Камінь' }]);
  assert.equal(sets.find((s) => s.amberGroup === 'BR').matches[0].attribute_set_id, 4);
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_SET_NOT_FOUND' && d.amberGroup === 'KL'));
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_SET_AMBIGUOUS' && d.amberGroup === 'CH'));
});

test('compares every target, expected memberships, missing attributes and CSV controls', async () => {
  const report = await audit();
  const targets = report.mapperAttributes;
  assert.deepEqual(targets.map((t) => t.target), [...new Set(Object.values(legacy.HEADERS).flat())].sort());
  const color = targets.find((t) => t.target === 'kolir');
  assert.equal(color.exists, true);
  assert.equal(color.frontend_input, 'select');
  assert.equal(color.hasOptions, true);
  assert.ok(color.attributeSetIds.includes(151));
  assert.ok(!color.attributeSetIds.includes(144));
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_NOT_IN_EXPECTED_SET' && d.target === 'kolir' && d.attribute_set_id === 144));
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_NOT_FOUND' && d.target === 'sku'));
  assert.equal(targets.find((t) => t.target === 'store_view_code').kind, 'csv_control');
  assert.ok(!report.diagnostics.some((d) => d.target === 'store_view_code'));
  assert.ok(report.diagnostics.every((d) => d.severity === 'review'));
});

test('dictionary label matches remain candidates with independent Amber IDs; duplicates/missing/extra are review diagnostics', async () => {
  const report = await audit();
  const options = report.optionComparisons.find((o) => o.target === 'kolir');
  const dark = options.values.find((v) => v.amberGroup === 'BR' && v.amberValueId === '2');
  assert.equal(dark.label, 'Темний');
  assert.equal(dark.status, 'candidate');
  assert.deepEqual(dark.sourceIds, ['BR.color']);
  assert.deepEqual(dark.candidateOptionIds, ['992']);
  assert.equal(options.values.find((v) => v.amberValueId === '1').status, 'ambiguous');
  assert.deepEqual(options.duplicateLabels, [{ label: 'Світлий', optionIds: ['881', '882'] }]);
  assert.ok(report.diagnostics.some((d) => d.code === 'OPTION_LABEL_AMBIGUOUS' && d.target === 'kolir'));
  assert.ok(report.diagnostics.some((d) => d.code === 'MAPPER_VALUE_NOT_IN_MAGENTO' && d.label === 'Пейзажний'));
  assert.ok(report.diagnostics.some((d) => d.code === 'MAGENTO_OPTION_UNMAPPED' && d.optionId === '777'));
  assert.ok(!report.diagnostics.some((d) => d.optionId === ''));
  assert.equal(options.emptyOptions.length, 1);
});

test('mapper derivation tracks authoritative headers/dictionaries, constants, bands and source questions', () => {
  const mapper = describeMapper();
  assert.deepEqual(legacy.HEADERS, data.HEADERS);
  assert.deepEqual(legacy.GROUPS, data.GROUPS);
  for (const [group, fields] of Object.entries(legacy.ATTRIBUTE)) {
    for (const [target, [key, dictionary]] of Object.entries(fields)) {
      const usage = mapper.targets.find((t) => t.target === target).usages.find((u) => u.amberGroup === group && u.row === 'base');
      const expected = dictionary || data.AR_SIZE;
      assert.deepEqual(Object.fromEntries(usage.values.filter((v) => v.kind === 'dictionary').map((v) => [v.amberValueId, v.label])), expected);
      assert.ok(usage.sourceIds.includes(`${group}.${key}`));
    }
  }
  const labels = (target) => mapper.targets.find((t) => t.target === target).usages.flatMap((u) => u.values.map((v) => v.label));
  assert.ok(labels('sklo').includes('Без скла'));
  assert.ok(labels('fraction').includes('1000+'));
  assert.ok(labels('dovzhyna_namysta').includes('Колар (30-35 см)'));
  assert.ok(labels('old_product').includes('No'));
  assert.ok(mapper.sources.some((s) => s.questionKey === 'pedant_size'));
  assert.ok(mapper.sources.some((s) => s.questionKey === 'exact_size'));
  assert.ok(mapper.targets.find((t) => t.target === 'name').usages.every((u) => u.dynamicOutput));
});

test('empty mapper output never binds to an empty Magento option', async () => {
  const routes = fixture();
  routes['products/attributes'].items.push(attr(55, 'dodatkovo_namysta', 'select'));
  routes['products/attributes'].total_count++;
  routes['products/attributes/dodatkovo_namysta/options'] = [{ value: '', label: '' }];
  const report = await audit(routes);
  const comparison = report.optionComparisons.find((c) => c.target === 'dodatkovo_namysta');
  const value = comparison.values.find((v) => v.amberValueId === '0');
  assert.equal(value.status, 'empty_output');
  assert.deepEqual(value.candidateOptionIds, []);
});

test('boolean and custom mapper option sources are inspected; text without options is not a label mismatch', async () => {
  const routes = fixture();
  routes['products/attributes'].items.push(attr(66, 'old_product', 'boolean'));
  routes['products/attributes'].total_count++;
  routes['products/attributes/old_product/options'] = [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }];
  const report = await audit(routes);
  const boolean = report.optionComparisons.find((c) => c.target === 'old_product');
  assert.ok(boolean.values.every((v) => v.status === 'candidate' && v.candidateOptionIds[0] === '0'));
  const name = report.mapperAttributes.find((a) => a.target === 'name');
  assert.equal(name.hasOptions, false);
  assert.equal(name.optionCount, 0);
  assert.ok(!report.optionComparisons.some((c) => c.target === 'name'));
});

test('normalization is deterministic across remote ordering and retains no raw metadata/credentials', async () => {
  const a = fixture();
  const b = structuredClone(a);
  for (const value of Object.values(b)) {
    if (Array.isArray(value)) value.reverse();
    else if (value.items) value.items.reverse();
  }
  a['store/websites'][0].Authorization = JSON.stringify(env);
  a['products/attributes'].items[0].extension_attributes = { Authorization: env.MAGENTO_ACCESS_TOKEN };
  const first = await audit(a);
  assert.deepEqual(first, await audit(b));
  const json = JSON.stringify(first);
  for (const secret of Object.values(env)) assert.ok(!json.includes(secret));
  assert.ok(!/Authorization|extension_attributes|ignored|oauth_signature/.test(json));
});

test('reflected secrets and Authorization in schema labels fail closed instead of becoming evidence', async () => {
  for (const label of [env.MAGENTO_CONSUMER_SECRET, encodeURIComponent(env.MAGENTO_ACCESS_TOKEN_SECRET),
    'Authorization: OAuth oauth_signature=secret']) {
    const routes = fixture();
    routes['products/attributes/kolir/options'][0].label = label;
    await assert.rejects(audit(routes), { code: 'MAGENTO_AUDIT_SENSITIVE_DATA' });
  }
});

test('malformed metadata, options and inconsistent assigned attributes fail closed', async () => {
  const mutations = [
    (r) => { r['store/websites'] = {}; },
    (r) => { r['store/storeViews'][0].website_id = '2'; },
    (r) => { r['store/storeViews'][0].is_active = 2; },
    (r) => { r['store/storeViews'][0].store_group_id = 999; },
    (r) => { r['products/attributes'].items[0].frontend_input = {}; },
    (r) => { r['products/attributes'].items[0].attribute_code = '../evil'; },
    (r) => { r['products/attributes'].items[0].is_unique = []; },
    (r) => { r['products/attributes'].items[1].attribute_id = 32; },
    (r) => { r['products/attribute-sets/sets/list'].items[0].attribute_set_name = null; },
    (r) => { r['products/attribute-sets/144/attributes'] = [attr(888, 'kolir', 'select')]; },
    (r) => { r['products/attribute-sets/144/attributes'] = [attr(3, 'unknown')]; },
    (r) => { r['products/attributes/kolir/options'] = [{ value: '1', label: {} }]; },
    (r) => { r['products/attributes/kolir/options'] = [{ value: null, label: 'x' }]; },
    (r) => { r['products/attributes/kolir/options'] = [{ value: '1', label: 'x' }, { value: 1, label: 'y' }]; },
    (r) => { r['products/attributes/kolir/options'] = [{ value: '1', label: 'x', is_default: 'maybe' }]; },
  ];
  for (const mutate of mutations) {
    const routes = fixture(); mutate(routes);
    await assert.rejects(audit(routes), { code: 'MAGENTO_RESPONSE_INVALID' });
  }
  assert.throws(() => normalizeOptions(Array(10001).fill({})), { code: 'MAGENTO_DISCOVERY_LIMIT' });
});

test('pagination reads complete bounded lists and rejects changed totals, duplicates and premature end', async () => {
  const routes = fixture();
  routes['products/attributes'] = (url) => {
    const page = Number(url.searchParams.get('searchCriteria[currentPage]'));
    const extra = Array.from({ length: 101 }, (_, i) => attr(i + 1000, `extra_${i}`));
    const all = [...fixture()['products/attributes'].items, ...extra];
    return { items: all.slice((page - 1) * 100, page * 100), total_count: all.length };
  };
  assert.equal((await audit(routes)).attributes.length, 105);
  for (const body of [{ items: [], total_count: 1 }, { items: [], total_count: '0' },
    { items: [attr(1, 'repeated')], total_count: 2 }, { items: [], total_count: 10001 }]) {
    const bad = fixture(); bad['products/attributes'] = body;
    await assert.rejects(audit(bad), (e) => ['MAGENTO_RESPONSE_INVALID', 'MAGENTO_DISCOVERY_LIMIT'].includes(e.code));
  }
  routes['products/attributes'] = (url) => ({ items: [attr(Number(url.searchParams.get('searchCriteria[currentPage]')), 'one')],
    total_count: Number(url.searchParams.get('searchCriteria[currentPage]')) + 1 });
  await assert.rejects(audit(routes), { code: 'MAGENTO_RESPONSE_INVALID' });
});

function logs() {
  const entries = [];
  return { entries, log: { info: (event, value) => entries.push({ event, ...value }), error: (event, value) => entries.push({ event, ...value }) } };
}
test('CLI is GET-only, uses selected scope, writes structured artifact and bounded summary without overwriting', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-schema-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'evidence.json');
  const captured = logs();
  const calls = [];
  const args = ['--output', output, '--store-code', 'custom'];
  const fetchImpl = mockFetch(fixture(), calls, 'custom');
  assert.equal(await runSchemaAudit({ env, args, fetchImpl, log: captured.log }), 0);
  const bytes = await fs.readFile(output, 'utf8');
  assert.equal(JSON.parse(bytes).storeCode, 'custom');
  assert.ok(calls.every((route) => /^(store\/|products\/attribute)/.test(route)));
  assert.ok(JSON.stringify(captured.entries).length < 2000);
  assert.equal(captured.entries[0].attributes, 4);
  assert.equal(await runSchemaAudit({ env, args, fetchImpl, log: captured.log }), 1);
  assert.equal(await fs.readFile(output, 'utf8'), bytes);
});

test('CLI help/config/arguments/errors are sanitized; failed discovery leaves no artifact', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-schema-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'failed.json');
  const captured = logs();
  assert.equal(await runSchemaAudit({ args: ['--help'], env: {}, log: captured.log,
    fetchImpl: () => assert.fail('Network on help') }), 0);
  assert.equal(await runSchemaAudit({ env: {}, log: captured.log, fetchImpl: () => assert.fail('Network without config') }), 1);
  assert.equal(await runSchemaAudit({ env, args: ['--output', output], log: captured.log,
    fetchImpl: async () => { throw new Error(JSON.stringify(env)); } }), 1);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(captured.entries).includes(secret));
  for (const args of [['--method', 'POST'], ['--sku', 'test'], ['--json'], ['--output'],
    ['--store-code', '../evil'], ['--output', output, '--output', output]]) {
    assert.throws(() => parseArguments(args), { code: 'MAGENTO_AUDIT_ARGUMENTS' });
  }
});

test('CLI locates malformed topology, set metadata, global attributes, membership and options without remote text', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-schema-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenarios = [
    { change: (r) => { r['store/storeViews'][0].name = { remoteMessage: env.MAGENTO_ACCESS_TOKEN }; },
      expected: { stage: 'store_topology_normalization', entityType: 'store_views', entityId: 4, index: 0 } },
    { change: (r) => { r['products/attribute-sets/sets/list'].items[0].attribute_set_name = null; },
      expected: { stage: 'attribute_set_metadata', entityType: 'attribute_set', entityId: 151, index: 0 } },
    { change: (r) => { r['products/attributes'].items[0].frontend_input = { message: env.MAGENTO_CONSUMER_SECRET }; },
      expected: { stage: 'product_attribute_normalization', entityType: 'attribute', entityId: 32,
        entityCode: 'kolir', index: 0, field: 'frontend_input', valueShape: 'object' } },
    { change: (r) => { r['products/attributes'].items[0].is_filterable =
      { remoteMessage: env.MAGENTO_ACCESS_TOKEN }; },
    expected: { stage: 'product_attribute_normalization', entityType: 'attribute', entityId: 32,
      entityCode: 'kolir', index: 0, field: 'is_filterable', valueShape: 'object' } },
    { change: (r) => { r['products/attributes'].items[0] = null; },
      expected: { stage: 'product_attribute_normalization', entityType: 'attribute', index: 0 } },
    { change: (r) => { r['products/attribute-sets/144/attributes'][0] =
      { ...r['products/attribute-sets/144/attributes'][0], is_unique: { Authorization: env.MAGENTO_ACCESS_TOKEN } }; },
      expected: { stage: 'assigned_attribute_membership', entityType: 'attribute', entityId: 13,
        attributeSetId: 144, entityCode: 'kamin_suvenirnyi', index: 0,
        field: 'is_unique', valueShape: 'object' } },
    { change: (r) => { r['products/attributes/kolir/options'][0].label = { remoteMessage: env.MAGENTO_ACCESS_TOKEN }; },
      expected: { stage: 'option_normalization', entityType: 'attribute', entityId: 32, entityCode: 'kolir' } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const routes = fixture(); scenario.change(routes);
    const captured = logs();
    const output = path.join(dir, `failure-${index}.json`);
    assert.equal(await runSchemaAudit({ env, args: ['--output', output], log: captured.log,
      fetchImpl: mockFetch(routes) }), 1);
    assert.deepEqual(captured.entries, [{ event: 'magento.schema_audit.failed',
      code: 'MAGENTO_RESPONSE_INVALID', message: 'Magento returned an unexpected JSON response.',
      status: undefined, ...scenario.expected }]);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    const logged = JSON.stringify(captured.entries);
    for (const secret of Object.values(env)) assert.ok(!logged.includes(secret));
    assert.ok(!/Authorization|oauth_signature|remoteMessage/.test(logged));
  }
});

test('unsafe identifiers fall back to bounded index or numeric ID; report assembly stays safe', async () => {
  const badCode = fixture();
  badCode['products/attributes'].items[0].attribute_code = 'OAuth oauth_signature=' + env.MAGENTO_ACCESS_TOKEN;
  const bad = await assert.rejects(audit(badCode), { code: 'MAGENTO_RESPONSE_INVALID' });
  assert.equal(bad, undefined);
  const captured = logs();
  assert.equal(await runSchemaAudit({ env, log: captured.log, fetchImpl: mockFetch(badCode) }), 1);
  assert.deepEqual(captured.entries[0].stage, 'product_attribute_normalization');
  assert.equal(captured.entries[0].entityId, 32);
  assert.equal(captured.entries[0].entityCode, undefined);
  assert.equal(captured.entries[0].index, 0);
  assert.equal(captured.entries[0].field, 'attribute_code');
  assert.equal(captured.entries[0].valueShape, 'string');

  const validLookingSecret = 'TokenLeak123';
  const secretCode = fixture();
  secretCode['products/attributes'].items[0].attribute_code = validLookingSecret;
  secretCode['products/attributes'].items[0].frontend_input = { remoteMessage: 'hidden' };
  const secretLog = logs();
  assert.equal(await runSchemaAudit({ env: { ...env, MAGENTO_ACCESS_TOKEN: validLookingSecret },
    log: secretLog.log, fetchImpl: mockFetch(secretCode) }), 1);
  assert.equal(secretLog.entries[0].entityId, 32);
  assert.equal(secretLog.entries[0].entityCode, undefined);
  assert.equal(secretLog.entries[0].field, 'frontend_input');
  assert.equal(secretLog.entries[0].valueShape, 'object');
  assert.ok(!JSON.stringify(secretLog.entries).includes(validLookingSecret));

  const reflected = fixture();
  reflected['products/attributes/kolir/options'][0].label = env.MAGENTO_ACCESS_TOKEN;
  const assembly = logs();
  assert.equal(await runSchemaAudit({ env, log: assembly.log, fetchImpl: mockFetch(reflected) }), 1);
  assert.equal(assembly.entries[0].stage, 'report_assembly');
  assert.equal(assembly.entries[0].entityType, 'report');
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(assembly.entries).includes(secret));

  const valid = await audit();
  assert.deepEqual(valid, await audit());
  assert.equal(Object.hasOwn(valid, 'auditContext'), false);
});

test('attribute field diagnostics distinguish legal nulls from malformed shapes without logging values', async () => {
  const legal = fixture();
  legal['products/attributes'].items[0].backend_type = null;
  legal['products/attributes'].items[0].default_frontend_label = null;
  legal['products/attributes'].items[0].is_unique = null;
  const omitted = fixture();
  delete omitted['products/attributes'].items[0].backend_type;
  delete omitted['products/attributes'].items[0].default_frontend_label;
  delete omitted['products/attributes'].items[0].is_unique;
  const baseline = await audit(omitted);
  const result = await audit(legal);
  assert.deepEqual(result, baseline);
  const failures = [
    ['backend_type', { remoteMessage: env.MAGENTO_CONSUMER_SECRET }, 'object'],
    ['is_unique', { remoteMessage: env.MAGENTO_ACCESS_TOKEN }, 'object'],
    ['frontend_input', 1, 'number'],
    ['frontend_input', undefined, 'missing'],
  ];
  for (const [field, value, shape] of failures) {
    const routes = fixture();
    if (value === undefined) delete routes['products/attributes'].items[0][field];
    else routes['products/attributes'].items[0][field] = value;
    const captured = logs();
    assert.equal(await runSchemaAudit({ env, log: captured.log, fetchImpl: mockFetch(routes) }), 1);
    const entry = captured.entries[0];
    assert.deepEqual({ code: entry.code, stage: entry.stage, entityCode: entry.entityCode,
      field: entry.field, valueShape: entry.valueShape },
    { code: 'MAGENTO_RESPONSE_INVALID', stage: 'product_attribute_normalization', entityCode: 'kolir',
      field, valueShape: shape });
    const logged = JSON.stringify(entry);
    for (const secret of Object.values(env)) assert.ok(!logged.includes(secret));
    assert.ok(!/remoteMessage|Authorization|oauth_signature/.test(logged));
  }
});
