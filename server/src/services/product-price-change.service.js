const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { calculatePricing, loadPricingContext } = require('./pricing.service');
const {
  getPricingContextFingerprint,
  hashPayload,
} = require('./pricing/pricing-context-fingerprint');
const {
  calculateDecisionPricing,
  normalizePricingDecision,
} = require('./product/correction-pricing-decision');
const { getProductStateSignature } = require('./product/product-signatures');
const {
  getPricingAnswers,
  getProductDetails,
} = require('./repricing/pricing-state');
const { roundAutomaticUah, toUahNumber } = require('../utils/money');

const PRODUCT_COLUMNS = `id, full_sku, category, weight, total_price, total_price_uah,
  price_per_gram, uah_rate, details, status, corrected_to_product_id,
  sku_schema_version_id`;

function commandError(message, statusCode = 422, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.publicCode = code;
  return error;
}

function normalizeProductId(value) {
  const productId = Number(value);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw commandError('Вкажіть чинний товар для зміни ціни.');
  }
  return productId;
}

function normalizePriceChangeDecision(input) {
  if (input?.mode === 'manual_uah') {
    const allowedKeys = ['mode', 'manualPriceUah', 'marketingRoundingEnabled'];
    if (Array.isArray(input)
        || Object.keys(input).some((key) => !allowedKeys.includes(key))
        || typeof input.marketingRoundingEnabled !== 'boolean') {
      throw commandError(
        'Явно виберіть маркетингове округлення для ручної ціни UAH.'
      );
    }
    return {
      ...normalizePricingDecision({
        mode: 'manual_uah',
        manualPriceUah: input.manualPriceUah,
      }),
      marketingRoundingEnabled: input.marketingRoundingEnabled,
    };
  }
  return normalizePricingDecision(input);
}

function assertActiveProduct(product) {
  if (!product) {
    throw commandError('Товар для зміни ціни більше не існує.', 404, 'PRODUCT_NOT_FOUND');
  }
  if (String(product.status || 'active') !== 'active'
      || product.corrected_to_product_id) {
    throw commandError(
      'Ціна може бути змінена лише для чинного активного товару.',
      409,
      'PRODUCT_NOT_ACTIVE'
    );
  }
}

function pricingEvidence({
  details,
  pricePerGram,
  totalPrice,
  totalPriceUah,
  uahRate,
}) {
  return {
    totalPrice: totalPrice === null ? null : Number(totalPrice),
    totalPriceUah: toUahNumber(totalPriceUah),
    pricePerGram: pricePerGram === null ? null : Number(pricePerGram),
    uahRate: uahRate === null ? null : Number(uahRate),
    calculatedPriceUah: toUahNumber(details.calculatedPriceUah),
    autoPriceUah: toUahNumber(details.autoPriceUah),
    manualPriceUah: toUahNumber(details.manualPriceUah),
    pricingScenario: details.pricingScenario ?? null,
    customUsdPerGramBasis: details.customUsdPerGramBasis ?? null,
    rateMetadata: details.rateMetadata ?? null,
  };
}

function currentPricingEvidence(product) {
  return pricingEvidence({
    details: getProductDetails(product),
    totalPrice: product.total_price,
    totalPriceUah: product.total_price_uah,
    pricePerGram: product.price_per_gram,
    uahRate: product.uah_rate,
  });
}

