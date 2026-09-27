const assert = require('node:assert/strict');
const test = require('node:test');
const { compileDefinition, validateDefinition, LIMITS } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { evaluateProduct, evaluateBatch, legacyPreview } = require('../src/services/export-templates/evaluate');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const legacy = require('../src/services/magento-products-v1');
const definition = () => materializeMagentoV1(catalog());
const baseline = compileDefinition(definition());
const binding = (d, id) => d.bindings.find((b) => b.id === id);
const group = (d, route) => d.groups.find((g) => g.route === route);
const literal = (value) => ({ op: 'literal', value });
const bytes = (v) => Buffer.from(v, 'utf8');

test('definition-only literal change changes exactly one base cell', () => {
  const d = definition(); group(d, 'BR').rows[0].cells.old_product = literal('Configured');
  const input = product('BR');
  const expected = evaluateProduct(baseline, input); expected.base.old_product = 'Configured';
  assert.deepEqual(evaluateProduct(compileDefinition(d), input), expected);
  const csv = evaluateBatch(baseline, [input]).artifacts[0].csvContent;
  assert.deepEqual(bytes(evaluateBatch(compileDefinition(d), [input]).artifacts[0].csvContent), bytes(csv.replace(',No,Yes,', ',Configured,Yes,')));
});
test('definition-only semantic table entry changes output, not category/name', () => {
  const d = definition(); d.tables.raw['1'] = 'Configured raw';
  const input = product('BR'); const expected = evaluateProduct(baseline, input);
  expected.base.typy_obrobky_burshtynu = 'Configured raw';
  assert.deepEqual(evaluateProduct(compileDefinition(d), input), expected);
});
test('definition-only naming and category interpolation change exact output', () => {
  const d = definition();
  binding(d, 'BR.nameUa').value.then.template = 'Тест {material}: {sku}';
  binding(d, 'BR.categories').value.items[1].template = 'Configured/{material}';
  const input = product('BR'); const expected = evaluateProduct(baseline, input);
  expected.base.name = 'Тест натурального: BR-SYNTH-001';
  expected.base.categories = expected.base.categories.replace('Default/Браслети/Браслети з цільного каменю бурштину', 'Configured/цільного каменю');
  assert.deepEqual(evaluateProduct(compileDefinition(d), input), expected);
});
test('definition-only condition and fallback changes are observable with unchanged inputs', () => {
  const d = definition();
  binding(d, 'KL.rozmir_iuvelirnoho_vyrobu').value.input.items.reverse();
  const input = product('KL', { exact_size: 'legacy size' });
  const expected = evaluateProduct(baseline, input); expected.base.rozmir_iuvelirnoho_vyrobu = 'legacy size';
  assert.deepEqual(evaluateProduct(compileDefinition(d), input), expected);
  binding(d, 'KL.legacyInclusionPresence').value = { op: 'eq', left: { op: 'semanticKey', input: { op: 'source', id: 'KL.addit' } }, right: literal('1') };
  // Modified candidate only; the baseline legacy quirk remains untouched.
  const zero = product('KL', { addit: 0 }); const changed = evaluateProduct(compileDefinition(d), zero);
  assert.ok(!changed.base.categories.includes('З інклюзом'));
  assert.deepEqual(changed.errors, evaluateProduct(baseline, zero).errors);
});
test('definition-only column reorder gives exact byte reorder with sparse EN preserved', () => {
  const d = definition();
  const columns = group(d, 'BR').columns;
  [columns[0], columns[1]] = [columns[1], columns[0]];
  const input = product('BR');
  const old = evaluateBatch(baseline, [input]).artifacts[0].csvContent;
  const expected = old.replace('sku,store_view_code,', 'store_view_code,sku,')
    .replace('\nBR-SYNTH-001,,', '\n,BR-SYNTH-001,').replace('\nBR-SYNTH-001,en,', '\nen,BR-SYNTH-001,');
  assert.deepEqual(bytes(evaluateBatch(compileDefinition(d), [input]).artifacts[0].csvContent), bytes(expected));
});

