const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../src/services/magento/recovery-history');
function fixture() {
  const base = { public_product_identity_id: '1', public_sku: 'AG-1', business_exclusion_state: 'none', exclude_from_export: 0,
    recount_compatibility_excluded: false, exclusion_provenance: null, independent_exclusion: false };
  return { products: [
    { ...base, id: 1, full_sku: 'OLD', status: 'corrected', route: 'retired', corrected_from_product_id: null, corrected_to_product_id: 2, source_correction_id: null },
    { ...base, id: 2, full_sku: 'CURRENT', status: 'active', route: 'hold', corrected_from_product_id: 1, corrected_to_product_id: null, source_correction_id: 10 },
  ], corrections: [{ id: 10, source_product_id: 1, corrected_product_id: 2, source_sku: 'OLD', corrected_sku: 'CURRENT' }] };
}
test('recovery distinguishes a stable recount from historical changed articles without inferring identity', () => {
  const { products, corrections } = fixture();
  assert.equal(describe(products, corrections, 2).stableRecount, true);
  products[0].public_product_identity_id = '99'; products[0].public_sku = 'OLD';
  const legacy = describe(products, corrections, 2);
  assert.equal(legacy.identityChanged, true); assert.equal(legacy.stableRecount, false);
  assert.deepEqual(legacy.products.map(p => p.article), ['OLD', 'AG-1']);
  assert.deepEqual(legacy.issues, [], 'changed legacy identity is not itself corrupt lineage');
});
test('missing lifecycle correlation is distinguished from contradictory product links', () => {
  const { products, corrections } = fixture(); products[1].source_correction_id = null;
  const old = describe(products, corrections, 2);
  assert.equal(old.stableRecount, false);
  assert.deepEqual(old.issues, [{ code: 'SOURCE_CORRECTION_NOT_RECORDED', productId: 2, correctionId: 10, recordedCorrectionId: null }]);
  products[0].corrected_to_product_id = null;
  assert.ok(describe(products, corrections, 2).issues.some(v => v.code === 'LINEAGE_LINK_MISMATCH'));
});
test('unknown ancestor exclusion, compatibility exclusion and incomplete or disconnected history never recommend stable confirmation', () => {
  for (const patch of [{ business_exclusion_state: 'unknown' }, { independent_exclusion: true }, { exclusion_provenance: 'unknown' },
    { recount_compatibility_excluded: true }, { route: 'normal' }]) {
    const { products, corrections } = fixture(); Object.assign(products[0], patch);
    assert.equal(describe(products, corrections, 2).stableRecount, false, JSON.stringify(patch));
  }
  const { products, corrections } = fixture();
  assert.equal(describe(products, corrections, 2, false).stableRecount, false);
  products.push({ ...products[0], id: 3, full_sku: 'DISCONNECTED', corrected_to_product_id: null });
  const result = describe(products, corrections, 2);
  assert.equal(result.stableRecount, false);
  assert.ok(result.issues.some(v => v.code === 'DISCONNECTED_IDENTITY_HISTORY'));
});
