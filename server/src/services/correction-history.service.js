const { getAppConfig } = require('./catalog.service');
const {
  normalizeHistoryFilters,
} = require('./correction-history/correction-history-filters');
const {
  loadCorrectionHistoryReport,
} = require('./correction-history/correction-history-query');
const {
  normalizeCorrectionRow,
} = require('./correction-history/correction-history-normalizer');
const {
  getCorrectionChangesText,
  presentCorrectionHistoryReport,
} = require('../presenters/correction-history');

async function getCorrectionHistory(filters = {}, options = {}) {
  const normalizedFilters = normalizeHistoryFilters(filters);
  const pagination = {
    forExport: options.forExport === true,
    limit: Math.min(Math.max(Math.floor(Number(filters.limit) || 200), 1), 500),
    offset: Math.max(Math.floor(Number(filters.offset) || 0), 0),
  };
  const [data, config] = await Promise.all([
    loadCorrectionHistoryReport(normalizedFilters, pagination),
    getAppConfig(),
  ]);
  return presentCorrectionHistoryReport(data, config, pagination);
}

module.exports = {
  getCorrectionChangesText,
  getCorrectionHistory,
  normalizeCorrectionRow,
  normalizeHistoryFilters,
};
