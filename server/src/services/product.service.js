const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { calculatePricing } = require('./pricing.service');
const { getAnswerChanges } = require('../utils/answer-changes');
const { toUahNumber } = require('../utils/money');
const {
  appendSkuSuffix,
  buildBaseSku,
  getOptionCode,
  parseVariationSku,
} = require('../utils/sku');
const {
  getActiveSchema,
  getSchemaVersionById,
} = require('./sku-schema.service');
const {
  getProductPreviewToken,
  getProductStateSignature,
} = require('./product/product-signatures');
const {
  buildProductAnswerContext,
  getCorrectionWeight,
  getProductDetails,
  mergeRecountAnswerPatch,
  normalizeAnswerMap,
  omitHiddenRecountAnswers,
} = require('./product/product-answers');
const {
  inspectNonSkuAnswer,
  inspectSkuAnswer,
} = require('./product/product-validation');
const {
  getProductBySku: queryProductBySku,
  getRecentProducts: queryRecentProducts,
} = require('./product/product-queries');
const { decodeSku: decodeProductSku } = require('./product/product-decode');

function normalizeSkuWriteError(err, sku) {
  if (err?.code !== '23505') return err;

  err.statusCode = 409;
  err.message = `Артикул ${sku} вже існує або був зарезервований. Оновіть розрахунок і спробуйте ще раз.`;
  return err;
}

async function decodeSku(skuValue) {
  return decodeProductSku(skuValue, pool);
}

async function getNextVariationSku(skuValue, queryable = pool) {
  const { baseFullSku } = parseVariationSku(skuValue);
  if (!baseFullSku) {
    throw new Error('Потрібен базовий артикул');
  }

  const result = await queryable.query(
    'SELECT full_sku FROM sku_registry WHERE full_sku = $1 OR full_sku LIKE $2',
    [baseFullSku, `${baseFullSku}-%`]
  );

  let maxVariationNumber = 0;
  for (const row of result.rows) {
    const match = String(row.full_sku).match(
      new RegExp(`^${baseFullSku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\-(\\d{3})$`)
    );
    if (!match) continue;
    maxVariationNumber = Math.max(maxVariationNumber, Number(match[1]));
  }

  const nextVariationNumber = maxVariationNumber + 1;
  if (nextVariationNumber > 999) {
    throw new Error('Досягнуто ліміт варіацій для цього артикула');
  }

  return {
    baseFullSku,
    variationNumber: nextVariationNumber,
    fullSku: `${baseFullSku}-${String(nextVariationNumber).padStart(3, '0')}`,
  };
}

async function getProductBySku(fullSku) {
  return queryProductBySku(pool, fullSku);
}

