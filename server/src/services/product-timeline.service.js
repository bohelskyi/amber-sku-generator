const {
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
} = require('./product-timeline/historical-normalization');
const { analyzeLineage } = require('./product-timeline/lineage-analysis');
const {
  loadProductTimelineData,
} = require('./product-timeline/product-timeline-query');
const { presentProductTimeline } = require('../presenters/product-timeline');
const pool = require('../db/pool');
const { resolveProductLookup } = require('./product/public-identity');

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
  const resolved = await resolveProductLookup(pool, querySku);
  if (!resolved.product) {
    throw timelineError('Товар з таким артикулом не знайдено.', 404, 'SKU_HISTORY_NOT_FOUND');
  }
  if (resolved.lookupKind === 'internal' && resolved.internalMatchCount > 1) {
    throw timelineError(
      'Артикул відповідає кільком історичним товарам.',
      409,
      'AMBIGUOUS_HISTORICAL_SKU'
    );
  }
  const data = await loadProductTimelineData(Number(resolved.product.id));
  const statuses = await require('./magento/automatic-sync-status').readStatuses(
    require('../db/pool'), data.products.map((p) => Number(p.id)));
  return presentProductTimeline(querySku, data, statuses);
}

module.exports = {
  analyzeLineage,
  buildSchemaMap,
  getPayloadSchema,
  getProductTimeline,
  normalizeStoredChanges,
  normalizeTimelineSku,
};