test('canonical identity: object key order irrelevant, arrays/exact strings/settings significant', () => {
  function reorder(v) {
    if (Array.isArray(v)) return v.map(reorder);
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
  }
  const d = definition(); const reordered = compileDefinition(reorder(d));
  assert.equal(reordered.hash, baseline.hash);
  const products = ['BR', 'NM', 'KL', 'CH', 'AR', 'SV'].map((g) => product(g));
  assert.deepEqual(evaluateBatch(reordered, products), evaluateBatch(baseline, products));
  for (const mutate of [
    (v) => { v.tables.raw['1'] += ' '; },
    (v) => { group(v, 'BR').columns.reverse(); },
    (v) => { v.questionContracts['NM.extra'].required = true; },
    (v) => { binding(v, 'KL.rozmir_iuvelirnoho_vyrobu').value.input.items.reverse(); },
  ]) {
    const next = definition(); mutate(next); assert.notEqual(compileDefinition(next).hash, baseline.hash);
  }
});
test('compile detaches all rules/tables; no stale compiled cache; results and products isolated', () => {
  const rules = catalog(); const d = materializeMagentoV1(rules); const c = compileDefinition(d);
  const input = product('BR'); const inputBefore = structuredClone(input);
  const expected = evaluateBatch(c, [input]);
  rules.get('BR').get('raw_type').required = 1;
  rules.get('BR').get('raw_type').visible_if_json = { raw_type: 2 };
  d.tables.raw['1'] = 'MUTATED';
  d.questionContracts['BR.raw_type'].required = true;
  assert.deepEqual(evaluateBatch(c, [input]), expected);
  assert.notEqual(compileDefinition(d).hash, c.hash);
  assert.equal(evaluateProduct(compileDefinition(d), input).base.typy_obrobky_burshtynu, 'MUTATED');
  assert.ok(Object.isFrozen(c.definition.tables.raw));
  expected.provisionalArtifacts[0].csvContent = 'damaged'; expected.errors.push({});
  const row = evaluateProduct(c, input); row.base.name = 'damaged'; row.errors.push({});
  assert.deepEqual(evaluateBatch(c, [input]), evaluateBatch(baseline, [input]));
  assert.deepEqual(input, inputBefore);
  const freshContract = compileDefinition(materializeMagentoV1(rules));
  assert.deepEqual(evaluateProduct(freshContract, input), legacy.mapProduct(input, rules));
  assert.notEqual(freshContract.hash, c.hash);
});
test('JSON roundtrip and repeated evaluation are identical across groups/rows/products', () => {
  const d = definition(); const roundtrip = compileDefinition(JSON.parse(JSON.stringify(d)));
  assert.equal(roundtrip.hash, baseline.hash);
  const inputs = [product('AR', { size: 99 }), product('SV'), product('BR'), product('CH'), product('BR', { raw_type: 2 })];
  const before = structuredClone(inputs);
  const expected = legacy.buildMagentoPayload(inputs, catalog());
  for (let i = 0; i < 3; i++) assert.deepEqual(legacyPreview(evaluateBatch(roundtrip, inputs)), expected);
  assert.deepEqual(inputs, before);
});
test('lazy hidden branches ignore invalid unused answers but static validation visits both branches', () => {
  const rules = catalog(); rules.get('SV').get('2').visible_if_json = { souvenir: 1 };
  const c = compileDefinition(materializeMagentoV1(rules));
  const input = product('SV', { '2': { bad: true }, unused: { anything: true }, is_calibrated: { hidden: true } });
  assert.deepEqual(evaluateProduct(c, input).errors, []);
  const d = definition();
  group(d, 'BR').rows[0].cells.description = { op: 'when', if: literal(false), then: { op: 'executeJavaScript', code: 'x' }, else: literal('') };
  assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' });
  group(d, 'BR').rows[0].cells.description.then = { op: 'error', field: 'description', message: literal('unused') };
  assert.deepEqual(evaluateProduct(compileDefinition(d), product('BR')).errors, []);
  group(d, 'BR').rows[0].cells.description.if.value = true;
  assert.deepEqual(evaluateProduct(compileDefinition(d), product('BR')).errors, [{ field: 'description', message: 'unused' }]);
});

