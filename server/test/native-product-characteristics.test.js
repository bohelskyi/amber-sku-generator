const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductPreview, buildNewProductPreview, getProductPreviewToken } = require('../src/services/product.service');
const { readCharacteristicConfiguration } = require('../src/services/product/characteristic-config');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { projectSupportProducts, upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { upgradeColumns } = require('../src/services/export-templates/column-contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');

function nativeDatabase() {
  const seen = [];
  const question = { id: 1, key: 'kind', label: 'Kind', input_type: 'options', required: 1,
    include_in_sku: 1, display_order: 1, options: [{ value_id: 7, sku_code: 'obsolete', label: 'Seven' }] };
  return { seen, question, async query(sql) {
    seen.push(sql);
    if (sql.includes('public_sku_activation')) return { rows: [{ enabled: true }] };
    if (sql.includes('to_jsonb(c)')) return { rows: [{ category: { code: 'ZZ', requires_weight: 0 }, questions: [question] }] };
    if (sql.includes('WITH requested')) return { rows: [{ category_code: 'ZZ', requires_weight: 0,
      marketing_rounding_enabled: 0, scenarios: [{ id: 1, category_code: 'ZZ', priority: 1,
        status: 'active', price_mode: 'fixed_uah', axis_x_key: 'kind', axis_y_key: null,
        apply_modifiers: false, match_json: {} }], matrix: [{ scenario_id: 1, x_val: 7, y_val: 0, price: '100' }],
      modifiers: [], weight_bands: [] }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
}

test('native preview validates semantic configuration without schemas, codes, sequence or reservations', async () => {
  const db = nativeDatabase();
  const result = await buildProductPreview({ categoryCode: 'ZZ', answers: { kind: '7' }, weight: '12,7' }, { queryable: db });
  assert.equal(result.mode, 'public_identity');
  for (const key of ['fullProposedSku', 'baseSku', 'nextSeq', 'skuSchemaVersionId', 'internalSku']) assert.equal(result[key], null);
  assert.equal(result.normalizedAnswers.kind, 7);
  assert.equal(result.totalPriceUah, 100);
  assert.equal(result.weightVal, 12.7);
  assert.ok(db.seen.every((sql) => !/sku_schema|sku_registry|sequence_number/.test(sql)));
  assert.ok(!JSON.stringify(result).includes('obsolete'));
});

test('native snapshot excludes encoding and binds requiredness/labels/numeric metadata', async () => {
  const db = nativeDatabase();
  const first = await readCharacteristicConfiguration(db, 'ZZ');
  db.question.options[0].sku_code = 'unrelated';
  assert.equal((await readCharacteristicConfiguration(db, 'ZZ')).config_hash, first.config_hash);
  db.question.numeric_validation = { kind: 'decimal', unit: 'cm', maxFractionDigits: 2 };
  assert.notEqual((await readCharacteristicConfiguration(db, 'ZZ')).config_hash, first.config_hash);
  await assert.rejects(buildProductPreview({ categoryCode: 'ZZ', answers: { kind: 7 }, weight: 0,
    characteristicConfigHash: first.config_hash }, { queryable: db }), { statusCode: 409 });
  const preview = { mode: 'public_identity', characteristicConfigHash: first.config_hash };
  assert.notEqual(getProductPreviewToken(preview, 'ZZ', {}, null),
    getProductPreviewToken({ ...preview, characteristicConfigHash: 'a'.repeat(64) }, 'ZZ', {}, null));
});

test('native creation manual price is authoritative, token bound and independent of an automatic matrix', async () => {
  const db = nativeDatabase();
  const payload = { categoryCode: 'ZZ', answers: { kind: 7 }, weight: '12,7',
    pricingDecision: { mode: 'manual_uah', manualPriceUah: '123,45', marketingRoundingEnabled: false } };
  const result = await buildNewProductPreview(payload, { queryable: db });
  assert.equal(result.totalPriceUah, 123.45); assert.equal(result.autoPriceUah, null);
  assert.equal(result.calculatedPriceUah, null); assert.equal(result.weightVal, 12.7);
  assert.deepEqual(result.pricingDecision, { mode: 'manual_uah', manualPriceUah: 123.45 });
  assert.ok(!db.seen.some((sql) => sql.includes('WITH requested')));
  const changed = await buildNewProductPreview({ ...payload, pricingDecision: { mode: 'manual_uah', manualPriceUah: 123.46 } }, { queryable: db });
  assert.notEqual(changed.previewToken, result.previewToken);
});

test('public evaluator 4 accepts native products for compatible routes and keeps NM/AR proof frozen', () => {
  const d = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
  d.evaluatorVersion = 'magento-declarative-4';
  for (const category of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) {
    const p = product(category, category === 'NM' ? { extra: 1 } : {}, { full_sku: null, public_sku: 'AG-000123' });
    const result = evaluateProduct(compileDefinition(d), projectSupportProducts([p], [])[0]);
    if (['NM', 'AR'].includes(category)) assert.ok(result.errors.some((e) => e.code === 'SOURCE_SUPPORT_INVALID'));
    else { assert.deepEqual(result.errors, []); assert.equal(result.base.sku, 'AG-000123'); }
  }
});

test('explicit evaluator 5 proves native NM/AR membership only from associated immutable characteristics', () => {
  const d = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
  d.evaluatorVersion = 'magento-declarative-5'; d.sourceContractVersion = 'public-product-characteristics-v1';
  const compiled = compileDefinition(d);
  for (const [category, key, value] of [['NM', 'extra', 1], ['AR', 'size', 28]]) {
    const p = product(category, { [key]: value }, { full_sku: null, public_sku: 'AG-000123', characteristic_version_id: '900' });
    const version = { id: '900', category_code: category, questions: [{ key, options: [{ value_id: value }] }] };
    const result = evaluateProduct(compiled, projectSupportProducts([p], [], [version])[0]);
    assert.deepEqual(result.errors, []); assert.equal(result.base.sku, 'AG-000123');
    assert.ok(evaluateProduct(compiled, { ...p, characteristics: version }).errors.some((e) => e.code === 'SOURCE_SUPPORT_INVALID'));
    assert.ok(evaluateProduct(compiled, projectSupportProducts([p], [], [{ ...version, category_code: 'BR' }])[0]).errors.length);
  }
});
