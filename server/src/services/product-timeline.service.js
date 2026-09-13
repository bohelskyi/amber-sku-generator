const {
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
} = require('./product-timeline/historical-normalization');
const { analyzeLineage } = require('./product-timeline/lineage-analysis');
const {
  loadProductTimelineData,
  loadTimelineSeedRows,
} = require('./product-timeline/product-timeline-query');
const { presentProductTimeline } = require('../presenters/product-timeline');

const MAX_SKU_LENGTH = 256;

function timelineError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeTimelineSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  if (!sku || sku.length > MAX_SKU_LENGTH) {
    throw timelineError('Вкажіть коректний артикул.', 400, 'INVALID_SKU');
  }
  return sku;
}

async function getProductTimeline(skuValue) {
  const querySku = normalizeTimelineSku(skuValue);
  const seedRows = await loadTimelineSeedRows(querySku);
  if (seedRows.length === 0) {
    throw timelineError('Товар з таким артикулом не знайдено.', 404, 'SKU_HISTORY_NOT_FOUND');
  }
  if (seedRows.length > 1) {
    throw timelineError(
      'Артикул відповідає кільком історичним товарам.',
      409,
      'AMBIGUOUS_HISTORICAL_SKU'
    );
  }
  const data = await loadProductTimelineData(Number(seedRows[0].id));
  return presentProductTimeline(querySku, data);
}

module.exports = {
  analyzeLineage,
  buildSchemaMap,
  getPayloadSchema,
  getProductTimeline,
  normalizeStoredChanges,
  normalizeTimelineSku,
};
