const assert = require('node:assert/strict');
const test = require('node:test');

const productService = require('../src/services/product.service');
const {
  getCorrectionPreviewSignature,
} = require('../src/services/correction-request.service');

test('product service keeps its eleven-export compatibility surface', () => {
  assert.deepEqual(Object.keys(productService), [
    'decodeSku',
    'getNextVariationSku',
    'buildProductPreview',
    'buildProductRecountPreview',
    'applyProductRecount',
    'saveProduct',
    'deleteProductBySku',
    'getRecentProducts',
    'getProductBySku',
    'getProductStateSignature',
    'getProductPreviewToken',
  ]);
});

test('product state signature preserves its serialized product snapshot', () => {
  assert.equal(productService.getProductStateSignature({
    id: '17',
    full_sku: 'NM111',
    category: 'NM',
    weight: '4.5',
    total_price: '12.34',
    total_price_uah: '500',
    price_per_gram: '2.7422',
    uah_rate: '40.5',
    status: 'active',
    corrected_to_product_id: null,
    sku_schema_version_id: '3',
    details: {
      answers: { processing: 2, quality: 1 },
      isCalibrated: 2,
    },
  }), 'e9c6ed384dd905fd76f850a4f6ee98147bc48432ecf22a67e8bf0beca5f8dfbb');
});

test('preview token preserves calibration state 2 and its serialized preview snapshot', () => {
  const token = productService.getProductPreviewToken({
    weightVal: 10,
    skuSchemaVersionId: 4,
    baseSku: 'ZZ1',
    mode: 'weight',
    priceMode: 'per_gram_usd',
    pricePerGram: '2.50',
    fixedPriceUah: null,
    totalPrice: '25.00',
    calculatedPriceUah: 1017,
    totalPriceUah: 1000,
    uahRate: 40,
    uahRateDate: '2026-08-31',
    uahRateFetchedAt: 'excluded from token',
  }, 'ZZ', { kind: 1, is_calibrated: 2 }, null);

  assert.equal(token, '8a179a390b5de9884f20186b8fada2fb685c93477515d736364214e31b1b7e33');
});

test('correction preview signature preserves its public re-export and snapshot', () => {
  assert.equal(getCorrectionPreviewSignature({
    source: {
      productId: 17,
      sku: 'NM111',
      totalPriceUah: 500,
      answers: { quality: 1, processing: 2 },
    },
    corrected: {
      fullSku: 'NM211',
      proposedFullSku: 'NM211',
      calculatedPriceUah: 611,
      autoPriceUah: 600,
      totalPriceUah: 600,
      answers: { quality: 2, processing: 2 },
    },
  }), '4bddf740391be82c8be27d07166698a6adf3863f8adb2e7add25482d516d34a5');
});