async function calculatePriceChange(product, decision, queryable) {
  const oldDetails = getProductDetails(product);
  const answers = getPricingAnswers(product, oldDetails);
  let pricing;
  let pricingContextFingerprint = null;

  if (decision.mode === 'manual_uah' || decision.mode === 'system_auto') {
    const context = await loadPricingContext(product.category, queryable);
    if (decision.mode === 'system_auto') {
      pricingContextFingerprint = getPricingContextFingerprint(context);
    }
    pricing = await calculatePricing(
      product.category,
      answers,
      product.weight,
      answers.is_calibrated ?? oldDetails.isCalibrated ?? null,
      { queryable, context }
    );
  } else {
    pricing = await calculateDecisionPricing(decision, product.weight);
  }

  const calculatedPriceUah = toUahNumber(pricing.currencyPayload.calculatedPriceUah);
  const autoPriceUah = toUahNumber(pricing.currencyPayload.totalPriceUah);
  const manualPriceUah = decision.mode === 'manual_uah'
    ? toUahNumber(decision.marketingRoundingEnabled
      ? roundAutomaticUah(decision.manualPriceUah)
      : decision.manualPriceUah)
    : null;
  const finalPriceUah = manualPriceUah ?? autoPriceUah;
  if (!(Number(finalPriceUah) > 0)) {
    if (decision.mode === 'system_auto') {
      throw commandError(
        'Автоматична ціна для цього товару зараз недоступна.',
        422,
        'AUTOMATIC_PRICE_UNAVAILABLE'
      );
    }
    throw commandError('Вибране цінове рішення не утворює додатну ціну UAH.');
  }

  let totalPrice = pricing.totalPrice;
  let pricePerGram = pricing.pricePerGram;
  if (decision.mode === 'manual_uah') {
    const rate = Number(pricing.currencyPayload.uahRate);
    totalPrice = Number.isFinite(rate) && rate > 0
      ? (manualPriceUah / rate).toFixed(2)
      : '0.00';
    if (pricing.priceMode === 'per_gram_usd'
        && Number(product.weight) > 0
        && Number.isFinite(rate)
        && rate > 0) {
      pricePerGram = (manualPriceUah / rate / Number(product.weight)).toFixed(2);
    }
  }

  const details = {
    ...oldDetails,
    logMessage: decision.mode === 'usd_per_gram'
      ? 'Захищена ціна USD/г' : pricing.logMessage,
    pricingScenario: pricing.pricingDetails?.scenario || null,
    calculatedPriceUah,
    autoPriceUah,
    manualPriceUah,
    rateMetadata: {
      source: pricing.currencyPayload.uahRateSource || null,
      date: pricing.currencyPayload.uahRateDate || null,
      fetchedAt: pricing.currencyPayload.uahRateFetchedAt || null,
      stale: Boolean(pricing.currencyPayload.uahRateStale),
    },
  };
  delete details.repricing;
  if (decision.mode === 'usd_per_gram') {
    details.customUsdPerGramBasis = {
      usdPerGram: decision.usdPerGram,
      marketingRoundingEnabled: decision.marketingRoundingEnabled,
      source: 'product_price_change',
    };
  } else {
    delete details.customUsdPerGramBasis;
  }

  return {
    totalPrice: Number(totalPrice),
    totalPriceUah: toUahNumber(finalPriceUah),
    pricePerGram: Number(pricePerGram),
    uahRate: pricing.currencyPayload.uahRate === null
      || pricing.currencyPayload.uahRate === undefined
      ? null : Number(pricing.currencyPayload.uahRate),
    details,
    pricingContextFingerprint,
    uahRateDate: pricing.currencyPayload.uahRateDate ?? null,
  };
}

function getPriceChangePreviewToken(product, decision, projected) {
  if (decision.mode === 'manual_uah') {
    return hashPayload({
      version: 2,
      productState: getProductStateSignature(product),
      decision,
      resultingPriceUah: projected.totalPriceUah,
    });
  }
  if (decision.mode === 'system_auto') {
    return hashPayload({
      version: 1,
      productState: getProductStateSignature(product),
      decision,
      pricingContextFingerprint: projected.pricingContextFingerprint,
      resultingPriceUah: projected.totalPriceUah,
      rate: projected.uahRate,
      uahRateDate: projected.uahRateDate,
    });
  }
  return hashPayload({
    version: 1,
    productState: getProductStateSignature(product),
    decision,
    rate: projected.uahRate,
    uahRateDate: projected.uahRateDate,
  });
}

function buildPreviewResponse(product, decision, projected) {
  const current = currentPricingEvidence(product);
  const next = pricingEvidence(projected);
  const currentPriceUah = toUahNumber(current.totalPriceUah) || 0;
  const resultingPriceUah = toUahNumber(next.totalPriceUah);
  return {
    productId: Number(product.id),
    sku: product.full_sku,
    pricingDecision: decision,
    currentPriceUah,
    resultingPriceUah,
    priceDifferenceUah: Number((resultingPriceUah - currentPriceUah).toFixed(2)),
    unchanged: resultingPriceUah === currentPriceUah,
    previewToken: getPriceChangePreviewToken(product, decision, projected),
  };
}

