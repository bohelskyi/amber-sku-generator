const test = require('node:test');
const assert = require('node:assert/strict');
const { applyManualOverridesToPreview } = require('../src/services/repricing/resolutions');
const { getRepricingProductIds } = require('../src/services/repricing/correction-blockers');
const manual = { productId: 1, sku: 'AG-1', status: 'unchanged', hasManualPrice: true, manualPreserved: true,
  oldPriceUah: 1300, newPriceUah: 1300, automaticPriceUah: 1200, pricingDetails: { matrix: {} } };
const preview = { scope: 'global', summary: {}, items: [manual] };
test('preserved manual UAH requires no resolution and permits only an explicit automatic opt-in', () => {
  const unchanged = applyManualOverridesToPreview(preview);
  assert.equal(unchanged.summary.errorCount, 0);
  assert.equal(unchanged.summary.changedCount, 0);
  assert.deepEqual(getRepricingProductIds(unchanged), []);
  const switched = applyManualOverridesToPreview(preview, [], [1]);
  assert.deepEqual(getRepricingProductIds(switched), [1]);
  assert.equal(switched.items[0].useAutomatic, true);
  assert.equal(switched.items[0].newPriceUah, 1200);
});
test('manual-to-automatic opt-in fails closed without valid automatic pricing', () => {
  assert.throws(() => applyManualOverridesToPreview({ ...preview, items: [{ ...manual, automaticPriceUah: null, pricingDetails: null }] }, [], [1]));
});
