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