async function loadProduct(productId, queryable, { lock = false } = {}) {
  const result = await queryable.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products
     WHERE id = $1
     ${lock ? 'FOR UPDATE' : ''}`,
    [productId]
  );
  return result.rows[0] || null;
}

async function assertNoActiveCorrectionRequest(productId, queryable) {
  const result = await queryable.query(
    `SELECT id
     FROM correction_requests
     WHERE source_product_id = $1
       AND status IN ('pending', 'in_progress')
     LIMIT 1`,
    [productId]
  );
  if (result.rows.length > 0) {
    throw commandError(
      `Для цього товару вже існує активний запит #${result.rows[0].id}. Завершіть його у черзі виправлень.`,
      409,
      'ACTIVE_CORRECTION_REQUEST'
    );
  }
}

async function previewProductPriceChange(payload = {}, options = {}) {
  const queryable = options.queryable || pool;
  const productId = normalizeProductId(payload.productId);
  const decision = normalizePriceChangeDecision(payload.pricingDecision);
  const product = await loadProduct(productId, queryable);
  assertActiveProduct(product);
  await assertNoActiveCorrectionRequest(productId, queryable);
  const projected = await calculatePriceChange(product, decision, queryable);
  return buildPreviewResponse(product, decision, projected);
}

async function applyProductPriceChange(payload = {}, options = {}) {
  const productId = normalizeProductId(payload.productId);
  const decision = normalizePriceChangeDecision(payload.pricingDecision);
  if (!String(payload.previewToken || '').trim()) {
    throw commandError('Для зміни ціни потрібен актуальний previewToken.');
  }
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const product = await loadProduct(productId, client, { lock: true });
    assertActiveProduct(product);
    await assertNoActiveCorrectionRequest(productId, client);
    const projected = await calculatePriceChange(product, decision, client);
    const authoritativePreview = buildPreviewResponse(product, decision, projected);
    if (authoritativePreview.previewToken !== payload.previewToken) {
      throw commandError(
        'Товар або авторитетні дані ціни змінилися після preview. Оновіть розрахунок.',
        409,
        'STALE_PRODUCT_PRICE_PREVIEW'
      );
    }
    if (authoritativePreview.unchanged) {
      throw commandError(
        'Результуюча ціна UAH не відрізняється від поточної.',
        422,
        'PRODUCT_PRICE_UNCHANGED'
      );
    }

    const oldPrice = currentPricingEvidence(product);
    const newPrice = pricingEvidence(projected);
    const updateResult = await client.query(
      `UPDATE products
       SET total_price = $1,
           total_price_uah = $2,
           price_per_gram = $3,
           uah_rate = $4,
           details = $5::jsonb
       WHERE id = $6
         AND status = 'active'
         AND corrected_to_product_id IS NULL
       RETURNING id, full_sku`,
      [
        projected.totalPrice,
        projected.totalPriceUah,
        projected.pricePerGram,
        projected.uahRate,
        JSON.stringify(projected.details),
        productId,
      ]
    );
    if (updateResult.rows.length !== 1) {
      throw commandError(
        'Товар змінив стан під час зміни ціни.',
        409,
        'STALE_PRODUCT_PRICE_PREVIEW'
      );
    }

    const exportRevision = await client.query(
      `INSERT INTO product_export_revisions
         (product_id, revision, confirmed_revision, changed_at)
       VALUES ($1, 1, 0, CURRENT_TIMESTAMP)
       ON CONFLICT (product_id) DO UPDATE
       SET revision = product_export_revisions.revision + 1,
           changed_at = CURRENT_TIMESTAMP
       RETURNING revision`,
      [productId]
    );

    const audit = await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.price_changed',
      subjectType: 'product',
      subjectId: productId,
      details: {
        fullSku: product.full_sku,
        priceMode: decision.mode,
        pricingDecision: decision,
        oldPrice,
        newPrice,
        exportRevision: Number(exportRevision.rows[0].revision),
      },
    });
    await client.query('COMMIT');

    return {
      success: true,
      productId,
      sku: product.full_sku,
      pricingDecision: decision,
      currentPriceUah: authoritativePreview.currentPriceUah,
      resultingPriceUah: authoritativePreview.resultingPriceUah,
      priceDifferenceUah: authoritativePreview.priceDifferenceUah,
      auditEventId: Number(audit.id),
      occurredAt: audit.occurred_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  applyProductPriceChange,
  previewProductPriceChange,
};