async function isSkuReserved(fullSku, queryable = pool) {
  const result = await queryable.query(
    'SELECT 1 FROM sku_registry WHERE full_sku = $1 LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );
  return result.rows.length > 0;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

function parseManualPriceUah(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw validationError('Ручна ціна повинна бути числом, більшим за 0.');
  }
  const parsed = toUahNumber(typeof value === 'string' ? value.trim().replace(',', '.') : value);
  if (parsed === null || parsed <= 0) {
    throw validationError('Ручна ціна повинна бути більшою за 0.');
  }
  return parsed;
}

function finalizeProductPreview(preview, categoryCode, answers, isCalibrated) {
  return {
    ...preview,
    previewToken: getProductPreviewToken(preview, categoryCode, answers, isCalibrated),
  };
}

async function validateNonSkuAnswers(categoryCode, answers, isCalibrated, queryable) {
  const result = await queryable.query(
    `SELECT q.id, q.key, q.label, q.required, q.input_type, q.visible_if_json,
            o.value_id, o.visible_if_json AS option_visible_if,
            o.hidden_if_json AS option_hidden_if, o.archived
     FROM questions q
     LEFT JOIN options o ON o.question_id = q.id
     WHERE q.category_code = $1 AND COALESCE(q.include_in_sku, 1) = 0
     ORDER BY q.id, o.id`,
    [categoryCode]
  );
  const questions = new Map();
  for (const row of result.rows) {
    if (!questions.has(row.id)) {
      questions.set(row.id, {
        key: row.key,
        label: row.label,
        required: Number(row.required),
        input_type: row.input_type,
        visible_if_json: row.visible_if_json,
        options: [],
      });
    }
    if (row.value_id !== null) {
      questions.get(row.id).options.push({
        value_id: Number(row.value_id),
        visible_if_json: row.option_visible_if,
        hidden_if_json: row.option_hidden_if,
        archived: Boolean(row.archived),
      });
    }
  }

  for (const question of questions.values()) {
    const validation = inspectNonSkuAnswer(question, answers, isCalibrated);
    if (!validation.visible) continue;
    if (validation.issue === 'required') {
      throw validationError(`Заповніть обов'язкове поле «${question.label}».`);
    }
    if (validation.issue === 'unavailable') {
      throw validationError(
        `Значення «${validation.value}» недоступне для поля «${question.label}».`
      );
    }
  }
}

async function buildProductPreview(
  { categoryCode, answers = {}, weight, isCalibrated, skuSchemaVersionId },
  { queryable = pool, lockSequence = false } = {}
) {
  const normalizedCategoryCode = String(categoryCode || '').trim().toUpperCase();
  const normalizedAnswers = normalizeAnswerMap(answers);
  const categoryResult = await queryable.query(
    `SELECT requires_weight, COALESCE(sku_separator, '') AS legacy_sku_separator, skip_hidden_sku_questions
     FROM categories
     WHERE code = $1`,
    [normalizedCategoryCode]
  );
  const skipHiddenSkuQuestions =
    Number(categoryResult.rows[0]?.skip_hidden_sku_questions || 0) === 1;
  if (categoryResult.rows.length === 0) {
    const err = new Error(`Категорію ${categoryCode} не знайдено.`);
    err.statusCode = 404;
    throw err;
  }
  const schema = skuSchemaVersionId
    ? await getSchemaVersionById(skuSchemaVersionId, queryable)
    : await getActiveSchema(normalizedCategoryCode, queryable);
  if (!schema) {
    const err = new Error(`Для категорії ${categoryCode} немає активної SKU-схеми.`);
    err.statusCode = 422;
    throw err;
  }

  if (String(schema.category_code) !== normalizedCategoryCode) {
    throw validationError('SKU-схема не належить вибраній категорії.');
  }
  if (skuSchemaVersionId && schema.status !== 'active') {
    const error = validationError('SKU-схема вже не активна. Оновіть preview перед збереженням.');
    error.statusCode = 409;
    throw error;
  }

  const requiresWeight =
    Number(categoryResult.rows[0].requires_weight) === 1;
  const normalizedWeight = Number(weight);
  if (requiresWeight && (!Number.isFinite(normalizedWeight) || normalizedWeight <= 0)) {
    throw validationError('Для цієї категорії вага повинна бути більшою за 0.');
  }
  await validateNonSkuAnswers(
    normalizedCategoryCode,
    normalizedAnswers,
    isCalibrated,
    queryable
  );

  const answerCodes = [];
  const answerCodeParts = [];
  for (const question of schema.questions) {
    const validation = inspectSkuAnswer(question, normalizedAnswers, isCalibrated);
    if (
      skipHiddenSkuQuestions &&
      !validation.visible
    ) {
      continue;
    }

    const { issue, option, value } = validation;
    if (issue === 'required') {
      throw validationError(`Заповніть обов'язкове поле «${question.label}».`);
    }
    if (issue === 'unavailable') {
      throw validationError(`Значення «${value}» недоступне для поля «${question.label}».`);
    }
    if (issue === 'unknown') {
      const err = new Error(
        `Значення «${value}» не належить активній SKU-схемі питання «${question.label}».`
      );
      err.statusCode = 422;
      throw err;
    }
    const normalizedCode = option ? getOptionCode(option) : '0';
    answerCodes.push(normalizedCode);
    answerCodeParts.push({
      value: normalizedCode,
      sku_separator: question.sku_separator || '',
    });
  }

  const legacySkuSeparator = categoryResult.rows[0]?.legacy_sku_separator || '';
  const schemaPrefix = `${normalizedCategoryCode}${schema.marker}`;
  const baseSku = buildBaseSku(schemaPrefix, answerCodeParts);
  const compactBaseSku = buildBaseSku(schemaPrefix, answerCodes);
  const legacySeparatedBaseSku = buildBaseSku(schemaPrefix, answerCodes, legacySkuSeparator);
  const pricing = await calculatePricing(
    normalizedCategoryCode,
    normalizedAnswers,
    normalizedWeight,
    isCalibrated,
    { queryable }
  );
  const {
    weightVal,
    pricePerGram,
    fixedPriceUah,
    priceMode,
    usesWeight,
    totalPrice,
    logMessage,
    currencyPayload,
    pricingDetails,
  } = pricing;

  if (!requiresWeight) {
    const baseSkuCandidates = Array.from(
      new Set([baseSku, compactBaseSku, legacySeparatedBaseSku])
    );
    if (lockSequence) {
      await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sku-sequence:${baseSku}`,
      ]);
    }
    const sequenceResult = await queryable.query(
      `SELECT sequence_number, full_sku
       FROM products
       WHERE base_sku = ANY($1::text[])
       ORDER BY sequence_number DESC
       LIMIT 1`,
      [baseSkuCandidates]
    );

    const lastSeq =
      sequenceResult.rows.length > 0 && sequenceResult.rows[0].sequence_number
        ? Number(sequenceResult.rows[0].sequence_number)
        : 0;
    const nextSeq = lastSeq + 1;
    const fullProposedSku = appendSkuSuffix(baseSku, nextSeq);
    const prevFullSku =
      lastSeq > 0 ? sequenceResult.rows[0].full_sku || appendSkuSuffix(baseSku, lastSeq) : 'Немає';

    return finalizeProductPreview({
      mode: 'sequence',
      skuSchemaVersionId: Number(schema.id),
      skuSchemaVersion: schema.version,
      skuSchemaMarker: schema.marker,
      baseSku,
      nextSeq,
      fullProposedSku,
      prevFullSku,
      pricePerGram: pricePerGram.toFixed(2),
      fixedPriceUah,
      priceMode,
      usesWeight,
      totalPrice,
      weightVal,
      logMessage,
      pricingDetails,
      ...currencyPayload,
    }, normalizedCategoryCode, normalizedAnswers, isCalibrated);
  }

  const weightInt = Math.round(weightVal);
  const fullProposedSku = appendSkuSuffix(baseSku, weightInt);
  const existingProduct = await queryable.query(
    'SELECT full_sku FROM sku_registry WHERE full_sku = ANY($1::text[]) LIMIT 1',
    [
      Array.from(
        new Set([
          fullProposedSku,
          appendSkuSuffix(compactBaseSku, weightInt),
          appendSkuSuffix(legacySeparatedBaseSku, weightInt),
        ])
      ),
    ]
  );

  return finalizeProductPreview({
    mode: 'weight',
    skuSchemaVersionId: Number(schema.id),
    skuSchemaVersion: schema.version,
    skuSchemaMarker: schema.marker,
    baseSku,
    nextSeq: weightInt,
    fullProposedSku,
    existsInDb: existingProduct.rows.length > 0,
    pricePerGram: pricePerGram.toFixed(2),
    fixedPriceUah,
    priceMode,
    usesWeight,
    totalPrice,
    weightVal,
    logMessage,
    pricingDetails,
    ...currencyPayload,
  }, normalizedCategoryCode, normalizedAnswers, isCalibrated);
}

async function resolveCorrectionSku(proposedFullSku, queryable = pool) {
  const reserved = await isSkuReserved(proposedFullSku, queryable);
  if (!reserved) {
    return {
      fullSku: proposedFullSku,
      variation: null,
    };
  }

  const variation = await getNextVariationSku(proposedFullSku, queryable);
  return {
    fullSku: variation.fullSku,
    variation,
  };
}

async function buildProductRecountPreview({
  sourceSku,
  answers = {},
  isCalibrated,
  weight,
  reason = '',
  manualPriceUah,
}) {
  const sourceDecoded = await decodeSku(sourceSku);
  if (!sourceDecoded.existsInDb || !sourceDecoded.product) {
    const err = new Error('Переоблік доступний тільки для артикула, який є в базі');
    err.statusCode = 404;
    throw err;
  }
  if (
    String(sourceDecoded.product.status || 'active') !== 'active'
    || sourceDecoded.product.corrected_to_product_id
  ) {
    const err = new Error('Цей товар уже не є активним або був переоблікований. Відкрийте актуальний артикул.');
    err.statusCode = 409;
    throw err;
  }

  const categoryCode = sourceDecoded.category.code;
  const previousAnswers = buildProductAnswerContext(sourceDecoded);
  const submittedAnswers = answers && typeof answers === 'object' ? answers : {};
  const nextAnswers = mergeRecountAnswerPatch(previousAnswers, submittedAnswers);
  const hasSubmittedCalibration = Object.hasOwn(submittedAnswers, 'is_calibrated');
  const nextIsCalibrated =
    isCalibrated !== undefined && isCalibrated !== null && isCalibrated !== ''
      ? Number(isCalibrated)
      : hasSubmittedCalibration
        ? nextAnswers.is_calibrated ?? null
        : nextAnswers.is_calibrated
          ?? getProductDetails(sourceDecoded.product).isCalibrated
          ?? null;
  if (nextIsCalibrated !== null && nextIsCalibrated !== undefined) {
    nextAnswers.is_calibrated = Number(nextIsCalibrated);
  } else {
    delete nextAnswers.is_calibrated;
  }

  const sourceWeight = getCorrectionWeight(sourceDecoded);
  const requiresWeight = Number(sourceDecoded.category.requires_weight) === 1;
  const hasSubmittedWeight = weight !== undefined && weight !== null;
  const correctedWeight = requiresWeight && hasSubmittedWeight ? Number(weight) : sourceWeight;
  const changes = getAnswerChanges(previousAnswers, nextAnswers);
  if (requiresWeight && correctedWeight !== sourceWeight) {
    changes.push({ key: 'weight', from: sourceWeight, to: correctedWeight });
  }
  if (changes.length === 0) {
    const err = new Error('Для переобліку змініть хоча б один параметр виробу.');
    err.statusCode = 422;
    throw err;
  }

  const activeSchema = await getActiveSchema(categoryCode);
  const correctedAnswers = activeSchema
    ? omitHiddenRecountAnswers(nextAnswers, activeSchema.questions, nextIsCalibrated)
    : nextAnswers;
  const correctedPreview = await buildProductPreview({
    categoryCode,
    answers: correctedAnswers,
    weight: correctedWeight,
    isCalibrated: nextIsCalibrated,
    skuSchemaVersionId: activeSchema?.id,
  });
  const correctionSku = await resolveCorrectionSku(correctedPreview.fullProposedSku);
  const previewCalculatedPriceUah = toUahNumber(correctedPreview.calculatedPriceUah);
  const previewAutoPriceUah = toUahNumber(correctedPreview.totalPriceUah);
  const previewManualPrice = parseManualPriceUah(manualPriceUah);
  if (previewManualPrice) {
    const previewRate = Number(correctedPreview.uahRate);
    correctedPreview.totalPriceUah = previewManualPrice;
    correctedPreview.totalPrice = Number.isFinite(previewRate) && previewRate > 0
      ? (previewManualPrice / previewRate).toFixed(2)
      : '0.00';
    if (correctedPreview.priceMode === 'per_gram_usd'
        && Number(correctedPreview.weightVal) > 0
        && Number.isFinite(previewRate)
        && previewRate > 0) {
      correctedPreview.pricePerGram = (
        previewManualPrice / previewRate / Number(correctedPreview.weightVal)
      ).toFixed(2);
    }
  }
  const oldPriceUah = toUahNumber(sourceDecoded.product.total_price_uah !== null &&
    sourceDecoded.product.total_price_uah !== undefined
      ? Number(sourceDecoded.product.total_price_uah)
      : Number(sourceDecoded.pricing?.totalPriceUah || 0)) || 0;
  const newPriceUah = toUahNumber(correctedPreview.totalPriceUah) || 0;
  const oldPriceUsd = Number(
    sourceDecoded.pricing?.totalPrice ?? sourceDecoded.product.total_price
  );
  const newPriceUsd = Number(correctedPreview.totalPrice);
  const hasUsdDelta = Number.isFinite(oldPriceUsd)
    && oldPriceUsd >= 0
    && Number.isFinite(newPriceUsd)
    && newPriceUsd > 0;

  return {
    source: {
      sku: sourceDecoded.sku,
      productId: sourceDecoded.product.id,
      answers: previousAnswers,
      decodedAnswers: sourceDecoded.decodedAnswers,
      totalPrice: Number.isFinite(oldPriceUsd) ? oldPriceUsd : null,
      totalPriceUah: oldPriceUah,
      pricePerGram: sourceDecoded.pricing?.pricePerGram ?? sourceDecoded.product.price_per_gram,
      pricePerGramUah: sourceDecoded.pricing?.pricePerGramUah ?? null,
      weight: sourceWeight,
      pricing: sourceDecoded.pricing || null,
      stateSignature: getProductStateSignature(sourceDecoded.product),
    },
    corrected: {
      categoryCode,
      skuSchemaVersionId: correctedPreview.skuSchemaVersionId,
      skuSchemaVersion: correctedPreview.skuSchemaVersion,
      skuSchemaMarker: correctedPreview.skuSchemaMarker,
      answers: correctedAnswers,
      fullSku: correctionSku.fullSku,
      proposedFullSku: correctedPreview.fullProposedSku,
      baseSku: correctedPreview.baseSku,
      nextSeq: correctedPreview.nextSeq,
      mode: correctedPreview.mode,
      variation: correctionSku.variation,
      weight: correctedWeight,
      pricePerGram: correctedPreview.pricePerGram,
      pricePerGramUah: correctedPreview.pricePerGramUah,
      fixedPriceUah: correctedPreview.fixedPriceUah,
      priceMode: correctedPreview.priceMode,
      usesWeight: correctedPreview.usesWeight,
      totalPrice: correctedPreview.totalPrice,
      totalPriceUah: correctedPreview.totalPriceUah,
      calculatedPriceUah: previewCalculatedPriceUah,
      autoPriceUah: previewAutoPriceUah,
      uahRate: correctedPreview.uahRate,
      logMessage: correctedPreview.logMessage,
      pricingDetails: correctedPreview.pricingDetails,
      manualPriceUah: previewManualPrice,
    },
    changes,
    priceDeltaUah: newPriceUah > 0 ? newPriceUah - oldPriceUah : null,
    priceDeltaUsd: hasUsdDelta
      ? Number((newPriceUsd - oldPriceUsd).toFixed(4))
      : null,
    reason: String(reason || '').trim(),
  };
}

async function applyProductRecount(payload, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const preview = await buildProductRecountPreview(payload || {});
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sourceProductId = Number(preview.source.productId);
    const sourceLockResult = await client.query(
      `SELECT id, full_sku, category, weight, total_price, total_price_uah,
              price_per_gram, uah_rate, details, status, corrected_to_product_id,
              sku_schema_version_id
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [sourceProductId]
    );
    if (sourceLockResult.rows.length === 0) {
      const err = new Error('Вихідний товар для переобліку більше не існує');
      err.statusCode = 404;
      throw err;
    }
    const lockedSource = sourceLockResult.rows[0];
    if (String(lockedSource.status || 'active') !== 'active'
        || lockedSource.corrected_to_product_id) {
      const err = new Error('Цей товар уже був переоблікований. Оновіть декодер і відкрийте актуальний артикул.');
      err.statusCode = 409;
      throw err;
    }
    if (getProductStateSignature(lockedSource) !== preview.source.stateSignature) {
      const err = new Error('Товар змінився після preview. Оновіть дані та повторіть виправлення.');
      err.statusCode = 409;
      throw err;
    }

    const freshPreview = await buildProductPreview({
      categoryCode: preview.corrected.categoryCode,
      answers: preview.corrected.answers,
      weight: preview.corrected.weight,
      isCalibrated: preview.corrected.answers.is_calibrated,
      skuSchemaVersionId: preview.corrected.skuSchemaVersionId,
    }, { queryable: client, lockSequence: true });
    const correctionCalculatedPriceUah = toUahNumber(freshPreview.calculatedPriceUah);
    const correctionAutoPriceUah = toUahNumber(freshPreview.totalPriceUah);
    const correctionManualPriceUah = parseManualPriceUah(payload.manualPriceUah);
    const correctionFinalPriceUah = correctionManualPriceUah
      || (correctionAutoPriceUah > 0 ? correctionAutoPriceUah : null);
    if (!correctionFinalPriceUah) {
      throw validationError(
        'Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.'
      );
    }
    if (correctionManualPriceUah) {
      const rate = Number(freshPreview.uahRate);
      freshPreview.totalPriceUah = correctionManualPriceUah;
      freshPreview.totalPrice = Number.isFinite(rate) && rate > 0
        ? (correctionManualPriceUah / rate).toFixed(2)
        : '0.00';
      if (freshPreview.priceMode === 'per_gram_usd'
          && Number(freshPreview.weightVal) > 0
          && Number.isFinite(rate)
          && rate > 0) {
        freshPreview.pricePerGram = (
          correctionManualPriceUah / rate / Number(freshPreview.weightVal)
        ).toFixed(2);
      }
    }
    Object.assign(preview.corrected, {
      skuSchemaVersionId: freshPreview.skuSchemaVersionId,
      skuSchemaVersion: freshPreview.skuSchemaVersion,
      skuSchemaMarker: freshPreview.skuSchemaMarker,
      proposedFullSku: freshPreview.fullProposedSku,
      baseSku: freshPreview.baseSku,
      nextSeq: freshPreview.nextSeq,
      mode: freshPreview.mode,
      pricePerGram: freshPreview.pricePerGram,
      pricePerGramUah: freshPreview.pricePerGramUah,
      fixedPriceUah: freshPreview.fixedPriceUah,
      priceMode: freshPreview.priceMode,
      usesWeight: freshPreview.usesWeight,
      totalPrice: freshPreview.totalPrice,
      totalPriceUah: freshPreview.totalPriceUah,
      calculatedPriceUah: correctionCalculatedPriceUah,
      autoPriceUah: correctionAutoPriceUah,
      uahRate: freshPreview.uahRate,
      logMessage: freshPreview.logMessage,
      pricingDetails: freshPreview.pricingDetails,
      manualPriceUah: correctionManualPriceUah,
    });
    preview.priceDeltaUah = correctionFinalPriceUah - Number(preview.source.totalPriceUah || 0);
    const freshPriceUsd = Number(freshPreview.totalPrice);
    const sourcePriceUsd = Number(preview.source.totalPrice);
    preview.priceDeltaUsd = Number.isFinite(freshPriceUsd)
      && freshPriceUsd > 0
      && Number.isFinite(sourcePriceUsd)
      && sourcePriceUsd >= 0
      ? Number((freshPriceUsd - sourcePriceUsd).toFixed(4))
      : null;

    if (!payload.correctionRequestId) {
      const activeRequestResult = await client.query(
        `SELECT id
         FROM correction_requests
         WHERE source_product_id = $1
           AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [sourceProductId]
      );
      if (activeRequestResult.rows.length > 0) {
        const err = new Error(
          `Для цього товару вже існує активний запит #${activeRequestResult.rows[0].id}. Завершіть його у черзі виправлень.`
        );
        err.statusCode = 409;
        throw err;
      }
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      preview.corrected.proposedFullSku,
    ]);
    const correctionSku = await resolveCorrectionSku(
      preview.corrected.proposedFullSku,
      client
    );
    const corrected = {
      ...preview.corrected,
      fullSku: correctionSku.fullSku,
      variation: correctionSku.variation,
    };
    const details = {
      answers: corrected.answers,
      isCalibrated: corrected.answers.is_calibrated ?? null,
      logMessage: corrected.logMessage,
      pricingScenario: corrected.pricingDetails?.scenario || null,
      calculatedPriceUah: corrected.calculatedPriceUah ?? null,
      autoPriceUah: corrected.autoPriceUah ?? null,
      manualPriceUah: corrected.manualPriceUah ?? null,
      rateMetadata: {
        source: freshPreview.uahRateSource || null,
        date: freshPreview.uahRateDate || null,
        fetchedAt: freshPreview.uahRateFetchedAt || null,
        stale: Boolean(freshPreview.uahRateStale),
      },
      correction: {
        sourceProductId,
        sourceSku: preview.source.sku,
        reason: preview.reason,
        changes: preview.changes,
      },
      baseGeneratedSku: corrected.proposedFullSku,
      skuSchemaVersion: corrected.skuSchemaVersion,
      variationNumber: corrected.variation?.variationNumber || null,
    };

    const insertResult = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
        price_per_gram, uah_rate, details, status, exclude_from_export, corrected_from_product_id,
        correction_reason, sku_schema_version_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'active', 1, $11, $12, $13, $14)
       RETURNING id`,
      [
        corrected.fullSku,
        corrected.baseSku,
        Number(corrected.nextSeq || 0),
        corrected.categoryCode,
        Number(corrected.weight || 0),
        Number(corrected.totalPrice || 0),
        toUahNumber(corrected.totalPriceUah),
        Number(corrected.pricePerGram || 0),
        corrected.uahRate !== undefined && corrected.uahRate !== null
          ? Number(corrected.uahRate)
          : null,
        JSON.stringify(details),
        sourceProductId,
        preview.reason || null,
        Number(corrected.skuSchemaVersionId),
        mutationContext.actorUserId,
      ]
    );
    const correctedProductId = Number(insertResult.rows[0].id);

    await client.query(
      `UPDATE products
       SET status = 'corrected',
           corrected_to_product_id = $1,
           exclude_from_export = 1,
           correction_reason = $2
       WHERE id = $3`,
      [correctedProductId, preview.reason || null, sourceProductId]
    );

    const correctionResult = await client.query(
      `INSERT INTO product_corrections
       (source_product_id, corrected_product_id, source_sku, corrected_sku, old_payload,
        new_payload, reason, price_delta_uah, performed_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        sourceProductId,
        correctedProductId,
        preview.source.sku,
        corrected.fullSku,
        JSON.stringify(preview.source),
        JSON.stringify(corrected),
        preview.reason || null,
        Number(preview.priceDeltaUah || 0),
        mutationContext.actorUserId,
      ]
    );
    const productCorrectionId = Number(correctionResult.rows[0].id);

    if (payload.correctionRequestId) {
      const requestResult = await client.query(
        `UPDATE correction_requests
         SET status = 'completed',
             corrected_product_id = $1,
             proposed_sku = $2,
             final_payload = $3::jsonb,
             claimed_by_user_id = NULL,
             claim_token_hash = NULL,
             claim_version = claim_version + 1,
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
            AND source_product_id = $5
            AND preview_signature = $6
            AND status = 'in_progress'
            AND claim_version = $7
            AND (
              claimed_by_user_id = $8
              OR (
                claimed_by_user_id IS NULL
                AND claim_token_hash = $9
              )
            )
         RETURNING id, claim_version`,
        [
          correctedProductId,
          corrected.fullSku,
          JSON.stringify(corrected),
          Number(payload.correctionRequestId),
          sourceProductId,
          String(payload.correctionRequestSignature || ''),
          Number(payload.correctionRequestClaimVersion),
          mutationContext.actorUserId,
          payload.correctionRequestLegacyClaimHash || null,
        ]
      );
      if (requestResult.rows.length === 0) {
        const err = new Error('Запит на виправлення змінив статус. Оновіть сторінку.');
        err.statusCode = 409;
        throw err;
      }
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'correction_request.completed',
        subjectType: 'correction_request',
        subjectId: payload.correctionRequestId,
        details: {
          claimVersion: Number(payload.correctionRequestClaimVersion),
          nextClaimVersion: Number(requestResult.rows[0].claim_version),
          sourceProductId,
          correctedProductId,
          productCorrectionId,
          ...(payload.correctionRequestLegacyAdopted
            ? { legacyClaimAdopted: true }
            : {}),
        },
      });
    }

    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.recounted',
      subjectType: 'product',
      subjectId: sourceProductId,
      details: {
        sourceSku: preview.source.sku,
        correctedProductId,
        correctedSku: corrected.fullSku,
        productCorrectionId,
        ...(payload.correctionRequestId
          ? { correctionRequestId: Number(payload.correctionRequestId) }
          : {}),
      },
    });

    await client.query('COMMIT');

    return {
      success: true,
      correctedProductId,
      ...preview,
      corrected,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw normalizeSkuWriteError(err, preview.corrected.fullSku);
  } finally {
    client.release();
  }
}