test('schema-scoped explicit alias accepts only supplied provenance; dual conflicts fail', () => {
  const d = definition();
  d.sources['SV.2'].aliases = [{ key: 'theme', schemaId: '77', evidence: 'Synthetic reviewed key rename' }];
  const c = compileDefinition(d);
  const input = product('SV', { theme: 2 }, { sku_schema_version_id: 77 });
  assert.equal(evaluateProduct(c, input).base.tematyka_vyrobu, 'Птахи');
  assert.equal(evaluateProduct(c, { ...input, sku_schema_version_id: 78 }).base.tematyka_vyrobu, '');
  input.details.answers['2'] = 2;
  assert.equal(evaluateProduct(c, input).base.tematyka_vyrobu, 'Птахи');
  input.details.answers['2'] = 1;
  assert.throws(() => evaluateBatch(c, [input]), { code: 'SOURCE_REFERENCE_AMBIGUOUS' });
  const unresolved = definition(); unresolved.sources['SV.2'].aliases = [{ key: 'theme', schemaId: '77', evidence: '' }];
  assert.throws(() => compileDefinition(unresolved), { code: 'TEMPLATE_INVALID' });
});
test('own-property lookups never select inherited answer values, product fields or table entries', () => {
  const input = product('SV');
  input.details.answers = Object.assign(Object.create({ '2': 2 }), input.details.answers);
  assert.equal(evaluateProduct(baseline, input).base.tematyka_vyrobu, '');
  const inherited = Object.assign(Object.create({ total_price_uah: '100' }), input); delete inherited.total_price_uah;
  assert.deepEqual(evaluateProduct(baseline, inherited).errors, [{ field: 'price', message: 'Немає додатної збереженої фінальної ціни UAH.' }]);
  for (const value of ['constructor', '__proto__', 'toString']) {
    const result = evaluateProduct(baseline, product('NM', { extra: value }));
    assert.deepEqual(result.errors, [{ field: 'dodatkovo_namysta', message: `Немає Magento-мапінгу для extra=${value}.` }]);
  }
});
test('invalid represented product cannot yield a successful complete artifact set', () => {
  const result = evaluateBatch(baseline, [product('BR'), product('AR', { size: 99 }), product('SV')]);
  assert.equal(result.status, 'not-ready'); assert.equal(result.representedCount, 3);
  assert.equal(result.readyCount, 2); assert.equal(result.failedCount, 1);
  assert.deepEqual(result.represented.map((p) => [p.productId, p.group, p.status, p.artifactRows]),
    [[1, 'BR', 'ready', 2], [1, 'AR', 'failed', 0], [1, 'SV', 'ready', 2]]);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.provisionalArtifacts.map((a) => [a.groupCode, a.rowCount]), [['BR', 2], ['SV', 2]]);
  assert.deepEqual(result.errors[0].fields, [
    { field: 'rozmir_kartyny', message: 'Невідоме value_id 99 для size.' },
    { field: 'rozmir_kartyny', message: 'Немає Magento-мапінгу для size=99.' },
  ]);
});

