const pool = require('../../db/pool');

function getRepricingProductIds(previewOrItems = []) {
  const items = Array.isArray(previewOrItems)
    ? previewOrItems
    : previewOrItems?.items || [];
  return [...new Set(items
    .map((item) => Number(item.productId))
    .filter((productId) => Number.isInteger(productId) && productId > 0))]
    .sort((first, second) => first - second);
}

function normalizeBlockingCorrectionRequest(row) {
  return {
    id: Number(row.id),
    sourceProductId: Number(row.source_product_id),
    sourceSku: row.source_sku,
    proposedSku: row.proposed_sku,
    status: row.status,
  };
}

async function getBlockingCorrectionRequests(previewOrItems, queryable = pool) {
  const productIds = getRepricingProductIds(previewOrItems);
  if (productIds.length === 0) return [];

  const result = await queryable.query(
    `SELECT id, source_product_id, source_sku, proposed_sku, status
     FROM correction_requests
     WHERE source_product_id = ANY($1::int[])
       AND status = ANY($2::text[])
     ORDER BY updated_at, id`,
    [productIds, ['pending', 'in_progress']]
  );
  return result.rows.map(normalizeBlockingCorrectionRequest);
}

function assertNoBlockingCorrectionRequests(requests = []) {
  if (requests.length === 0) return;

  const requestIds = requests.map((request) => `#${request.id}`);
  const error = new Error(
    `Переоцінку зупинено: спочатку опрацюйте активні запити ${requestIds.join(', ')}, що належать цій матриці.`
  );
  error.statusCode = 409;
  error.details = {
    type: 'active_correction_requests',
    requests,
  };
  throw error;
}

module.exports = {
  assertNoBlockingCorrectionRequests,
  getBlockingCorrectionRequests,
  getRepricingProductIds,
};

