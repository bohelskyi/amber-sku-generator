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

function normalizeManualOverrides(manualOverrides = []) {
  if (!Array.isArray(manualOverrides)) {
    const error = new Error('Некоректний список ручних цін.');
    error.statusCode = 400;
    throw error;
  }
  if (manualOverrides.length > 10000) {
    const error = new Error('Забагато ручних цін в одному запиті.');
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];
  const productIds = new Set();
  for (const override of manualOverrides) {
    const productId = Number(override?.productId);
    const rawPrice = String(override?.newPriceUah ?? '').trim().replace(',', '.');
    const parsedPrice = Number(rawPrice);
    const newPriceUah = roundUah(parsedPrice);
    if (!Number.isInteger(productId) || productId <= 0 || newPriceUah === null || newPriceUah <= 0) {
      const error = new Error('Ручна ціна повинна бути додатним числом, а товар має бути коректним.');
      error.statusCode = 422;
      throw error;
    }
    if (productIds.has(productId)) {
      const error = new Error(`Ручну ціну для товару ${productId} передано більше одного разу.`);
      error.statusCode = 422;
      throw error;
    }
    productIds.add(productId);
    normalized.push({ productId, newPriceUah });
  }

  return normalized.sort((first, second) => first.productId - second.productId);
}

function getApplicationToken(previewToken, manualOverrides = []) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  if (normalizedOverrides.length === 0) return previewToken;
  const payload = {
    previewToken,
    manualOverrides: normalizedOverrides,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function applyManualOverridesToPreview(preview, manualOverrides = []) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const overridesByProductId = new Map(
    normalizedOverrides.map((override) => [override.productId, override.newPriceUah])
  );
  const itemsByProductId = new Map(
    preview.items.map((item) => [Number(item.productId), item])
  );

  for (const override of normalizedOverrides) {
    const item = itemsByProductId.get(override.productId);
    if (!item) {
      const error = new Error(`Товар ${override.productId} не належить до цього перегляду переоцінки.`);
      error.statusCode = 422;
      throw error;
    }
    if (item.status === 'error') {
      const error = new Error(`Для товару ${item.sku} спочатку потрібно усунути помилку розрахунку.`);
      error.statusCode = 422;
      throw error;
    }
  }

  const items = preview.items.map((item) => {
    if (!overridesByProductId.has(Number(item.productId))) return item;

    const newPriceUah = overridesByProductId.get(Number(item.productId));
    const oldPriceUah = item.oldPriceUah === null ? null : Number(item.oldPriceUah);
    const uahRate = Number(item.uahRate || 0);
    const weight = Number(item.weight || 0);
    const totalPrice = uahRate > 0
      ? Number((newPriceUah / uahRate).toFixed(2))
      : item.totalPrice;
    const pricePerGram = uahRate > 0 && weight > 0
      ? Number((newPriceUah / uahRate / weight).toFixed(2))
      : item.pricePerGram;
    const isChanged = oldPriceUah === null || oldPriceUah !== newPriceUah;

    return {
      ...item,
      calculatedPriceUah: item.newPriceUah,
      newPriceUah,
      priceDeltaUah: newPriceUah - Number(oldPriceUah || 0),
      totalPrice,
      pricePerGram,
      status: isChanged ? 'changed' : 'unchanged',
      manualOverride: true,
    };
  });

  return {
    ...preview,
    summary: {
      ...preview.summary,
      changedCount: items.filter((item) => item.status === 'changed').length,
      unchangedCount: items.filter((item) => item.status === 'unchanged').length,
      errorCount: items.filter((item) => item.status === 'error').length,
    },
    items,
  };
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
    autoPriceUah: String(item.calculatedPriceUah ?? item.newPriceUah),
    pricingScenario: item.pricingDetails?.scenario || null,
    repricing: {
      batchId,
      scenarioId: item.pricingDetails?.scenario?.id || null,
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah,
      calculatedPriceUah: item.calculatedPriceUah ?? item.newPriceUah,
      manualOverride: Boolean(item.manualOverride),
      appliedAt,
    },
  };
}

async function getBatchByPreviewToken(previewToken, client = pool) {
  const result = await client.query(
    `SELECT id, scenario_id, category_code, scenario_name, candidate_count, changed_count,
            unchanged_count, skipped_count, error_count, status, created_at, applied_at,
            rolled_back_at
     FROM repricing_batches
     WHERE preview_token = $1 AND status = 'completed'
     LIMIT 1`,
    [previewToken]
  );
  return result.rows[0] || null;
}

async function applyRepricing({ scenarioId, previewToken, manualOverrides = [] }) {
  if (!previewToken) {
    const error = new Error('Спочатку сформуйте попередній перегляд.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const applicationToken = getApplicationToken(previewToken, normalizedOverrides);
  const existingBatch = await getBatchByPreviewToken(applicationToken);
  if (existingBatch) return { success: true, alreadyApplied: true, batch: existingBatch };

  const basePreview = await buildRepricingPreview(scenarioId);
  if (basePreview.previewToken !== previewToken) {
    const error = new Error('Дані або ціни змінилися. Сформуйте попередній перегляд повторно.');
    error.statusCode = 409;
    throw error;
  }
  const preview = applyManualOverridesToPreview(basePreview, normalizedOverrides);
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
       ON CONFLICT (preview_token) WHERE status = 'completed' DO NOTHING
       RETURNING id, applied_at`,
      [
        preview.scenario.id,
        preview.scenario.categoryCode,
        preview.scenario.name,
        JSON.stringify(preview.scenario),
        applicationToken,
        preview.summary.candidateCount,
        preview.summary.changedCount,
        preview.summary.unchangedCount,
        preview.summary.skippedCount,
        preview.summary.errorCount,
      ]
    );

    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const batch = await getBatchByPreviewToken(applicationToken);
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
    `SELECT b.id, b.scenario_id, b.category_code, b.scenario_name, b.status,
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
                    OR p.total_price_uah IS DISTINCT FROM ri.new_price_uah
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
    scenario_id: batch.scenario_id === null ? null : Number(batch.scenario_id),
    candidate_count: Number(batch.candidate_count || 0),
    changed_count: Number(batch.changed_count || 0),
    unchanged_count: Number(batch.unchanged_count || 0),
    skipped_count: Number(batch.skipped_count || 0),
    error_count: Number(batch.error_count || 0),
    can_rollback: Boolean(batch.can_rollback),
  }));
}

