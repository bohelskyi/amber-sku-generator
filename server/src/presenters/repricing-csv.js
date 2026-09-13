const { buildCsv } = require('../utils/csv');
const { presentCsvDownload } = require('./csv-download');

const REPRICING_BATCH_COLUMNS = Object.freeze([
  'sku',
  'old_matrix',
  'new_matrix',
  'old_price_mode',
  'new_price_mode',
  'old_price_per_gram_usd',
  'new_price_per_gram_usd',
  'old_uah_rate',
  'new_uah_rate',
  'old_price_uah',
  'new_price_uah',
  'difference_uah',
  'change_reason',
  'price_source',
]);

const REPRICING_ROLLBACK_COLUMNS = Object.freeze([
  'sku',
  'current_price_uah',
  'restored_price_uah',
  'difference_uah',
]);

function presentRepricingBatchCsv(batchId, items) {
  const csv = buildCsv([
    REPRICING_BATCH_COLUMNS,
    ...items.map((item) => [
      item.sku,
      item.old_matrix_name ?? '',
      item.new_matrix_name ?? '',
      item.old_price_mode ?? '',
      item.new_price_mode ?? '',
      item.old_price_per_gram_usd ?? '',
      item.new_price_per_gram_usd ?? '',
      item.old_uah_rate ?? '',
      item.new_uah_rate ?? '',
      item.old_price_uah ?? '',
      item.new_price_uah,
      item.price_delta_uah,
      item.change_reason,
      item.manual_override ? 'manual' : 'matrix',
    ]),
  ]);

  return presentCsvDownload(`amber-repricing-${Number(batchId)}.csv`, csv);
}

function presentRepricingRollbackCsv(batchId, items) {
  const csv = buildCsv([
    REPRICING_ROLLBACK_COLUMNS,
    ...items.map((item) => [
      item.sku,
      item.current_price_uah ?? '',
      item.restored_price_uah ?? '',
      item.difference_uah ?? '',
    ]),
  ]);

  return presentCsvDownload(`amber-repricing-rollback-${Number(batchId)}.csv`, csv);
}

module.exports = {
  REPRICING_BATCH_COLUMNS,
  REPRICING_ROLLBACK_COLUMNS,
  presentRepricingBatchCsv,
  presentRepricingRollbackCsv,
};
