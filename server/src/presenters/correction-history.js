const { toUahNumber } = require('../utils/money');
const {
  normalizeCorrectionRow,
} = require('../services/correction-history/correction-history-normalizer');

function presentCorrectionHistoryReport(data, config, pagination) {
  const summary = data.summaryRow;
  return {
    items: data.itemRows.map((row) => normalizeCorrectionRow(row, config)),
    summary: {
      totalCount: Number(summary.total_count || 0),
      increasedCount: Number(summary.increased_count || 0),
      decreasedCount: Number(summary.decreased_count || 0),
      unchangedCount: Number(summary.unchanged_count || 0),
      netPriceDeltaUah: toUahNumber(summary.net_price_delta_uah) || 0,
      firstAt: summary.first_at,
      lastAt: summary.last_at,
    },
    categories: data.categoryRows
      .filter((row) => row.category_code)
      .map((row) => ({
        code: row.category_code,
        name: config?.categories?.[row.category_code]?.name || row.category_code,
        count: Number(row.count || 0),
      })),
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

function getCorrectionChangesText(item) {
  return item.changes
    .map((change) => `${change.questionLabel}: ${change.fromLabel} -> ${change.toLabel}`)
    .join('; ');
}

module.exports = {
  getCorrectionChangesText,
  presentCorrectionHistoryReport,
};