function areNullableNumbersEqual(first, second, tolerance = 0.01) {
  if (first === null || first === undefined) return second === null || second === undefined;
  if (second === null || second === undefined) return false;
  return Math.abs(Number(first) - Number(second)) <= tolerance;
}

function doesProductMatchRepricingBatch(product, newPayload, batchId) {
  return (
    String(product.status || 'active') === 'active'
    && Number(product.details?.repricing?.batchId || 0) === Number(batchId)
    && areNullableNumbersEqual(product.total_price, newPayload.totalPrice)
    && areNullableNumbersEqual(product.total_price_uah, newPayload.totalPriceUah)
    && areNullableNumbersEqual(product.price_per_gram, newPayload.pricePerGram)
    && areNullableNumbersEqual(product.uah_rate, newPayload.uahRate)
  );
}

async function rollbackRepricing(batchId) {
  const normalizedBatchId = Number(batchId);
  if (!Number.isInteger(normalizedBatchId) || normalizedBatchId <= 0) {
    const error = new Error('Некоректна партія переоцінки.');
    error.statusCode = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchResult = await client.query(
      `SELECT id, scenario_id, category_code, scenario_name, status, changed_count,
              applied_at, rolled_back_at
       FROM repricing_batches
       WHERE id = $1
       FOR UPDATE`,
      [normalizedBatchId]
    );
    if (batchResult.rows.length === 0) {
      const error = new Error('Партію переоцінки не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    const batch = batchResult.rows[0];
    if (batch.status === 'rolled_back') {
      await client.query('COMMIT');
      return { success: true, alreadyRolledBack: true, batch };
    }
    if (batch.status !== 'completed') {
      const error = new Error('Цю партію не можна відкотити в її поточному статусі.');
      error.statusCode = 409;
      throw error;
    }

    const itemCountResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM repricing_items WHERE batch_id = $1',
      [normalizedBatchId]
    );
    const itemsResult = await client.query(
      `SELECT ri.product_id, ri.sku, ri.old_payload, ri.new_payload,
              p.id, p.total_price, p.total_price_uah, p.price_per_gram, p.uah_rate,
              p.details, p.status
       FROM repricing_items ri
       JOIN products p ON p.id = ri.product_id
       WHERE ri.batch_id = $1
       ORDER BY p.id
       FOR UPDATE OF p`,
      [normalizedBatchId]
    );
    if (itemsResult.rows.length !== Number(itemCountResult.rows[0].count)) {
      const error = new Error('Один або кілька товарів цієї переоцінки більше не існують.');
      error.statusCode = 409;
      throw error;
    }

    for (const item of itemsResult.rows) {
      const newPayload = item.new_payload || {};
      const stillMatchesBatch = doesProductMatchRepricingBatch(
        item,
        newPayload,
        normalizedBatchId
      );
      if (!stillMatchesBatch) {
        const error = new Error(
          `Товар ${item.sku} змінено після цієї переоцінки. Відкат зупинено без змін.`
        );
        error.statusCode = 409;
        throw error;
      }
    }

    for (const item of itemsResult.rows) {
      const oldPayload = item.old_payload || {};
      await client.query(
        `UPDATE products
         SET total_price = $1,
             total_price_uah = $2,
             price_per_gram = $3,
             uah_rate = $4,
             details = $5::jsonb
         WHERE id = $6`,
        [
          oldPayload.totalPrice ?? null,
          oldPayload.totalPriceUah ?? null,
          oldPayload.pricePerGram ?? null,
          oldPayload.uahRate ?? null,
          JSON.stringify(oldPayload.details || {}),
          Number(item.product_id),
        ]
      );
    }

    const rolledBackResult = await client.query(
      `UPDATE repricing_batches
       SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, scenario_id, category_code, scenario_name, status, changed_count,
                 applied_at, rolled_back_at`,
      [normalizedBatchId]
    );
    await client.query('COMMIT');
    return {
      success: true,
      alreadyRolledBack: false,
      batch: rolledBackResult.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    `SELECT sku, old_price_uah, new_price_uah, price_delta_uah,
            COALESCE((new_payload #>> '{details,repricing,manualOverride}')::boolean, FALSE)
              AS manual_override
     FROM repricing_items
     WHERE batch_id = $1
     ORDER BY id`,
    [Number(batchId)]
  );

  return { batch: batchResult.rows[0], items: itemsResult.rows };
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
  applyRepricing,
  buildRepricingPreview,
  getPreviewToken,
  getApplicationToken,
  getRepricingBatchItems,
  getRepricingRollbackItems,
  getRepricingBatches,
  getRepricingScenarios,
  hasManualPrice,
  normalizeManualOverrides,
  applyManualOverridesToPreview,
  rollbackRepricing,
  areNullableNumbersEqual,
  doesProductMatchRepricingBatch,
};
