const { getCorrectionChangesText } = require('../services/correction-history.service');
const { buildCsv } = require('../utils/csv');
const { presentCsvDownload } = require('./csv-download');

const CORRECTION_HISTORY_COLUMNS = Object.freeze([
  'date',
  'category',
  'old_sku',
  'new_sku',
  'weight_g',
  'old_price_uah',
  'new_price_uah',
  'difference_uah',
  'old_price_per_gram_usd',
  'new_price_per_gram_usd',
  'old_matrix',
  'new_matrix',
  'changed_characteristics',
  'reason',
]);

function presentCorrectionHistoryCsv(items) {
  const csv = buildCsv([
    CORRECTION_HISTORY_COLUMNS,
    ...items.map((item) => [
      item.createdAt ? new Date(item.createdAt).toISOString() : '',
      item.categoryCode,
      item.sourceSku,
      item.correctedSku,
      item.weight ?? '',
      item.oldPriceUah ?? '',
      item.newPriceUah ?? '',
      item.priceDeltaUah ?? '',
      item.oldPricePerGram ?? '',
      item.newPricePerGram ?? '',
      item.oldMatrixName ?? '',
      item.newMatrixName ?? '',
      getCorrectionChangesText(item),
      item.reason,
    ]),
  ]);

  return presentCsvDownload('amber-correction-history.csv', csv);
}

module.exports = {
  CORRECTION_HISTORY_COLUMNS,
  presentCorrectionHistoryCsv,
};
