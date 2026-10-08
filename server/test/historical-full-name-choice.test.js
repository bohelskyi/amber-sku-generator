const test = require('node:test');
const assert = require('node:assert/strict');
const { fullNameChoice, nameOverride } = require('../src/services/magento/historical-full-name-choice');
const { applyNameOverride } = require('../src/services/magento/name-reconciliation');
test('full names preserve exact reviewed text, 255 characters, and cannot mutate SKU', () => {
  const generated = { all: 'Камінь з бурштину. Арт: SV11511060', en: 'Amber Amber stone. Art: SV11511060' };
  const choice = fullNameChoice({ nameMode: 'full', fullNameUa: '  Камінь з інклюзом  ', fullNameEn: 'X'.repeat(255) });
  const product = { public_sku: 'SV11511060', magento_name_override: nameOverride(generated, choice) };
  const mapped = { base: { sku: product.public_sku, name: generated.all }, english: { sku: product.public_sku, name: generated.en } };
  assert.deepEqual(applyNameOverride(mapped, product), generated);
  assert.equal(mapped.base.name, choice.values.all); assert.equal(mapped.english.name, choice.values.en);
  assert.equal(mapped.base.sku, 'SV11511060'); assert.equal(mapped.english.sku, 'SV11511060');
  assert.equal(nameOverride(generated, fullNameChoice({})), null);
  const changed = { base: { name: 'Changed generation' }, english: { name: generated.en } };
  applyNameOverride(changed, product); assert.equal(changed.base.name, 'Changed generation');
});
test('new full-name decisions reject missing pairs, controls, overlength and mixed template input', () => {
  for (const input of [{ nameMode: 'other' }, { fullNameUa: 'Ignored' }, { nameMode: 'full', fullNameUa: 'A' },
    { nameMode: 'full', fullNameUa: ' ', fullNameEn: 'B' }, { nameMode: 'full', fullNameUa: 'A'.repeat(256), fullNameEn: 'B' },
    { nameMode: 'full', fullNameUa: 'A', fullNameEn: 'B\nC' }]) assert.throws(() => fullNameChoice(input), { code: 'HISTORICAL_FULL_NAME_INVALID' });
});

test('exact overrides use the actual supplied inline and ordinary referenced name cells', () => {
  const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
  const { compileDefinition } = require('../src/services/export-templates/definition');
  const { catalog, product } = require('./fixtures/magento-v1/contract');
  const { evaluate } = require('../src/services/magento/binding-evidence-products');
  const supplied = require('./fixtures/historical-production-sv-names.json').definition;
  for (const inline of [false, true]) {
    const definition = materializeMagentoV1(catalog(), { publicSku: true });
    if (inline) for (const row of definition.groups.find(g => g.route === 'SV').rows)
      row.cells.name = structuredClone(supplied.groups[0].rows.find(r => r.id === row.id).cells.name);
    const value = { ...product('SV', { souvenir: 4, weight: 0.9 }), public_sku: 'SV11511060',
      magento_name_subject_ua: 'Камінь бурштину з інклюзом', magento_name_subject_en: 'Amber stone with an inclusion' };
    const amber = { compiled: compileDefinition(definition) }, before = JSON.stringify(definition);
    const generated = evaluate(amber, value);
    assert.equal(generated.base.name, value.magento_name_subject_ua + ' з бурштину. Арт: SV11511060');
    assert.equal(generated.english.name, 'Amber ' + value.magento_name_subject_en + '. Art: SV11511060');
    value.magento_name_override = nameOverride(generated.generatedNames, fullNameChoice({ nameMode: 'full',
      fullNameUa: 'Камінь з інклюзом', fullNameEn: 'Stone with an inclusion' }));
    const edited = evaluate(amber, value);
    assert.equal(edited.base.name, 'Камінь з інклюзом'); assert.equal(edited.english.name, 'Stone with an inclusion');
    assert.equal(edited.base.sku, 'SV11511060'); assert.equal(JSON.stringify(definition), before);
  }
});