const invalidDefinitions = [
  ['formatVersion', (d) => { d.formatVersion = 2; }],
  ['evaluatorVersion', (d) => { d.evaluatorVersion = 'future'; }],
  ['outputContract', (d) => { d.outputContract = 'custom'; }],
  ['unknown root property', (d) => { d.ignoreErrors = true; }],
  ['unknown operation', (d) => { d.bindings[0].value = { op: 'eval', value: 'x' }; }],
  ['format enum', (d) => { d.bindings[0].value.format = 'guess'; }],
  ['source field allowlist', (d) => { d.sources.full_sku.field = 'autoPriceUah'; }],
  ['source type', (d) => { d.sources.full_sku.type = 'executable'; }],
  ['source category scalar type', (d) => { d.sources['BR.raw_type'].category = ['BR']; }],
  ['null source descriptor', (d) => { d.sources.full_sku = null; }],
  ['source descriptor feature', (d) => { d.sources['SV.2'].path = ['details', 'answers']; }],
  ['source provenance', (d) => { d.sources['SV.2'].provenance = 'guess-from-label'; }],
  ['source alias unsupported lineage', (d) => { d.sources['SV.2'].aliases = [{ key: 'theme', evidence: 'x', schemaId: '77', guess: true }]; }],
  ['source alias duplicate', (d) => { d.sources['SV.2'].aliases = [{ key: '2', evidence: 'x', schemaId: '77' }]; }],
  ['literal answer key traversal', (d) => { d.sources['SV.2'].key = 'details.answers.2'; }],
  ['unknown source', (d) => { d.bindings[0].value.input.id = 'nonexistent'; }],
  ['duplicate binding', (d) => { d.bindings.push(d.bindings[0]); }],
  ['binding group scalar type', (d) => { d.bindings[1].group = ['BR']; }],
  ['forward reference', (d) => { d.bindings[0].value = { op: 'ref', id: 'BR.nameUa' }; }],
  ['cycle', (d) => { d.bindings[0].value = { op: 'ref', id: 'sku' }; }],
  ['unresolved reference', (d) => { d.bindings[0].value = { op: 'ref', id: 'unknown' }; }],
  ['cross-group reference', (d) => { group(d, 'BR').rows[0].cells.name = { op: 'ref', id: 'AR.nameUa' }; }],
  ['unknown table', (d) => { binding(d, 'BR.category.material').value.table = 'unknown'; }],
  ['table value type', (d) => { d.tables.raw['1'] = {}; }],
  ['branch type mismatch', (d) => { binding(d, 'BR.nameUa').value.else = literal(false); }],
  ['predicate type', (d) => { binding(d, 'BR.nameUa').value.if = literal('yes'); }],
  ['semantic literal boolean', (d) => { binding(d, 'BR.nameValid').value.input.input = literal(false); }],
  ['equality type mismatch', (d) => { binding(d, 'SV.automaticName').value.right = literal(true); }],
  ['unknown question', (d) => { binding(d, 'BR.typy_obrobky_burshtynu').value.question = 'unknown'; }],
  ['suppressed required-answer diagnostic', (d) => { binding(d, 'BR.typy_obrobky_burshtynu').value.missingAnswer = literal(''); }],
  ['suppressed price diagnostic', (d) => { binding(d, 'BR.price').value.error = literal(''); }],
  ['suppressed constraint diagnostic', (d) => { binding(d, 'BR.nameCheck').value.error = literal(''); }],
  ['captured required flag', (d) => { d.questionContracts['BR.raw_type'].required = '1'; }],
  ['captured rule scalar root', (d) => { d.questionContracts['BR.raw_type'].rule = 42; }],
  ['captured rule invalid branch', (d) => { d.questionContracts['BR.raw_type'].rule = { $and: ['bad'] }; }],
  ['captured rule unresolved source', (d) => { d.questionContracts['BR.raw_type'].rule = { 'BR.unknown': 1 }; }],
  ['captured rule object expected', (d) => { d.questionContracts['BR.raw_type'].rule = { 'BR.raw_type': {} }; }],
  ['captured duplicate options', (d) => { d.questionContracts['AR.size'].allowed.push('1'); }],
  ['duplicate route', (d) => { d.groups[1].route = 'BR'; }],
  ['missing group', (d) => { d.groups.pop(); }],
  ['unknown route', (d) => { d.groups[0].route = 'XX'; }],
  ['route scalar type', (d) => { d.groups[0].route = ['BR']; }],
  ['duplicate column', (d) => { d.groups[0].columns[0] = 'name'; }],
  ['missing column', (d) => { d.groups[0].columns.shift(); }],
  ['unknown column', (d) => { d.groups[0].columns[0] = 'url_key'; }],
  ['missing EN row', (d) => { d.groups[0].rows.pop(); }],
  ['missing identity cell', (d) => { delete d.groups[0].rows[1].cells.sku; }],
  ['implicit nonblank default', (d) => { d.groups[0].rows[1].default = 'inherit'; }],
  ['wrong cell type', (d) => { d.groups[0].rows[0].cells.sku = literal(123); }],
  ['interpolation unresolved slot', (d) => { binding(d, 'BR.nameUa').value.then.template += '{unknown}'; }],
  ['interpolation arbitrary syntax', (d) => { binding(d, 'BR.nameUa').value.then.template += '{sku.slice(0)}'; }],
  ['NM-only nonnumeric passthrough', (d) => { binding(d, 'SV.fraction').value.then.onInvalid = 'input'; }],
  ['numeric interval shape', (d) => { binding(d, 'NM.dovzhyna_namysta').value.bands[0].max = 1; }],
];
for (const [name, mutate] of invalidDefinitions) test(`fail-closed definition: ${name}`, () => {
  const d = definition(); mutate(d);
  for (let i = 0; i < 2; i++) assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' });
});

