const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { nameRender } = require('../src/services/magento/historical-manual-render');
function sample() { return { compiled: { definition: materializeMagentoV1(new Map(), { publicSku: true }) }, product: { public_sku: 'SV2314003' } }; }
test('manual display descriptor derives both languages and the exact public SKU from immutable branches', () => {
  const amber = sample(), before = JSON.stringify(amber), render = nameRender(amber);
  assert.deepEqual(render, { format: 'historical-manual-render-v1', ua: { prefix: '', suffix: ' з бурштину. Арт: SV2314003' }, en: { prefix: 'Amber ', suffix: '. Art: SV2314003' } });
  assert.equal(JSON.stringify(amber), before);
  amber.compiled.definition.bindings.find(b => b.id === 'SV.nameUa').value.then.template = 'Новий {subject}: {sku}';
  assert.equal(nameRender(amber).ua.suffix, ': SV2314003'); assert.equal(nameRender(amber).ua.prefix, 'Новий ');
});
test('local rendering rejects transforms, cross-language inputs, changed pair guards, identity and name cells', () => {
  const changes = [
    d => { d.bindings.find(b => b.id === 'SV.manualUa').value.trim = false; },
    d => { d.bindings.find(b => b.id === 'SV.nameUa').value.then.slots.subject.id = 'SV.manualEn'; },
    d => { d.bindings.find(b => b.id === 'SV.nameUa').value.then.template = '{subject}{subject}{sku}'; },
    d => { d.bindings.find(b => b.id === 'SV.nameEn').value.then.template = '{subject}{sku}{unknown}'; },
    d => { d.bindings.find(b => b.id === 'SV.manualPair').value.items.pop(); },
    d => { d.bindings.find(b => b.id === 'sku').value.input.id = 'full_sku'; },
    d => { d.sources.magento_name_subject_ua.field = 'details'; },
    d => { d.groups.find(g => g.route === 'SV').rows[0].cells.name = { op: 'literal', value: 'Custom name' }; },
    d => { d.nameReadiness = 'effective-product-names-v1'; },
  ];
  for (const change of changes) { const amber = sample(); change(amber.compiled.definition); assert.equal(nameRender(amber), null); }
});

const supplied = require('./fixtures/historical-production-sv-names.json');
function inlineSample() { return { compiled: { definition: structuredClone(supplied.definition) }, product: { public_sku: 'SV2314004' } }; }
test('the supplied publication renders its actual inline SV rows without changing its distinct automatic fallback', () => {
  const amber = inlineSample(), before = JSON.stringify(amber);
  assert.equal(supplied.source.definitionHash, '201a0273ef764be3abf97396b4037405f3da22bc8f93f9d2f0057aed6468d498');
  const row = amber.compiled.definition.groups[0].rows[0].cells.name;
  const named = amber.compiled.definition.bindings.find(b => b.id === 'SV.nameUa').value;
  assert.notDeepEqual(row.else, named.else);
  assert.deepEqual(nameRender(amber), { format: 'historical-manual-render-v1', ua: { prefix: '', suffix: ' з бурштину. Арт: SV2314004' }, en: { prefix: 'Amber ', suffix: '. Art: SV2314004' } });
  assert.equal(JSON.stringify(amber), before);
  named.then.template = 'Unused {subject}: {sku}';
  assert.equal(nameRender(amber).ua.prefix, '');
  row.then.template = 'Actual {subject}: {sku}';
  assert.deepEqual(nameRender(amber).ua, { prefix: 'Actual ', suffix: ': SV2314004' });
});
test('inline rows retain exact manual-pair, language, public-SKU and interpolation guards', () => {
  const changes = [
    d => { d.groups[0].rows[0].cells.name.if.id = 'SV.manualUa'; },
    d => { d.groups[0].rows[0].cells.name.then.slots.subject.id = 'SV.manualEn'; },
    d => { d.groups[0].rows[1].cells.name.then.slots.subject.id = 'SV.manualUa'; },
    d => { d.groups[0].rows[0].cells.name.then.slots.sku = { op: 'source', id: 'full_sku' }; },
    d => { d.groups[0].rows[0].cells.name.then.template += '{subject}'; },
    d => { d.groups[0].rows[0].cells.name = { op: 'text', input: d.groups[0].rows[0].cells.name, trim: true, format: 'scalar-v1', onAbsent: 'empty' }; },
    d => { d.bindings.find(b => b.id === 'SV.manualPair').value.items.pop(); },
    d => { d.bindings.find(b => b.id === 'sku').value.input.id = 'full_sku'; },
  ];
  for (const change of changes) { const amber = inlineSample(); change(amber.compiled.definition); assert.equal(nameRender(amber), null); }
});
test('mixed inline and referenced actual rows resolve only the selected row expression', () => {
  const amber = inlineSample(), d = amber.compiled.definition, en = d.groups[0].rows[1];
  const actual = en.cells.name;
  d.bindings.push({ id: 'SV.reviewedEnglishName', value: actual });
  en.cells.name = { op: 'ref', id: 'SV.reviewedEnglishName' };
  assert.deepEqual(nameRender(amber).en, { prefix: 'Amber ', suffix: '. Art: SV2314004' });
  en.cells.name.id = 'SV.nameUa';
  assert.equal(nameRender(amber), null);
});
