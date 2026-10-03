const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { mapProduct } = require('../src/services/magento-products-v1');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { normalizeProductInputAnswers } = require('../src/services/product/product-answers');
const { targetProduct } = require('../src/services/sv-readiness-repair');

for (const size of [undefined, null, '', ' \t ', ' 3/2 см ']) test(`SV keychain optional size ${JSON.stringify(size)} has mapper/template parity without fabrication`, () => {
  const p = product('SV', { souvenir: 6, size });
  const before = structuredClone(p);
  const compiled = compileDefinition(materializeMagentoV1(catalog()));
  const mapped = mapProduct(p, catalog());
  const evaluated = evaluateProduct(compiled, p);
  assert.deepEqual(mapped.errors, []);
  assert.deepEqual(evaluated, mapped);
  assert.equal(mapped.base.rozmir_suveniriv, size?.trim() || '');
  const sized = mapProduct(product('SV'), catalog());
  for (const key of Object.keys(mapped.base).filter(key => key !== 'rozmir_suveniriv')) assert.deepEqual(mapped.base[key], sized.base[key], key);
  assert.deepEqual(p, before);
});

test('published historical size AST stays strict; corrected definition has a different hash without an engine change', () => {
  const next = materializeMagentoV1(catalog(), { publicSku: true });
  const old = structuredClone(next);
  const binding = old.bindings.find(b => b.id === 'SV.rozmir_suveniriv');
  binding.value = binding.value.else;
  const a = compileDefinition(old), b = compileDefinition(next);
  assert.equal(a.definition.evaluatorVersion, b.definition.evaluatorVersion);
  assert.notEqual(a.hash, b.hash);
  const p = product('SV', { size: undefined }, { public_sku: 'SV116008' });
  assert.deepEqual(evaluateProduct(a, p).errors.map(e => e.field), ['rozmir_suveniriv']);
  assert.deepEqual(evaluateProduct(b, p).errors, []);
  assert.equal(evaluateProduct(b, p).base.sku, 'SV116008');
  assert.equal(evaluateProduct(a, p).base.sku, 'SV116008');
});

test('SV normal and stone size requirements and keychain weight/mappings stay enforced', () => {
  const compiled = compileDefinition(materializeMagentoV1(catalog()));
  for (const souvenir of [1, 2, 3, 4, 5, 7, 8, 9]) {
    const p = product('SV', { souvenir, size: undefined }, { magento_name_subject_ua: 'Сувенір', magento_name_subject_en: 'souvenir' });
    for (const r of [mapProduct(p, catalog()), evaluateProduct(compiled, p)]) assert.ok(r.errors.some(e => e.field === 'rozmir_suveniriv'));
  }
  for (const weight of [undefined, null, '', 0, -1, '12,7', 'invalid']) {
    const p = product('SV', { size: undefined, weight });
    for (const r of [mapProduct(p, catalog()), evaluateProduct(compiled, p)]) assert.ok(r.errors.some(e => e.field === 'decor_weight'));
  }
  assert.ok(mapProduct(product('SV', { size: undefined, material: 999 }), catalog()).errors.length);
});

test('canonical future save and unchanged historical repair produce ready keychains with unchanged physical data', () => {
  const p = product('SV', { size: undefined, weight: '12,7' });
  const historical = targetProduct(p);
  assert.equal(historical.details.answers.weight, '12.7');
  const canonical = { ...p, details: { ...p.details, answers: normalizeProductInputAnswers('SV', p.details.answers) } };
  for (const r of [historical, canonical]) {
    assert.deepEqual(mapProduct(r, catalog()).errors, []);
    assert.equal(r.weight, p.weight);
    assert.equal(r.total_price_uah, p.total_price_uah);
    assert.equal(r.full_sku, p.full_sku);
    assert.equal(mapProduct(r, catalog()).base.rozmir_suveniriv, '');
  }
  assert.equal(p.details.answers.weight, '12,7');
});