test('bounded definition traversal rejects cycles/accessors/functions/prototypes before execution', () => {
  const cyclic = definition(); cyclic.extra = cyclic;
  assert.throws(() => compileDefinition(cyclic), { code: 'TEMPLATE_INVALID' });
  const accessor = definition(); let invoked = false;
  Object.defineProperty(accessor, 'trap', { enumerable: true, get() { invoked = true; throw Error('executed'); } });
  assert.throws(() => compileDefinition(accessor), { code: 'TEMPLATE_INVALID' }); assert.equal(invoked, false);
  for (const value of [() => {}, new Date(), NaN, Infinity, undefined, Symbol('x'), Object.create({ inherited: 1 })]) {
    const d = definition(); d.extra = value;
    assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' });
  }
  assert.throws(() => evaluateProduct({ definition: definition() }, product('BR')), { code: 'TEMPLATE_INVALID' });
});
test('strict materialization rejects malformed options/required flags and detaches rule trees', () => {
  for (const mutate of [
    (q) => { q.required = 2; }, (q) => { q.options = {}; },
    (q) => { q.options.push({ value_id: '1' }); }, (q) => { q.options = [{ value_id: {} }]; },
    (q) => { q.visible_if_json = { raw_type: {} }; },
  ]) {
    const rules = catalog(); mutate(rules.get('BR').get('raw_type'));
    assert.throws(() => materializeMagentoV1(rules), { code: 'TEMPLATE_INVALID' });
  }
  const rules = catalog(); const rule = { $and: [{ raw_type: '01' }, { color: [1, 2] }] };
  rules.get('BR').get('processing').visible_if_json = rule;
  const d = materializeMagentoV1(rules); const c = compileDefinition(d);
  rule.$and[0].raw_type = 2; rule.$and[1].color.push(3);
  assert.deepEqual(evaluateProduct(c, product('BR')), evaluateProduct(baseline, product('BR')));
  const ignored = catalog(); ignored.get('BR').get('raw_type').label = { unused: 'x'.repeat(5000) };
  assert.equal(compileDefinition(materializeMagentoV1(ignored)).hash, baseline.hash);
  let invoked = false;
  Object.defineProperty(ignored.get('BR').get('raw_type'), 'required', { get() { invoked = true; return 1; } });
  assert.throws(() => materializeMagentoV1(ignored), { code: 'TEMPLATE_INVALID' });
  assert.equal(invoked, false);
});

