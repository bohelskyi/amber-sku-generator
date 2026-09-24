const test = require('node:test');
const assert = require('node:assert/strict');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { validateSourceReferences } = require('../src/services/export-templates/source-references');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { prepareDraft } = require('../src/services/export-templates/template.service');

test('OFFICE legacy KL information is approved narrowly; genuinely unknown keys still fail', () => {
  const d = materializeMagentoV1(officeCatalog());
  const e = officeEvidence();
  assert.equal(validateSourceReferences(d, e).some((v) => v.sourceId === 'KL.exact_size'), false);
  d.sources['KL.exact_size'].key = 'similar_exact_size';
  assert.ok(validateSourceReferences(d, e).some((v) => v.sourceId === 'KL.exact_size'));
  d.sources['KL.exact_size'].key = 'exact_size';
  d.sources['KL.exact_size'].category = 'NM';
  assert.ok(validateSourceReferences(d, e).some((v) => v.sourceId === 'KL.exact_size'));
  d.sources['KL.exact_size'].category = 'KL';
  d.sources['KL.exact_size'].kind = 'semantic';
  assert.ok(validateSourceReferences(d, e).some((v) => v.sourceId === 'KL.exact_size'));
  d.sources['KL.exact_size'].kind = 'information';
  e.questions.push({ category_code: 'KL', key: 'exact_size', include_in_sku: 1, value_ids: [] });
  assert.ok(validateSourceReferences(d, e).some((v) => v.sourceId === 'KL.exact_size'), 'contradictory current SKU metadata is not a legacy exception');
});

test('OFFICE exact disputed IDs retain immutable SKU evidence requirement and current-only details', () => {
  const d = materializeMagentoV1(officeCatalog());
  const e = officeEvidence();
  const before = structuredClone({ d, e });
  const diagnostics = validateSourceReferences(d, e);
  assert.deepEqual(diagnostics.map((v) => v.sourceId), ['NM.extra', 'AR.size']);
  for (const [id, ids] of [['NM.extra', ['0']], ['AR.size', ['29', '30', '31']]]) {
    const diagnostic = diagnostics.find((v) => v.sourceId === id);
    assert.deepEqual(diagnostic.unresolvedValueIds, ids);
    assert.equal(diagnostic.requirement, 'historical_sku_or_current_non_sku_value_ids');
    assert.ok(ids.every((value) => diagnostic.currentValueIds.includes(value)));
    assert.ok(ids.every((value) => !diagnostic.historicalValueIds.includes(value)));
    assert.equal(diagnostic.message, `Unverified semantic value IDs: ${id}: ${ids.join(', ')}`);
  }
  assert.deepEqual({ d, e }, before);
  assert.deepEqual(prepareDraft(d).definition, d, 'saving source issues does not rewrite sources');
});

test('OFFICE baseline captures catalog IDs, never fabricates them from reusable output tables', () => {
  const c = officeCatalog();
  c.get('NM').get('extra').options = [{ value_id: 1 }, { value_id: 2 }];
  const d = materializeMagentoV1(c);
  assert.deepEqual(d.questionContracts['NM.extra'].allowed, ['1', '2']);
  assert.equal(d.tables.nmExtra['0'], '', 'dormant compatibility mapping is retained');
  assert.deepEqual(d.questionContracts['AR.size'].allowed.slice(-3), ['29', '30', '31']);
  assert.equal(d.tables.arSize['29'], undefined, 'catalog membership cannot invent output mapping');
});

test('OFFICE historical values resolve without current options; current zero is not historical proof', () => {
  const d = materializeMagentoV1(officeCatalog()); const e = officeEvidence();
  e.schemas.find((s) => s.category_code === 'NM').questions[0].value_ids.push('0');
  e.questions.find((q) => q.category_code === 'NM' && q.key === 'extra').value_ids = ['1', '2'];
  assert.equal(validateSourceReferences(d, e).some((v) => v.sourceId === 'NM.extra'), false);
  d.questionContracts['NM.extra'].allowed.push('999');
  assert.deepEqual(validateSourceReferences(d, e).find((v) => v.sourceId === 'NM.extra').unresolvedValueIds, ['999']);
});

test('OFFICE KL current, legacy, both, absent and invalid-present values preserve ordered fallback', () => {
  const compiled = compileDefinition(materializeMagentoV1(officeCatalog()));
  for (const [answers, expected] of [
    [{ pedant_size: 'current' }, 'current'], [{ pedant_size: undefined, exact_size: 'legacy' }, 'legacy'],
    [{ pedant_size: 'current', exact_size: 'different legacy' }, 'current'],
    [{ pedant_size: undefined, exact_size: undefined }, ''],
    [{ pedant_size: '', exact_size: 'legacy' }, 'legacy'],
    [{ pedant_size: null, exact_size: 'legacy' }, 'legacy'],
    [{ pedant_size: '  ', exact_size: 'legacy' }, 'legacy'],
    [{ pedant_size: 0, exact_size: 'legacy' }, '0'],
    [{ pedant_size: false, exact_size: 'legacy' }, 'false'],
  ]) assert.equal(evaluateProduct(compiled, product('KL', answers)).base.rozmir_iuvelirnoho_vyrobu, expected);
  assert.equal(evaluateProduct(compiled, product('KL', { exact_size: {} })).base.rozmir_iuvelirnoho_vyrobu, '4,2/2,7 см', 'present primary never reads invalid fallback');
  assert.throws(() => evaluateProduct(compiled, product('KL', { pedant_size: {}, exact_size: 'legacy' })), { code: 'INPUT_INVALID' });
});

test('OFFICE product readiness retains zero compatibility and fails unknown/missing output values', () => {
  const compiled = compileDefinition(materializeMagentoV1(officeCatalog()));
  assert.equal(evaluateProduct(compiled, product('NM', { extra: 0 })).base.dodatkovo_namysta, '');
  assert.ok(evaluateProduct(compiled, product('NM', { extra: 999 })).errors.some((v) => v.field === 'dodatkovo_namysta'));
  for (const size of [29, 30, 31, 999]) assert.ok(evaluateProduct(compiled, product('AR', { size })).errors.some((v) => v.field === 'rozmir_kartyny'));
});
