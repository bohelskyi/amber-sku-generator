const pool = require('../../db/pool');
const { REPRICING_SCOPE_SCENARIO } = require('./constants');
const { buildPricingChange, buildPricingState } = require('./pricing-state');

async function getRepricingBatches(limit = 20) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await pool.query(
    `SELECT b.id, b.scope, b.scenario_id, b.category_code, b.scenario_name, b.status,
            b.candidate_count, b.changed_count, b.unchanged_count, b.skipped_count,
            b.error_count, b.created_at, b.applied_at, b.rolled_back_at,
            (
              b.status = 'completed'
              AND NOT EXISTS (
                SELECT 1
                FROM repricing_items ri
                LEFT JOIN products p ON p.id = ri.product_id
                WHERE ri.batch_id = b.id
                  AND (
                    p.id IS NULL
                    OR COALESCE(p.status, 'active') <> 'active'
                    OR p.details #>> '{repricing,batchId}' IS DISTINCT FROM b.id::text
                    OR jsonb_build_object(
                      'totalPrice', p.total_price,
                      'totalPriceUah', p.total_price_uah,
                      'pricePerGram', p.price_per_gram,
                      'uahRate', p.uah_rate,
                      'details', p.details
                    ) IS DISTINCT FROM ri.new_payload
                  )
              )
            ) AS can_rollback
     FROM repricing_batches b
     ORDER BY b.id DESC
     LIMIT $1`,
    [normalizedLimit]
  );

  return result.rows.map((batch) => ({
    ...batch,
    id: Number(batch.id),
    scope: batch.scope || REPRICING_SCOPE_SCENARIO,
    scenario_id: batch.scenario_id === null ? null : Number(batch.scenario_id),
    candidate_count: Number(batch.candidate_count || 0),
    changed_count: Number(batch.changed_count || 0),
    unchanged_count: Number(batch.unchanged_count || 0),
    skipped_count: Number(batch.skipped_count || 0),
    error_count: Number(batch.error_count || 0),
    can_rollback: Boolean(batch.can_rollback),
  }));
}

async function getRepricingBatchItems(batchId) {
  const batchResult = await pool.query(
    'SELECT id, scenario_name, applied_at FROM repricing_batches WHERE id = $1 LIMIT 1',
    [Number(batchId)]
  );
  if (batchResult.rows.length === 0) {
    const error = new Error('Партію переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }

  const itemsResult = await pool.query(
    `SELECT sku, old_price_uah, new_price_uah, price_delta_uah, old_payload, new_payload,
            COALESCE((new_payload #>> '{details,repricing,manualOverride}')::boolean, FALSE)
              AS manual_override
     FROM repricing_items
     WHERE batch_id = $1
     ORDER BY id`,
    [Number(batchId)]
  );

  const items = itemsResult.rows.map((item) => {
    const oldPayload = item.old_payload || {};
    const newPayload = item.new_payload || {};
    const storedChange = newPayload?.details?.repricing?.pricingChange;
    const pricingChange = storedChange || buildPricingChange(
      buildPricingState({
        details: oldPayload.details || {},
        pricePerGram: oldPayload.pricePerGram,
        uahRate: oldPayload.uahRate,
        priceUah: oldPayload.totalPriceUah ?? item.old_price_uah,
      }),
      buildPricingState({
        details: newPayload.details || {},
        pricePerGram: newPayload.pricePerGram,
        uahRate: newPayload.uahRate,
        priceUah: newPayload.totalPriceUah ?? item.new_price_uah,
      }),
      { manualOverride: item.manual_override }
    );

    return {
      sku: item.sku,
      old_price_uah: item.old_price_uah,
      new_price_uah: item.new_price_uah,
      price_delta_uah: item.price_delta_uah,
      manual_override: item.manual_override,
      old_matrix_name: pricingChange.oldMatrixName,
      new_matrix_name: pricingChange.newMatrixName,
      old_price_mode: pricingChange.oldPriceMode,
      new_price_mode: pricingChange.newPriceMode,
      old_price_per_gram_usd: pricingChange.oldPricePerGram,
      new_price_per_gram_usd: pricingChange.newPricePerGram,
      old_uah_rate: pricingChange.oldUahRate,
      new_uah_rate: pricingChange.newUahRate,
      change_reason: (pricingChange.reasonLabels || []).join('; '),
    };
  });

  return { batch: batchResult.rows[0], items };
}

async function getRepricingRollbackItems(batchId) {
  const data = await getRepricingBatchItems(batchId);
  return {
    batch: data.batch,
    items: data.items.map((item) => ({
      sku: item.sku,
      current_price_uah: item.new_price_uah,
      restored_price_uah: item.old_price_uah,
      difference_uah: item.old_price_uah === null
        ? null
        : Number(item.old_price_uah) - Number(item.new_price_uah),
    })),
  };
}

module.exports = {
  getRepricingBatchItems,
  getRepricingBatches,
  getRepricingRollbackItems,
};