test('captured rule evaluation keeps declared short-circuit order through canonicalization', () => {
  const rules = catalog();
  rules.get('SV').get('2').visible_if_json = { souvenir: 1, bird: 3 };
  const input = product('SV', { bird: { invalid: true } });
  // Both fields hidden: the later predicate must not read bird after souvenir fails.
  rules.get('SV').get('bird').visible_if_json = { souvenir: 1 };
  const c = compileDefinition(materializeMagentoV1(rules));
  assert.deepEqual(evaluateProduct(c, input), legacy.mapProduct(input, rules));
  const reversed = catalog();
  reversed.get('SV').get('2').visible_if_json = { bird: 3, souvenir: 1 };
  reversed.get('SV').get('bird').visible_if_json = { souvenir: 1 };
  const other = compileDefinition(materializeMagentoV1(reversed));
  assert.notEqual(c.hash, other.hash);
  assert.throws(() => evaluateProduct(other, input), { code: 'INPUT_INVALID' });
});
test('source access never invokes caller getters; missing/null/blank/zero remain distinct', () => {
  let invoked = false;
  const input = product('BR');
  Object.defineProperty(input, 'total_price_uah', { get() { invoked = true; return '100'; } });
  assert.throws(() => evaluateProduct(baseline, input), { code: 'INPUT_INVALID' });
  assert.equal(invoked, false);
  const d = definition();
  group(d, 'KL').rows[0].cells.description = { op: 'when',
    if: { op: 'eq', left: { op: 'source', id: 'KL.exact_size' }, right: literal(null) },
    then: literal('null'), else: literal('other') };
  const c = compileDefinition(d);
  assert.equal(evaluateProduct(c, product('KL')).base.description, 'other');
  assert.equal(evaluateProduct(c, product('KL', { exact_size: null })).base.description, 'null');
  for (const value of ['', '  ', 0, '0']) assert.equal(evaluateProduct(c, product('KL', { exact_size: value })).base.description, 'other');
});
test('generic catalogRule predicate and empty text fallback have closed lazy semantics', () => {
  const d = definition();
  d.questionContracts['BR.raw_type'].rule = { 'BR.raw_type': '01' };
  group(d, 'BR').rows[0].cells.description = { op: 'when',
    if: { op: 'catalogRule', question: 'BR.raw_type' },
    then: { op: 'firstPresent', items: [literal(''), literal(' ')], policy: 'answer-v1' }, else: literal('hidden') };
  const c = compileDefinition(d);
  assert.equal(evaluateProduct(c, product('BR')).base.description, '');
  assert.equal(evaluateProduct(c, product('BR', { raw_type: 2 })).base.description, 'hidden');
});
test('numericBand onInvalid=error never treats malformed input as an outside-band default', () => {
  const d = definition();
  binding(d, 'SV.fraction').value.then.input = literal('NaN');
  const c = compileDefinition(d);
  const input = product('SV', { souvenir: 5 }, { magento_name_subject_ua: 'Камінь', magento_name_subject_en: 'stone' });
  assert.throws(() => evaluateBatch(c, [input]), { code: 'INPUT_INVALID' });
});
test('interpolation and diagnostics budgets reject before returning partial results', () => {
  const d = definition();
  group(d, 'BR').rows[0].cells.description = { op: 'interpolate', template: '{v}'.repeat(1000),
    slots: { v: literal('x'.repeat(4096)) } };
  assert.throws(() => evaluateBatch(compileDefinition(d), [product('SV'), product('BR')]), { code: 'EVALUATION_LIMIT' });
  assert.throws(() => evaluateBatch(baseline, [product('AR', { size: 99 })], { outputBytes: 100 }), { code: 'EVALUATION_LIMIT' });
});
test('default 20000-work limit counts repeated references and catalog-rule predicate work', (t) => {
  const d = definition();
  d.questionContracts['BR.raw_type'].rule = { $and: Array.from({ length: 16 }, () => ({
    $and: [{ 'BR.raw_type': '01' }, { 'BR.color': '1' }],
  })) };
  const predicate = { op: 'catalogRule', question: 'BR.raw_type' };
  group(d, 'BR').evaluate = Array.from({ length: 195 }, () => predicate);
  const below = evaluateBatch(compileDefinition(d), [product('BR')]);
  assert.ok(below.metrics.maxProductWork > 19000 && below.metrics.maxProductWork <= 20000);
  group(d, 'BR').evaluate = Array.from({ length: 512 }, () => predicate);
  assert.throws(() => evaluateBatch(compileDefinition(d), [product('SV'), product('BR')]), { code: 'EVALUATION_LIMIT' });
  t.diagnostic(`near-work-limit=${below.metrics.maxProductWork}; 512 repeated predicates exceed 20000`);
});

