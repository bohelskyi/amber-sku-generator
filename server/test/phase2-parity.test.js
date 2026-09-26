const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecountEvidence } = require('../src/services/product/recount-evidence');
const { getCorrectionDecisionSignature } = require('../src/services/product/product-signatures');
const { evaluateBatch } = require('../src/services/export-templates/evaluate');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { buildMagentoPayload } = require('../src/services/magento-products-v1');
const { product, catalog } = require('./fixtures/magento-v1/contract');

function fixture() {
  const source = { id: 1, full_sku: 'SV1', category: 'SV', status: 'active', weight: 10, sku_schema_version_id: 9,
    details: { answers: { kind: 1, size: 'old' } }, magento_name_subject_ua: 'Фігура', magento_name_subject_en: 'Figurine' };
  const target = { categoryCode: 'SV', skuSchemaVersionId: 9, answers: { kind: 1, size: 'new' }, weight: 10 };
  const input = { products: [{ id: 1, full_sku: 'SV1', status: 'active' }], corrections: [], snapshots: [], artifacts: [],
    revisions: [], events: [], state: [{ exported_to_product_id: 0 }], members: [], lifecycle: [{ product_id: 1,
      revision: '9007199254740993', confirmed_revision: '0', delivery_version: '1', route: 'normal', hold_reason: null,
      source_correction_id: null, evidence: { origin: 'ordinary_save' } }] };
  const client = { async query(sql) {
    if (sql.includes('AS members')) return { rows: [input] };
    if (sql.includes('FROM product_full_export_state')) return { rows: input.lifecycle };
    if (sql.includes('FROM sku_schema_versions')) return { rows: [{ id: 9, version: 1 }] };
    if (sql.includes('FROM sku_schema_questions')) return { rows: [{ question_id: 1, question_key: 'kind', value_id: 1, sku_code: '1' }] };
    if (sql.includes('FROM questions')) return { rows: [{ key: 'size', include_in_sku: 0, input_type: 'text' }] };
    throw new Error(`Unexpected evidence query: ${sql}`);
  } };
  return { source, target, input, derive: () => buildRecountEvidence(client, source, target, []) };
}

test('phase2 shared evidence preserves bigint counters and binds lifecycle, names, review and exposure in every pricing mode', async () => {
  for (const change of ['revision','delivery','names','review','exposure','target']) {
    const f = fixture(); const before = await f.derive();
    assert.equal(before.binding.lifecycle[0].revision, '9007199254740993');
    assert.equal(before.delivery.route, 'normal'); assert.equal(before.names.reviewRequired, false);
    if (change === 'revision') f.input.lifecycle[0].revision = '9007199254740994';
    if (change === 'delivery') f.input.lifecycle[0].delivery_version = '2';
    if (change === 'names') f.source.magento_name_subject_en = 'Updated';
    if (change === 'review') f.source.magento_name_review_required = true;
    if (change === 'target') f.target.answers.kind = 2;
    if (change === 'exposure') f.input.members.push({ product_id: 1, sku_at_capture: 'SV1', snapshot_id: 's',
      capture_kind: 'full_product', evidence_hash: 'hash', status: 'generated' });
    const after = await f.derive(); assert.notEqual(after.signature, before.signature, change);
    for (const decision of [null, { mode: 'system_auto' }, { mode: 'manual_uah', manualPriceUah: 21700 },
      { mode: 'usd_per_gram', usdPerGram: 2, marketingRoundingEnabled: false }]) {
      const preview = (e) => ({ source: { stateSignature: e.signature }, corrected: f.target });
      assert.notEqual(getCorrectionDecisionSignature(preview(before), decision), getCorrectionDecisionSignature(preview(after), decision));
    }
  }
});

test('phase2 lifecycle review blocks legacy and frozen-template readiness without changing reviewed CSV bytes', () => {
  const rules = catalog(); const definition = materializeMagentoV1(rules); const compiled = compileDefinition(definition);
  const saved = product('SV', {}, { magento_name_subject_ua: 'Фігура', magento_name_subject_en: 'Figurine' });
  for (const evaluate of [(p) => buildMagentoPayload([p], rules),
    (p) => evaluateBatch(compiled, [p], undefined, { review: true })]) {
    const before = evaluate(saved); assert.equal(before.readyCount, 1);
    const blocked = evaluate({ ...saved, magento_name_review_required: true });
    assert.equal(blocked.readyCount, 0); assert.equal(blocked.artifacts.length, 0);
    assert.ok(blocked.errors[0].fields.some((f) => f.code === 'manual_name_review_required'));
    const reviewed = evaluate({ ...saved, magento_name_review_required: false });
    assert.deepEqual(reviewed.artifacts, before.artifacts);
  }
  assert.deepEqual(compiled.definition, definition, 'review state does not mutate a frozen template');
});