async function saveProduct(payload, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  let fullSku = '';

  try {
    await client.query('BEGIN');
    if (!payload.skuSchemaVersionId) {
      throw validationError('Для збереження потрібен skuSchemaVersionId із актуального preview.');
    }
    const activeSchema = payload.skuSchemaVersionId
      ? null
      : await getActiveSchema(payload.category, client);
    const schemaVersionId = Number(payload.skuSchemaVersionId || activeSchema?.id);
    if (!schemaVersionId) {
      const err = new Error('Не вдалося визначити версію SKU-схеми для товару.');
      err.statusCode = 422;
      throw err;
    }
    const categoryCode = String(payload.category || payload.categoryCode || '').trim().toUpperCase();
    const answers = normalizeAnswerMap(payload.answers || payload.details?.answers || {});
    const isCalibrated = payload.isCalibrated
      ?? payload.details?.isCalibrated
      ?? answers.is_calibrated
      ?? null;
    const preview = await buildProductPreview({
      categoryCode,
      answers,
      weight: payload.weight,
      isCalibrated,
      skuSchemaVersionId: payload.skuSchemaVersionId,
    }, { queryable: client, lockSequence: true });

    if (!payload.previewToken) {
      throw validationError('Для збереження потрібен previewToken з актуального preview.');
    }
    if (String(payload.previewToken) !== preview.previewToken) {
      const error = new Error('Ціна або параметри змінилися після preview. Оновіть preview перед збереженням.');
      error.statusCode = 409;
      throw error;
    }

    fullSku = preview.fullProposedSku;
    if (payload.useVariation || payload.details?.variationNumber) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sku-variation:${preview.fullProposedSku}`,
      ]);
      fullSku = (await getNextVariationSku(preview.fullProposedSku, client)).fullSku;
    }

    const manualPriceRaw = payload.manualPriceUah ?? payload.details?.manualPriceUah;
    const manualPriceUah = parseManualPriceUah(manualPriceRaw);
    const calculatedPriceUah = toUahNumber(preview.calculatedPriceUah);
    const autoPriceUah = toUahNumber(preview.totalPriceUah);
    const totalPriceUah = manualPriceUah || (autoPriceUah > 0 ? autoPriceUah : null);
    if (!totalPriceUah) {
      throw validationError(
        'Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.'
      );
    }

    const uahRate = Number(preview.uahRate);
    const weight = Number(preview.weightVal || payload.weight || 0);
    const totalPrice = manualPriceUah && Number.isFinite(uahRate) && uahRate > 0
      ? (manualPriceUah / uahRate).toFixed(2)
      : preview.totalPrice;
    const pricePerGram = manualPriceUah
      && preview.priceMode === 'per_gram_usd'
      && Number.isFinite(uahRate)
      && uahRate > 0
      && weight > 0
      ? manualPriceUah / uahRate / weight
      : Number(preview.pricePerGram || 0);
    const details = {
      answers,
      isCalibrated,
      logMessage: preview.logMessage,
      pricingScenario: preview.pricingDetails?.scenario || null,
      variationNumber: fullSku === preview.fullProposedSku ? null : Number(fullSku.slice(-3)),
      baseGeneratedSku: preview.fullProposedSku,
      skuSchemaVersion: preview.skuSchemaVersion,
      manualPriceUah,
      autoPriceUah,
      calculatedPriceUah,
      rateMetadata: {
        source: preview.uahRateSource || null,
        date: preview.uahRateDate || null,
        fetchedAt: preview.uahRateFetchedAt || null,
        stale: Boolean(preview.uahRateStale),
      },
    };
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sku:${fullSku}`]);
    const result = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
        price_per_gram, uah_rate, details, sku_schema_version_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING id`,
      [
        fullSku,
        preview.baseSku,
        Number(preview.nextSeq),
        categoryCode,
        weight,
        Number(totalPrice || 0),
        totalPriceUah,
        pricePerGram,
        Number.isFinite(uahRate) && uahRate > 0 ? uahRate : null,
        JSON.stringify(details),
        Number(preview.skuSchemaVersionId || schemaVersionId),
        mutationContext.actorUserId,
      ]
    );
    const productId = Number(result.rows[0].id);
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.created',
      subjectType: 'product',
      subjectId: productId,
      details: {
        fullSku,
        categoryCode,
      },
    });
    await client.query('COMMIT');

    return { success: true, id: result.rows[0].id, fullSku };
  } catch (err) {
    await client.query('ROLLBACK');
    throw normalizeSkuWriteError(err, fullSku);
  } finally {
    client.release();
  }
}

async function deleteProductBySku(skuToDelete, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedSku = String(skuToDelete || '').trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE products
       SET status = 'archived', exclude_from_export = 1, archived_by_user_id = $1
       WHERE full_sku = $2 AND COALESCE(status, 'active') <> 'archived'
       RETURNING id`,
      [mutationContext.actorUserId, normalizedSku]
    );
    if (result.rowCount === 0) {
      const err = new Error('Артикул не знайдено або вже архівовано.');
      err.statusCode = 404;
      throw err;
    }
    const productId = Number(result.rows[0].id);
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.archived',
      subjectType: 'product',
      subjectId: productId,
      details: { fullSku: normalizedSku },
    });
    await client.query('COMMIT');

    return {
      success: true,
      archivedCount: result.rowCount,
      message: `Артикул ${normalizedSku} перенесено в архів.`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getRecentProducts() {
  return queryRecentProducts(pool);
}

module.exports = {
  decodeSku,
  getNextVariationSku,
  buildProductPreview,
  buildProductRecountPreview,
  applyProductRecount,
  saveProduct,
  deleteProductBySku,
  getRecentProducts,
  getProductBySku,
  getProductStateSignature,
  getProductPreviewToken,
};