for (const [name, mutate] of [
  ['source count', (d) => { for (let i = 0; i < 257; i++) d.sources[`s${i}`] = { kind: 'product', field: 'id', type: 'scalar' }; }],
  ['binding count', (d) => { for (let i = 0; i < 513; i++) d.bindings.push({ id: `b${i}`, group: '*', value: literal('') }); }],
  ['single table entries', (d) => { d.tables.large = Object.fromEntries(Array.from({ length: 513 }, (_, i) => [i, 'x'])); }],
  ['total table entries', (d) => { for (let j = 0; j < 9; j++) d.tables[`t${j}`] = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [i, 'x'])); }],
  ['literal characters', (d) => { d.tables.raw['1'] = 'x'.repeat(4097); }],
  ['list children', (d) => { binding(d, 'BR.categories').value.items = Array.from({ length: 17 }, () => literal('')); }],
  ['node depth', (d) => { let n = literal(''); for (let i = 0; i < 8; i++) n = { op: 'text', input: n, format: 'scalar-v1', trim: false, onAbsent: 'empty' }; d.bindings[0].value = n; }],
  ['structural depth', (d) => { let n = {}; for (let i = 0; i < 1000; i++) n = { nested: n }; d.extra = n; }],
  ['definition UTF-8 bytes', (d) => { for (let i = 0; i < 25; i++) d.tables[`large${i}`] = { 1: 'я'.repeat(4096) }; }],
]) test(`deterministic definition limit: ${name}`, () => {
  const d = definition(); mutate(d); assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' });
});

test('measured work and exact final CSV UTF-8 budget: boundary succeeds; one less fails atomically', (t) => {
  const input = product('SV', { size: '=я,"x"\r\n' }, { magento_name_subject_ua: '@Сова', magento_name_subject_en: 'owl' });
  const measured = evaluateBatch(baseline, [input]);
  const exactBytes = Buffer.byteLength(measured.artifacts[0].csvContent, 'utf8');
  assert.equal(measured.metrics.outputBytes, exactBytes);
  assert.deepEqual(evaluateBatch(baseline, [input], { outputBytes: exactBytes }), measured);
  assert.throws(() => evaluateBatch(baseline, [input], { outputBytes: exactBytes - 1 }), { code: 'EVALUATION_LIMIT' });
  const work = measured.metrics.maxProductWork;
  assert.deepEqual(evaluateBatch(baseline, [input], { work }), measured);
  assert.throws(() => evaluateBatch(baseline, [input], { work: work - 1 }), { code: 'EVALUATION_LIMIT' });
  assert.throws(() => evaluateBatch(baseline, [input], { work: 20001 }), { code: 'EVALUATION_LIMIT' });
  t.diagnostic(JSON.stringify({ ...validateDefinition(definition()), work, exactBytes }));
});
test('16 KiB cells and 64 MiB escaped CSV limits: deterministic large synthetic range', (t) => {
  const input = product('SV', { size: 'я'.repeat(8192) }); // Exactly 16 KiB UTF-8, 8192 characters.
  const single = evaluateBatch(baseline, [input]);
  assert.equal(single.readyCount, 1);
  assert.throws(() => evaluateBatch(baseline, [product('SV', { size: 'я'.repeat(8192) + 'x' })]), { code: 'EVALUATION_LIMIT' });
  const csv = single.artifacts[0].csvContent;
  const headerBytes = Buffer.byteLength(csv.slice(0, csv.indexOf('\n')), 'utf8');
  const productBytes = single.metrics.outputBytes - headerBytes;
  const count = Math.floor((LIMITS.outputBytes - headerBytes) / productBytes);
  const inputs = Array(count).fill(input);
  const result = evaluateBatch(baseline, inputs);
  assert.equal(result.metrics.outputBytes, headerBytes + count * productBytes);
  assert.equal(Buffer.byteLength(result.artifacts[0].csvContent), result.metrics.outputBytes);
  assert.equal(result.readyCount, count);
  assert.throws(() => evaluateBatch(baseline, [...inputs, input]), { code: 'EVALUATION_LIMIT' });
  t.diagnostic(JSON.stringify({ count, outputBytes: result.metrics.outputBytes, rejectedCount: count + 1 }));
});
