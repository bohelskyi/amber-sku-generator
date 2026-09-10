const test = require('node:test');
const assert = require('node:assert/strict');

const { presentCorrectionHistoryCsv } = require('../src/presenters/correction-history-csv');
const {
  presentRepricingBatchCsv,
  presentRepricingRollbackCsv,
} = require('../src/presenters/repricing-csv');

test('correction history CSV preserves its BOM, headers, filename, and field order', () => {
  const presentation = presentCorrectionHistoryCsv([{
    createdAt: '2026-01-02T03:04:05.000Z',
    categoryCode: 'R',
    sourceSku: '=OLD',
    correctedSku: 'NEW',
    weight: 2.5,
    oldPriceUah: 100,
    newPriceUah: 120,
    priceDeltaUah: 20,
    oldPricePerGram: 1,
    newPricePerGram: 1.2,
    oldMatrixName: 'Old',
    newMatrixName: 'New',
    changes: [{ questionLabel: 'Color', fromLabel: 'A', toLabel: 'B' }],
    reason: 'Review, approved',
  }]);

  assert.equal(presentation.contentType, 'text/csv; charset=utf-8');
  assert.equal(
    presentation.contentDisposition,
    'attachment; filename="amber-correction-history.csv"'
  );
  assert.equal(presentation.body, [
    '\uFEFFdate,category,old_sku,new_sku,weight_g,old_price_uah,new_price_uah,difference_uah,old_price_per_gram_usd,new_price_per_gram_usd,old_matrix,new_matrix,changed_characteristics,reason',
    '2026-01-02T03:04:05.000Z,R,\'=OLD,NEW,2.5,100,120,20,1,1.2,Old,New,Color: A -> B,"Review, approved"',
  ].join('\n'));
});

test('repricing CSV presenters preserve byte-level columns and download metadata', () => {
  const batch = presentRepricingBatchCsv('7', [{
    sku: 'SKU-1',
    old_matrix_name: 'Old',
    new_matrix_name: 'New',
    old_price_mode: 'weight',
    new_price_mode: 'weight',
    old_price_per_gram_usd: 1,
    new_price_per_gram_usd: 2,
    old_uah_rate: 40,
    new_uah_rate: 41,
    old_price_uah: 100,
    new_price_uah: 200,
    price_delta_uah: 100,
    change_reason: 'matrix',
    manual_override: false,
  }]);
  const rollback = presentRepricingRollbackCsv('7', [{
    sku: 'SKU-1',
    current_price_uah: 200,
    restored_price_uah: 100,
    difference_uah: -100,
  }]);

  assert.equal(batch.contentDisposition, 'attachment; filename="amber-repricing-7.csv"');
  assert.equal(batch.body, [
    '\uFEFFsku,old_matrix,new_matrix,old_price_mode,new_price_mode,old_price_per_gram_usd,new_price_per_gram_usd,old_uah_rate,new_uah_rate,old_price_uah,new_price_uah,difference_uah,change_reason,price_source',
    'SKU-1,Old,New,weight,weight,1,2,40,41,100,200,100,matrix,matrix',
  ].join('\n'));
  assert.equal(
    rollback.contentDisposition,
    'attachment; filename="amber-repricing-rollback-7.csv"'
  );
  assert.equal(
    rollback.body,
    '\uFEFFsku,current_price_uah,restored_price_uah,difference_uah\nSKU-1,200,100,-100'
  );
});
