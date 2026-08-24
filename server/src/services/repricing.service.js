const crypto = require('node:crypto');
const pool = require('../db/pool');
const { calculatePricing } = require('./pricing.service');
const { roundUah } = require('../utils/money');
const { asRuleObject, isRuleMatched } = require('../utils/rules');

function getProductDetails(product) {
  if (!product?.details) return {};
  if (typeof product.details === 'object') return product.details;

  try {
    return JSON.parse(product.details);
  } catch {
    return {};
  }
}

function getPricingAnswers(product, details) {
  const answers = details.answers && typeof details.answers === 'object'
    ? { ...details.answers }
    : {};

  if (answers.is_calibrated === undefined && details.isCalibrated !== undefined) {
    answers.is_calibrated = details.isCalibrated;
  }

  return answers;
}

function hasManualPrice(details) {
  const value = details.manualPriceUah;
  return value !== null && value !== undefined && value !== '';
}

function getScenarioSnapshot(scenario) {
  return {
    id: Number(scenario.id),
    categoryCode: scenario.category_code,
    name: scenario.name,
    matchJson: asRuleObject(scenario.match_json),
    axisXKey: scenario.axis_x_key,
    axisYKey: scenario.axis_y_key || '',
    priority: Number(scenario.priority || 0),
    priceMode: scenario.price_mode,
    applyModifiers: scenario.apply_modifiers !== false,
  };
}

function getPreviewToken(scenario, changedItems) {
  const payload = {
    scenario: getScenarioSnapshot(scenario),
    changes: changedItems.map((item) => ({
      productId: item.productId,
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah,
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function getActiveScenario(scenarioId) {
  const result = await pool.query(
    `SELECT *
     FROM price_scenarios
     WHERE id = $1 AND COALESCE(status, 'active') = 'active'
     LIMIT 1`,
    [Number(scenarioId)]
  );

  if (result.rows.length === 0) {
    const error = new Error('Активну цінову матрицю не знайдено.');
    error.statusCode = 404;
    throw error;
  }

  return result.rows[0];
}

async function getRepricingScenarios() {
  const result = await pool.query(
    `SELECT s.id, s.category_code, s.name, s.group_name, s.match_json, s.axis_x_key,
            s.axis_y_key, s.priority, s.price_mode, s.apply_modifiers,
            COUNT(p.id)::int AS active_products_in_category
     FROM price_scenarios s
     LEFT JOIN products p
       ON p.category = s.category_code
      AND COALESCE(p.status, 'active') = 'active'
     WHERE COALESCE(s.status, 'active') = 'active'
     GROUP BY s.id
     ORDER BY s.category_code, s.priority DESC, s.name, s.id`
  );

  return result.rows.map((scenario) => ({
    ...scenario,
    id: Number(scenario.id),
    priority: Number(scenario.priority || 0),
    active_products_in_category: Number(scenario.active_products_in_category || 0),
  }));
}

function buildErrorItem(product, details, answers, code, message) {
  return {
    productId: Number(product.id),
    sku: product.full_sku,
    weight: product.weight === null ? null : Number(product.weight),
    answers,
    oldPriceUah: product.total_price_uah === null ? null : Number(product.total_price_uah),
    status: 'error',
    errorCode: code,
    message,
    hasManualPrice: hasManualPrice(details),
  };
}

async function buildRepricingPreview(scenarioId) {
  const scenario = await getActiveScenario(scenarioId);
  const scenarioRule = asRuleObject(scenario.match_json);
  const productsResult = await pool.query(
    `SELECT id, full_sku, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export
     FROM products
     WHERE category = $1
       AND COALESCE(status, 'active') = 'active'
     ORDER BY id`,
    [scenario.category_code]
  );

  const items = [];
  let skippedCount = 0;

  for (const product of productsResult.rows) {
    const details = getProductDetails(product);
    const answers = getPricingAnswers(product, details);
    if (!isRuleMatched(scenarioRule, answers)) continue;

    if (hasManualPrice(details)) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'manual_price',
        'Товар має ручну ціну.'
      ));
      continue;
    }

    try {
      const pricing = await calculatePricing(
        product.category,
        answers,
        product.weight,
        answers.is_calibrated
      );
      const selectedScenarioId = Number(pricing.pricingDetails?.scenario?.id || 0);
      if (selectedScenarioId !== Number(scenario.id)) {
        skippedCount += 1;
        continue;
      }

      const newPriceUah = roundUah(pricing.currencyPayload?.totalPriceUah);
      if (!pricing.pricingDetails?.matrix || newPriceUah === null || newPriceUah <= 0) {
        items.push(buildErrorItem(
          product,
          details,
          answers,
          'price_missing',
          pricing.logMessage || 'Не вдалося розрахувати нову ціну.'
        ));
        continue;
      }

      const oldPriceUah = product.total_price_uah === null
        ? null
        : Number(product.total_price_uah);
      const isChanged = oldPriceUah === null || Math.abs(oldPriceUah - newPriceUah) >= 0.005;
      items.push({
        productId: Number(product.id),
        sku: product.full_sku,
        weight: product.weight === null ? null : Number(product.weight),
        answers,
        oldPriceUah,
        newPriceUah,
        priceDeltaUah: Number((newPriceUah - Number(oldPriceUah || 0)).toFixed(2)),
        status: isChanged ? 'changed' : 'unchanged',
        matrixName: pricing.pricingDetails.scenario?.name || scenario.name,
        priceMode: pricing.priceMode,
        pricePerGram: Number(pricing.pricePerGram || 0),
        totalPrice: Number(pricing.totalPrice || 0),
        uahRate: pricing.currencyPayload?.uahRate === null
          ? null
          : Number(pricing.currencyPayload?.uahRate),
        logMessage: pricing.logMessage,
        pricingDetails: pricing.pricingDetails,
      });
    } catch (error) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'calculation_failed',
        error.message || 'Помилка розрахунку ціни.'
      ));
    }
  }

  const changedItems = items.filter((item) => item.status === 'changed');
  const unchangedItems = items.filter((item) => item.status === 'unchanged');
  const errorItems = items.filter((item) => item.status === 'error');

  return {
    scenario: getScenarioSnapshot(scenario),
    previewToken: getPreviewToken(scenario, changedItems),
    summary: {
      candidateCount: items.length + skippedCount,
      changedCount: changedItems.length,
      unchangedCount: unchangedItems.length,
      skippedCount,
      errorCount: errorItems.length,
    },
    items,
  };
}

