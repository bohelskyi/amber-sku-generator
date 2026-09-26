const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLineage } = require('../src/services/full-product-export-exposure');
const { getProductStateSignature, getRecountStateSignature } = require('../src/services/product/product-signatures');
const { inheritRecountNames } = require('../src/services/product/recount-name-inheritance');
const { confirmFullProductRevisions, membershipEvidence } = require('../src/services/full-product-export.service');

function lineage() {
  return { products: [{ id: 1, full_sku: 'A', status: 'active' }], corrections: [], snapshots: [],
    artifacts: [], revisions: [], events: [], state: [{ exported_to_product_id: 99 }],
    lifecycle: [{ product_id: 1, evidence: { origin: 'ordinary_save' } }], members: [] };
}
test('full lifecycle coverage distinguishes new obligations from historical absence below cursor', () => {
  const input = lineage();
  assert.equal(classifyLineage(input, 1, { exclude_from_export: 0 }).route, 'normal');
  input.lifecycle[0].evidence = { origin: 'migration_039' };
  assert.equal(classifyLineage(input, 1, {}).holdReason, 'historical_ambiguity');
});
test('full lifecycle classifier uses complete ancestors, exact exposure, exclusions and invalid lineage', () => {
  const input = lineage();
  input.products[0].corrected_to_product_id = 2;
  input.products.push({ id: 2, full_sku: 'B', status: 'active', corrected_from_product_id: 1 });
  input.corrections.push({ id: 7, source_product_id: 1, corrected_product_id: 2, source_sku: 'A', corrected_sku: 'B' });
  input.lifecycle.push({ product_id: 2, source_correction_id: 7, evidence: { origin: 'recount' } });
  for (const status of ['generated', 'confirmed']) {
    input.members = [{ product_id: 1, sku_at_capture: 'A', snapshot_id: 'snapshot', status, capture_kind: 'full_product' }];
    assert.equal(classifyLineage(input, 2, { exclude_from_export: 1 }).holdReason, 'prior_exposure');
  }
  input.lifecycle[0].hold_reason = 'intentional_exclusion';
  assert.equal(classifyLineage(input, 2, {}).holdReason, 'intentional_exclusion');
  input.corrections = [];
  assert.equal(classifyLineage(input, 2, {}).holdReason, 'invalid_lineage');
});
test('recount binds both subjects and pending review without changing generic signatures', () => {
  const product = { id: 1, magento_name_subject_ua: 'Назва', magento_name_subject_en: 'Name' };
  for (const change of [{ magento_name_subject_ua: 'Нова' }, { magento_name_subject_en: 'New' }, { magento_name_review_required: true }]) {
    assert.equal(getProductStateSignature(product), getProductStateSignature({ ...product, ...change }));
    assert.notEqual(getRecountStateSignature(product), getRecountStateSignature({ ...product, ...change }));
  }
});
test('paired name inheritance approves only proven identity-neutral information/representation changes', () => {
  const source = { category: 'SV', sku_schema_version_id: 9, weight: '1260.000',
    magento_name_subject_ua: 'Фігура', magento_name_subject_en: 'Figurine',
    details: { answers: { kind: 1, weight: '1260,0', size: 'small' } } };
  const target = { categoryCode: 'SV', skuSchemaVersionId: 9, weight: 1260,
    answers: { kind: 1, weight: 1260, size: 'large' } };
  const schema = { id: 9, questions: [{ key: 'kind', options: [{ value_id: 1 }, { value_id: 2 }] }] };
  const questions = ['size','weight'].map((key) => ({ key, input_type: 'text', include_in_sku: 0 }));
  const inherit = (s = source, t = target, q = questions) => inheritRecountNames(s, t, schema, q);
  assert.deepEqual(inherit(), { ua: 'Фігура', en: 'Figurine', reviewRequired: false });
  assert.equal(inherit({ ...source, magento_name_review_required: true }).reviewRequired, true);
  for (const patch of [{ categoryCode: 'BR' }, { skuSchemaVersionId: 10 }, { weight: 1261 },
    { answers: { ...target.answers, kind: 2 } }, { answers: { ...target.answers, unknown: 'x' } }]) {
    assert.equal(inherit(source, { ...target, ...patch }).reviewRequired, true);
  }
  assert.equal(inherit(source, target, []).reviewRequired, true);
});
test('confirmation ignores historical snapshots and confirms only captured bigint revisions without product locks', async () => {
  const queries = [];
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('FROM export_snapshot_products')) return { rows: [{ product_id: 1, capture_kind: 'full_product',
      full_revision: '9007199254740993', delivery_version: '1' }] };
    if (sql.includes('SELECT * FROM product_full_export_state')) return { rows: [{ product_id: 1,
      revision: '9007199254740994', delivery_version: '2' }] };
    return { rows: [] };
  } };
  await confirmFullProductRevisions(client, { id: 'old' });
  assert.equal(queries.length, 0);
  await confirmFullProductRevisions(client, { id: 'new', full_product_lifecycle_version: 1, row_count: 1 });
  assert.deepEqual(queries.at(-1).values, [1, '9007199254740993']);
  assert.ok(queries.every((q) => !/FROM products\b/i.test(q.sql)));
  await assert.rejects(confirmFullProductRevisions(client, { full_product_lifecycle_version: 2 }), /Unknown/);
});
test('membership evidence binds immutable bytes, exact SKU and independent full counters', () => {
  const snapshot = { id: 's', csv_content: 'sku\nA' }; const product = { id: 1, full_sku: 'A', category: 'BR' };
  const state = { revision: '1', deliveryVersion: '3' };
  const member = membershipEvidence(snapshot, product, state, [], true);
  assert.equal(member.fullRevision, '1'); assert.equal(member.sku, 'A');
  assert.notEqual(member.csvHash, membershipEvidence({ ...snapshot, csv_content: 'sku\nB' }, product, state, [], true).csvHash);
  assert.equal(membershipEvidence(snapshot, product, state, [], false).fullRevision, null);
});