function getUpdatedDetails(details, item, batchId, appliedAt) {
  return {
    ...details,
    logMessage: item.logMessage,
    autoPriceUah: String(item.newPriceUah),
    pricingScenario: item.pricingDetails?.scenario || null,
    repricing: {
      batchId,
      scenarioId: item.pricingDetails?.scenario?.id || null,
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah,
      appliedAt,
    },
  };
}

async function getBatchByPreviewToken(previewToken, client = pool) {
  const result = await client.query(
    `SELECT id, scenario_id, category_code, scenario_name, candidate_count, changed_count,
            unchanged_count, skipped_count, error_count, status, created_at, applied_at
     FROM repricing_batches
     WHERE preview_token = $1
     LIMIT 1`,
    [previewToken]
  );
  return result.rows[0] || null;
}

async function applyRepricing({ scenarioId, previewToken }) {
  if (!previewToken) {
    const error = new Error('Спочатку сформуйте попередній перегляд.');
    error.statusCode = 400;
    throw error;
  }

  const existingBatch = await getBatchByPreviewToken(previewToken);
  if (existingBatch) return { success: true, alreadyApplied: true, batch: existingBatch };

  const preview = await buildRepricingPreview(scenarioId);
  if (preview.previewToken !== previewToken) {
    const error = new Error('Дані або ціни змінилися. Сформуйте попередній перегляд повторно.');
    error.statusCode = 409;
    throw error;
  }
  if (preview.summary.errorCount > 0) {
    const error = new Error('Переоцінку зупинено: у попередньому перегляді є помилки.');
    error.statusCode = 422;
    throw error;
  }
  if (preview.summary.changedCount === 0) {
    const error = new Error('Немає товарів зі зміненою ціною.');
    error.statusCode = 422;
    throw error;
  }

  const changedItems = preview.items.filter((item) => item.status === 'changed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchResult = await client.query(
      `INSERT INTO repricing_batches
       (scenario_id, category_code, scenario_name, scenario_snapshot, preview_token, status,
        candidate_count, changed_count, unchanged_count, skipped_count, error_count, applied_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'completed', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
       ON CONFLICT (preview_token) DO NOTHING
       RETURNING id, applied_at`,
      [
        preview.scenario.id,
        preview.scenario.categoryCode,
        preview.scenario.name,
        JSON.stringify(preview.scenario),
        preview.previewToken,
        preview.summary.candidateCount,
        preview.summary.changedCount,
        preview.summary.unchangedCount,
        preview.summary.skippedCount,
        preview.summary.errorCount,
      ]
    );

    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const batch = await getBatchByPreviewToken(previewToken);
      return { success: true, alreadyApplied: true, batch };
    }

    const batchId = Number(batchResult.rows[0].id);
    const appliedAt = batchResult.rows[0].applied_at;

    for (const item of changedItems) {
      const productResult = await client.query(
        `SELECT id, full_sku, weight, total_price, total_price_uah, price_per_gram,
                uah_rate, details, status, exclude_from_export
         FROM products
         WHERE id = $1
         FOR UPDATE`,
        [item.productId]
      );
      const product = productResult.rows[0];
      if (!product || String(product.status || 'active') !== 'active') {
        const error = new Error(`Товар ${item.sku} змінив статус під час переоцінки.`);
        error.statusCode = 409;
        throw error;
      }

      const currentPrice = product.total_price_uah === null
        ? null
        : Number(product.total_price_uah);
      if (currentPrice !== item.oldPriceUah) {
        const error = new Error(`Ціна товару ${item.sku} змінилася під час переоцінки.`);
        error.statusCode = 409;
        throw error;
      }

      const oldDetails = getProductDetails(product);
      const nextDetails = getUpdatedDetails(oldDetails, item, batchId, appliedAt);
      const oldPayload = {
        totalPrice: product.total_price === null ? null : Number(product.total_price),
        totalPriceUah: currentPrice,
        pricePerGram: product.price_per_gram === null ? null : Number(product.price_per_gram),
        uahRate: product.uah_rate === null ? null : Number(product.uah_rate),
        details: oldDetails,
      };
      const newPayload = {
        totalPrice: item.totalPrice,
        totalPriceUah: item.newPriceUah,
        pricePerGram: item.pricePerGram,
        uahRate: item.uahRate,
        details: nextDetails,
      };

      await client.query(
        `UPDATE products
         SET total_price = $1,
             total_price_uah = $2,
             price_per_gram = $3,
             uah_rate = $4,
             details = $5::jsonb
         WHERE id = $6`,
        [
          item.totalPrice,
          item.newPriceUah,
          item.pricePerGram,
          item.uahRate,
          JSON.stringify(nextDetails),
          item.productId,
        ]
      );

      await client.query(
        `INSERT INTO repricing_items
         (batch_id, product_id, sku, old_price_uah, new_price_uah, price_delta_uah,
          old_payload, new_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [
          batchId,
          item.productId,
          item.sku,
          item.oldPriceUah,
          item.newPriceUah,
          item.priceDeltaUah,
          JSON.stringify(oldPayload),
          JSON.stringify(newPayload),
        ]
      );
    }

    await client.query('COMMIT');
    return {
      success: true,
      alreadyApplied: false,
      batch: {
        id: batchId,
        scenario_id: preview.scenario.id,
        scenario_name: preview.scenario.name,
        category_code: preview.scenario.categoryCode,
        ...preview.summary,
        applied_at: appliedAt,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getRepricingBatches(limit = 20) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await pool.query(
    `SELECT id, scenario_id, category_code, scenario_name, status, candidate_count,
            changed_count, unchanged_count, skipped_count, error_count, created_at, applied_at
     FROM repricing_batches
     ORDER BY id DESC
     LIMIT $1`,
    [normalizedLimit]
  );

  return result.rows.map((batch) => ({
    ...batch,
    id: Number(batch.id),
    scenario_id: batch.scenario_id === null ? null : Number(batch.scenario_id),
    candidate_count: Number(batch.candidate_count || 0),
    changed_count: Number(batch.changed_count || 0),
    unchanged_count: Number(batch.unchanged_count || 0),
    skipped_count: Number(batch.skipped_count || 0),
    error_count: Number(batch.error_count || 0),
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
    `SELECT sku, old_price_uah, new_price_uah, price_delta_uah
     FROM repricing_items
     WHERE batch_id = $1
     ORDER BY id`,
    [Number(batchId)]
  );

  return { batch: batchResult.rows[0], items: itemsResult.rows };
}

module.exports = {
  applyRepricing,
  buildRepricingPreview,
  getPreviewToken,
  getRepricingBatchItems,
  getRepricingBatches,
  getRepricingScenarios,
  hasManualPrice,
};
