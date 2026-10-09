const lifecycleGate = require('./full-product-cutover-gate');
const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { calculatePricing, loadPricingContext } = require('./pricing.service');
const { getPricingContextFingerprint, hashPayload } = require('./pricing/pricing-context-fingerprint');
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
  getCorrectionDecisionSignature,
  getProductPreviewToken,
  getProductStateSignature,
  getRecountStateSignature,
} = require('./product/product-signatures');
const {
  buildProductAnswerContext,
  getCorrectionWeight,
  getProductDetails,
  mergeRecountAnswerPatch,
  normalizeProductInputAnswers,
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
const { calculateDecisionPricing, normalizePricingDecision } = require('./product/correction-pricing-decision');
const fullExport = require('./full-product-export.service');
const { buildRecountEvidence, refreshRequired } = require('./product/recount-evidence');
const newReadiness = require('./product/new-product-readiness');
const { resolveProductLookup } = require('./product/public-identity');
const characteristics = require('./product/characteristic-config');
const { resolveProductWeight } = require('../utils/numbers');

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
    if (question.key === 'size' && question.input_type === 'text' && newReadiness.isKeychain(categoryCode, answers)) question.required = 0;
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
  return result.rows;
}

async function buildProductPreview(
  { categoryCode, answers = {}, weight, isCalibrated, skuSchemaVersionId, characteristicConfigHash },
  { queryable = pool, lockSequence = false, pricingDecision = null, rateObservation, previousAnswers } = {}
) {
  const normalizedCategoryCode = String(categoryCode || '').trim().toUpperCase();
  const activation = await queryable.query('SELECT enabled FROM public_sku_activation WHERE singleton');
  if (activation.rows[0]?.enabled) return buildNativeProductPreview({ categoryCode: normalizedCategoryCode, answers, weight, isCalibrated, characteristicConfigHash },
    { queryable, pricingDecision, rateObservation, previousAnswers, lockConfiguration: lockSequence });
  const configuration = await characteristics.readCharacteristicConfiguration(queryable, normalizedCategoryCode);
  const normalizedAnswers = normalizeProductInputAnswers(normalizedCategoryCode, answers, configuration.questions, { previousAnswers });
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
  const normalizedWeight = resolveProductWeight(weight, normalizedAnswers.weight);
  if (configuration.questions.some((q) => q.key === 'weight' && !q.archived) && normalizedWeight > 0) normalizedAnswers.weight = normalizedWeight;
  if (requiresWeight && (!Number.isFinite(normalizedWeight) || normalizedWeight <= 0)) {
    const error = validationError('Для цієї категорії вага повинна бути більшою за 0.');
    error.fieldErrors = { weight: error.message };
    throw error;
  }
  const nonSkuConfiguration = await validateNonSkuAnswers(
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
  const targetValidityFingerprint = hashPayload({
    categoryCode: normalizedCategoryCode,
    requiresWeight,
    skipHiddenSkuQuestions,
    legacySkuSeparator,
    schemaId: Number(schema.id),
    schemaHash: schema.config_hash,
    schemaQuestions: schema.questions,
    nonSkuConfiguration,
  });
  const usesCustomUsdBasis = pricingDecision?.mode === 'usd_per_gram';
  const pricingContext = usesCustomUsdBasis
    ? null : await loadPricingContext(normalizedCategoryCode, queryable);
  const pricingContextFingerprint = pricingContext
      && (!pricingDecision || pricingDecision.mode === 'system_auto')
    ? getPricingContextFingerprint(pricingContext) : null;
  const pricing = usesCustomUsdBasis
    ? await calculateDecisionPricing(pricingDecision, normalizedWeight, null, rateObservation)
    : await calculatePricing(
      normalizedCategoryCode,
      normalizedAnswers,
      normalizedWeight,
      isCalibrated,
      { queryable, context: pricingContext, rateObservation }
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
      normalizedAnswers,
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
      pricingContextFingerprint,
      targetValidityFingerprint,
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
    normalizedAnswers,
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
    pricingContextFingerprint,
    targetValidityFingerprint,
    ...currencyPayload,
  }, normalizedCategoryCode, normalizedAnswers, isCalibrated);
}

async function readReviewedCharacteristics(client, category, expectedHash) {
  const configuration = await characteristics.readCharacteristicConfiguration(client, category);
  if (configuration.config_hash !== expectedHash) throw Object.assign(new Error('Характеристики змінилися. Оновіть розрахунок.'), { statusCode: 409, publicCode: 'PRODUCT_PREVIEW_STALE' });
  return configuration;
}

async function buildNativeProductPreview({ categoryCode, answers, weight, isCalibrated, characteristicConfigHash },
  { queryable, pricingDecision, rateObservation, previousAnswers, lockConfiguration }) {
  if (lockConfiguration) {
    await queryable.query('SELECT code FROM categories WHERE code=$1 FOR SHARE', [categoryCode]);
    await queryable.query('SELECT id FROM questions WHERE category_code=$1 ORDER BY id FOR SHARE', [categoryCode]);
    await queryable.query('SELECT o.id FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1 ORDER BY o.id FOR SHARE OF o', [categoryCode]);
  }
  const configuration = await characteristics.readCharacteristicConfiguration(queryable, categoryCode);
  if (characteristicConfigHash && characteristicConfigHash !== configuration.config_hash) {
    throw Object.assign(new Error('Характеристики змінилися. Оновіть розрахунок.'), { statusCode: 409, publicCode: 'PRODUCT_PREVIEW_STALE' });
  }
  const normalizedAnswers = normalizeProductInputAnswers(categoryCode, answers, configuration.questions, { previousAnswers });
  const normalizedWeight = resolveProductWeight(weight, normalizedAnswers.weight);
  if (configuration.questions.some((q) => q.key === 'weight' && !q.archived) && normalizedWeight > 0) normalizedAnswers.weight = normalizedWeight;
  if (configuration.requires_weight === 1 && (!Number.isFinite(normalizedWeight) || normalizedWeight <= 0)) {
    const error = validationError('Для цієї категорії вага повинна бути більшою за 0.');
    error.fieldErrors = { weight: error.message };
    throw error;
  }
  for (const original of configuration.questions) {
    const question = { ...original };
    if (question.key === 'size' && newReadiness.isKeychain(categoryCode, normalizedAnswers)) question.required = 0;
    const value = normalizedAnswers[question.key];
    const provided = value !== undefined && value !== null && String(value).trim() !== '';
    const validation = inspectNonSkuAnswer(provided ? { ...question, required: 0, visible_if_json: null } : question,
      normalizedAnswers, isCalibrated, { previousAnswers });
    if (!validation.visible) continue;
    if (validation.issue) {
      const error = validationError(validation.issue === 'required'
        ? `Заповніть обов'язкове поле «${question.label}».`
        : `Значення недоступне для поля «${question.label}».`);
      error.fieldErrors = { [question.key]: error.message }; throw error;
    }
  }
  // Manual recount retains the automatic baseline in reviewed evidence. Initial
  // creation can accept an authorized manual price without a pricing matrix.
  const customPricing = pricingDecision && pricingDecision.mode !== 'system_auto'
    && !(pricingDecision.mode === 'manual_uah' && previousAnswers !== undefined);
  const context = customPricing ? null : await loadPricingContext(categoryCode, queryable);
  const pricing = customPricing
    ? await calculateDecisionPricing(pricingDecision, normalizedWeight, null, rateObservation)
    : await calculatePricing(categoryCode, normalizedAnswers, normalizedWeight, isCalibrated, { queryable, context, rateObservation });
  const result = { mode: 'public_identity', identityMode: 'public_identity',
    fullProposedSku: null, baseSku: null, nextSeq: null, internalSku: null,
    skuSchemaVersionId: null, skuSchemaVersion: null, skuSchemaMarker: null,
    characteristicConfigHash: configuration.config_hash, characteristicConfigVersion: 1,
    ...(pricingDecision ? { pricingDecision } : {}),
    ...(pricingDecision?.mode === 'manual_uah' ? { manualPriceUah: pricingDecision.manualPriceUah, autoPriceUah: null } : {}),
    normalizedAnswers, existsInDb: false,
    weightVal: pricing.weightVal, pricePerGram: Number(pricing.pricePerGram || 0).toFixed(2),
    fixedPriceUah: pricing.fixedPriceUah, priceMode: pricing.priceMode, usesWeight: pricing.usesWeight,
    totalPrice: pricing.totalPrice, logMessage: pricing.logMessage, pricingDetails: pricing.pricingDetails,
    pricingContextFingerprint: context && (!pricingDecision || pricingDecision.mode === 'system_auto')
      ? getPricingContextFingerprint(context) : null,
    targetValidityFingerprint: configuration.config_hash, ...pricing.currencyPayload };
  return finalizeProductPreview(result, categoryCode, normalizedAnswers, isCalibrated);
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

async function buildProductRecountPreview(payload, options = {}) {
  payload = { ...payload, ...(payload?.pricingDecision ? {
    pricingDecision: normalizePricingDecision(payload.pricingDecision),
  } : {}) };
  if (options.queryable) return buildRecountPreview(payload, options.queryable, options);
  const client = await (options.databasePool || pool).connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const preview = await buildRecountPreview(payload, client, options);
    await lifecycleGate.commit(client);
    return preview;
  } catch (error) {
    await lifecycleGate.rollback(client);
    throw error;
  } finally { await lifecycleGate.release(client); client.release(); }
}

async function buildRecountPreview({
  sourceSku,
  answers = {},
  isCalibrated,
  weight,
  reason = '',
  manualPriceUah,
  pricingDecision = null,
  nameChange,
}, queryable, options) {
  const sourceDecoded = await decodeProductSku(sourceSku, queryable);
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
  const hasSubmittedWeight = weight !== undefined && weight !== null;
  const correctedWeight = hasSubmittedWeight ? resolveProductWeight(weight, Object.hasOwn(submittedAnswers, 'weight') ? submittedAnswers.weight : undefined) : sourceWeight;
  if (sourceDecoded.weightConflict && !hasSubmittedWeight) throw Object.assign(new Error('Історична вага має суперечливі значення. Вкажіть перевірену вагу.'), { statusCode: 422, code: 'WEIGHT_CONFLICT', fieldErrors: { weight: 'Вкажіть перевірену вагу.' } });
  if (hasSubmittedWeight && (Object.hasOwn(nextAnswers, 'weight') || categoryCode === 'SV')) nextAnswers.weight = correctedWeight;
  const changes = getAnswerChanges(previousAnswers, nextAnswers);
  if (correctedWeight !== sourceWeight) {
    changes.push({ key: 'weight', from: sourceWeight, to: correctedWeight });
  }
  if (changes.length === 0 && nameChange === undefined) {
    const err = new Error('Для переобліку змініть хоча б один параметр виробу.');
    err.statusCode = 422;
    throw err;
  }

  const publicSkuActivation = await queryable.query('SELECT enabled FROM public_sku_activation WHERE singleton');
  const nativeMode = publicSkuActivation.rows[0]?.enabled;
  const activeSchema = nativeMode ? null : await getActiveSchema(categoryCode, queryable);
  const currentQuestions = activeSchema?.questions
    || (await characteristics.readCharacteristicConfiguration(queryable, categoryCode)).questions;
  const correctedAnswers = omitHiddenRecountAnswers(nextAnswers, currentQuestions, nextIsCalibrated);
  const correctedPreview = await buildProductPreview({
    categoryCode,
    answers: correctedAnswers,
    weight: correctedWeight,
    isCalibrated: nextIsCalibrated,
    skuSchemaVersionId: activeSchema?.id,
  }, { pricingDecision, queryable, rateObservation: options.rateObservation, previousAnswers });
  Object.assign(correctedAnswers, correctedPreview.normalizedAnswers || {});
  const correctionSku = correctedPreview.mode === 'public_identity' ? { fullSku: null, variation: null }
    : await resolveCorrectionSku(correctedPreview.fullProposedSku, queryable);
  const correctedPublicSku = publicSkuActivation.rows[0]?.enabled
    ? sourceDecoded.publicSku
    : correctionSku.fullSku;
  const previewCalculatedPriceUah = toUahNumber(correctedPreview.calculatedPriceUah);
  const previewAutoPriceUah = toUahNumber(correctedPreview.totalPriceUah);
  const previewManualPrice = pricingDecision?.mode === 'manual_uah'
    ? pricingDecision.manualPriceUah : parseManualPriceUah(manualPriceUah);
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

  const result = {
    source: {
      sku: sourceDecoded.sku,
      internalSku: sourceDecoded.internalSku,
      publicSku: sourceDecoded.publicSku,
      productId: sourceDecoded.product.id,
      answers: previousAnswers,
      decodedAnswers: sourceDecoded.decodedAnswers,
      totalPrice: Number.isFinite(oldPriceUsd) ? oldPriceUsd : null,
      totalPriceUah: oldPriceUah,
      pricePerGram: sourceDecoded.pricing?.pricePerGram ?? sourceDecoded.product.price_per_gram,
      pricePerGramUah: sourceDecoded.pricing?.pricePerGramUah ?? null,
      weight: sourceWeight,
      pricing: sourceDecoded.pricing || null,
      nameEvidence: { ua: sourceDecoded.product.magento_name_subject_ua ?? null,
        en: sourceDecoded.product.magento_name_subject_en ?? null,
        reviewRequired: Boolean(sourceDecoded.product.magento_name_review_required) },
      stateSignature: getRecountStateSignature(sourceDecoded.product),
    },
    corrected: {
      categoryCode,
      characteristicConfigHash: correctedPreview.characteristicConfigHash ?? null,
      characteristicConfigVersion: correctedPreview.characteristicConfigVersion ?? null,
      skuSchemaVersionId: correctedPreview.skuSchemaVersionId,
      skuSchemaVersion: correctedPreview.skuSchemaVersion,
      skuSchemaMarker: correctedPreview.skuSchemaMarker,
      answers: correctedAnswers,
      fullSku: correctionSku.fullSku,
      internalSku: correctionSku.fullSku,
      publicSku: correctedPublicSku,
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
      pricingContextFingerprint: correctedPreview.pricingContextFingerprint,
      targetValidityFingerprint: correctedPreview.targetValidityFingerprint,
      manualPriceUah: previewManualPrice,
      ...(pricingDecision ? { pricingDecision } : {}),
      uahRateDate: correctedPreview.uahRateDate ?? null,
    },
    changes,
    priceDeltaUah: newPriceUah > 0 ? newPriceUah - oldPriceUah : null,
    priceDeltaUsd: hasUsdDelta
      ? Number((newPriceUsd - oldPriceUsd).toFixed(4))
      : null,
    reason: String(reason || '').trim(),
  };
  const evidence = await buildRecountEvidence(queryable, sourceDecoded.product, result.corrected,
    sourceDecoded.decodedAnswers, { lock: options.lockLifecycle === true, nameChange, nameConfig: options.magentoConfig });
  if (changes.length === 0 && !evidence.exactNames?.changed) throw validationError('Для переобліку змініть хоча б один параметр виробу або назву.');
  result.source.exactNames = evidence.exactNames?.source ?? null;
  result.corrected.exactNames = evidence.exactNames?.next ?? null;
  result.nameChanges = evidence.exactNames?.changed ? { from: evidence.exactNames.source, to: evidence.exactNames.next } : null;
  result.source.stateSignature = evidence.signature;
  result.corrected.recountEvidence = evidence.binding;
  result.corrected.nameInheritance = evidence.names;
  result.corrected.delivery = evidence.delivery;
  if (pricingDecision) result.previewToken = getCorrectionDecisionSignature(result, pricingDecision);
  return result;
}

async function applyProductRecount(payload, options = {}) {
  if (payload?.nameChange !== undefined && options.authorizedNameChange !== true) {
    throw Object.assign(new Error('Немає дозволу змінювати назву.'), { statusCode: 403 });
  }
  if (payload?.pricingDecision && options.trustedCorrectionDecision !== true
      && options.authorizedDirectDecision !== true) {
    const error = new Error('Немає дозволу застосувати рішення про ціну.');
    error.statusCode = 403;
    throw error;
  }
  payload = { ...payload, ...(payload?.pricingDecision ? {
    pricingDecision: normalizePricingDecision(payload.pricingDecision),
  } : {}) };
  const mutationContext = createMutationContext(options.mutationContext);
  const preview = await buildProductRecountPreview(payload || {}, { databasePool: options.databasePool, magentoConfig: options.magentoConfig, rateObservation: options.rateObservation });
  if (payload.pricingDecision && !payload.correctionRequestId
      && payload.previewToken !== preview.previewToken) {
    throw Object.assign(new Error('Ціна або характеристики змінилися. Перегляньте переоблік ще раз.'),
      { statusCode: 409, publicCode: 'RECOUNT_PREVIEW_STALE' });
  }
  if (!payload.sourceStateSignature || payload.sourceStateSignature !== preview.source.stateSignature) {
    throw Object.assign(new Error('Товар або успадковані назви змінилися. Оновіть preview переобліку.'),
      { statusCode: 409, publicCode: 'RECOUNT_PREVIEW_STALE' });
  }
  const client = await (options.databasePool || pool).connect();

  try {
    if (payload.nameChange !== undefined) {
      const access = require('./access-admin-transaction'); const createError = require('./magento/binding-contract').error;
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
      await access.assertActorStillAuthorized(client, mutationContext.actorUserId, 'products.recount', createError);
      await lifecycleGate.enterExisting(client);
    } else if (options.batchReview) await require('./correction-request-batch-receipts').begin(client, options, 'corrections.complete');
    else {
      await client.query('BEGIN');
      const access = require('./access-admin-transaction');
      // Inherited gallery authorization shares the same fence as role changes.
      // Acquire it before lifecycle/product locks, including ordinary recounts.
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
      await lifecycleGate.enterExisting(client);
    }

    const recountNameContext = await require('./product/effective-name-readiness').current(client,
      { ...(options.magentoConfig ? { config: options.magentoConfig } : {}), lock: true });
    const sourceProductId = Number(preview.source.productId);
    const sourceLockResult = await client.query(
      `SELECT p.id, p.full_sku, p.category, p.weight, p.total_price, p.total_price_uah,
              price_per_gram, uah_rate, details, status, corrected_to_product_id,
              sku_schema_version_id, corrected_from_product_id, exclude_from_export, magento_name_subject_ua,
              magento_name_subject_en, magento_name_review_required, magento_name_override,
              p.characteristic_version_id, p.public_product_identity_id, i.public_sku
       FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
       WHERE p.id = $1
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
    if (getRecountStateSignature(lockedSource) !== preview.corrected.recountEvidence.sourceState) {
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
      characteristicConfigHash: preview.corrected.characteristicConfigHash,
    }, { queryable: client, lockSequence: true, pricingDecision: payload.pricingDecision || null, rateObservation: options.rateObservation, previousAnswers: preview.source.answers });
    const correctionCalculatedPriceUah = toUahNumber(freshPreview.calculatedPriceUah);
    const correctionAutoPriceUah = toUahNumber(freshPreview.totalPriceUah);
    const correctionManualPriceUah = payload.pricingDecision?.mode === 'manual_uah'
      ? payload.pricingDecision.manualPriceUah : parseManualPriceUah(payload.manualPriceUah);
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
    const authoritativeCorrected = {
      ...preview.corrected,
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
      pricingContextFingerprint: freshPreview.pricingContextFingerprint,
      targetValidityFingerprint: freshPreview.targetValidityFingerprint,
      manualPriceUah: correctionManualPriceUah,
      ...(payload.pricingDecision ? { pricingDecision: payload.pricingDecision } : {}),
      uahRateDate: freshPreview.uahRateDate ?? null,
    };
    const authoritativePreview = {
      ...preview,
      source: {
        ...preview.source,
        stateSignature: preview.source.stateSignature,
      },
      corrected: authoritativeCorrected,
    };
    if (payload.pricingDecision && !payload.correctionRequestId
        && getCorrectionDecisionSignature(authoritativePreview, payload.pricingDecision) !== payload.previewToken) {
      throw Object.assign(new Error('Ціна або характеристики змінилися. Перегляньте переоблік ще раз.'),
        { statusCode: 409, publicCode: 'RECOUNT_PREVIEW_STALE' });
    }
    if (payload.correctionRequestId
        && getCorrectionDecisionSignature(authoritativePreview, payload.pricingDecision)
          !== payload.correctionRequestSignature) {
      const error = new Error('Ціна або конфігурація виправлення змінилася. Оновіть запит.');
      error.statusCode = 409;
      throw error;
    }
    preview.corrected = authoritativeCorrected;
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

    if (preview.corrected.mode !== 'public_identity') await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [preview.corrected.proposedFullSku]);
    const correctionSku = preview.corrected.mode === 'public_identity' ? { fullSku: null, variation: null }
      : await resolveCorrectionSku(preview.corrected.proposedFullSku, client);
    const publicSkuActivation = await client.query(
      'SELECT enabled FROM public_sku_activation WHERE singleton'
    );
    const corrected = {
      ...preview.corrected,
      fullSku: correctionSku.fullSku,
      internalSku: correctionSku.fullSku,
      publicSku: publicSkuActivation.rows[0]?.enabled
        ? lockedSource.public_sku
        : correctionSku.fullSku,
      variation: correctionSku.variation,
    };
    // Preserve product -> SKU -> request -> lifecycle order. Finalization below
    // retains its full conditional ownership/signature/epoch check.
    if (payload.correctionRequestId) {
      await client.query('SELECT id FROM correction_requests WHERE id=$1 FOR UPDATE',
        [Number(payload.correctionRequestId)]);
    }
    const evidence = await buildRecountEvidence(client, lockedSource, corrected,
      preview.source.decodedAnswers, { lock: true, nameChange: payload.nameChange, nameConfig: options.magentoConfig });
    if (evidence.signature !== payload.sourceStateSignature) throw refreshRequired();
    const inheritedNames = evidence.names;
    corrected.nameInheritance = inheritedNames;
    corrected.recountEvidence = evidence.binding;
    corrected.delivery = evidence.delivery;
    corrected.exactNames = evidence.exactNames?.next ?? null;
    if (options.batchReview) {
      await require('./correction-request-batch-receipts').guard(client, options.batchReview);
      require('./correction-request-batch-evidence').assertReviewedResult(
        options.batchReview.entry, { source: preview.source, corrected }, options.rateObservation
      );
    }
    const characteristicVersion = corrected.mode === 'public_identity'
      ? await characteristics.persistCharacteristicConfiguration(client, await readReviewedCharacteristics(client, corrected.categoryCode, corrected.characteristicConfigHash)) : null;
    const details = {
      ...(characteristicVersion ? { characteristicConfigHash: corrected.characteristicConfigHash, characteristicConfigVersion: String(characteristicVersion.version) } : {}),
      answers: corrected.answers,
      isCalibrated: corrected.answers.is_calibrated ?? null,
      logMessage: corrected.logMessage,
      pricingScenario: corrected.pricingDetails?.scenario || null,
      calculatedPriceUah: corrected.calculatedPriceUah ?? null,
      autoPriceUah: corrected.autoPriceUah ?? null,
      manualPriceUah: corrected.manualPriceUah ?? null,
      ...(payload.pricingDecision?.mode === 'usd_per_gram' ? {
        customUsdPerGramBasis: {
          usdPerGram: payload.pricingDecision.usdPerGram,
          marketingRoundingEnabled: payload.pricingDecision.marketingRoundingEnabled,
          ...(payload.correctionRequestId ? { correctionRequestId: Number(payload.correctionRequestId) } : {}),
        },
      } : {}),
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
      ...(corrected.mode !== 'public_identity' ? { baseGeneratedSku: corrected.proposedFullSku,
        skuSchemaVersion: corrected.skuSchemaVersion, variationNumber: corrected.variation?.variationNumber || null } : {}),
    };

    const insertResult = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
        price_per_gram, uah_rate, details, status, exclude_from_export, corrected_from_product_id,
        correction_reason, sku_schema_version_id, created_by_user_id,
        magento_name_subject_ua, magento_name_subject_en, magento_name_review_required, magento_name_override, characteristic_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'active', 1, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
       RETURNING id, public_product_identity_id`,
      [
        corrected.fullSku,
        corrected.baseSku,
        corrected.mode === 'public_identity' ? null : Number(corrected.nextSeq || 0),
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
        corrected.skuSchemaVersionId ? Number(corrected.skuSchemaVersionId) : null,
        mutationContext.actorUserId,
        inheritedNames.ua, inheritedNames.en, inheritedNames.reviewRequired,
        evidence.exactNames?.override ? JSON.stringify(evidence.exactNames.override) : null,
        characteristicVersion?.id ?? null,
      ]
    );
    const correctedProductId = Number(insertResult.rows[0].id);
    const insertedPublicIdentity = await client.query(
      'SELECT public_sku FROM public_product_identities WHERE id = $1',
      [insertResult.rows[0].public_product_identity_id]
    );
    corrected.publicSku = insertedPublicIdentity.rows[0].public_sku;

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
        corrected.fullSku || corrected.publicSku,
        JSON.stringify(preview.source),
        JSON.stringify(corrected),
        preview.reason || null,
        Number(preview.priceDeltaUah || 0),
        mutationContext.actorUserId,
      ]
    );
    const productCorrectionId = Number(correctionResult.rows[0].id);

    let completedRequest = null;
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
          corrected.fullSku || corrected.publicSku,
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
      completedRequest = requestResult.rows[0];
    }

    await fullExport.initializeRecountSuccessor(client, lockedSource, correctedProductId, productCorrectionId, evidence.disposition);
    if (recountNameContext) await require('./product/effective-name-readiness').completeCreated(client,
      recountNameContext, correctedProductId, evidence.exactNames?.next, mutationContext.actorUserId);
    await require('./product-photos.service').inheritRecountPhotos(
      client, sourceProductId, correctedProductId, mutationContext,
      { requiredPermission: completedRequest ? 'corrections.complete' : 'products.recount' }
    );
    if (completedRequest) {
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'correction_request.completed',
        subjectType: 'correction_request',
        subjectId: payload.correctionRequestId,
        details: {
          claimVersion: Number(payload.correctionRequestClaimVersion),
          nextClaimVersion: Number(completedRequest.claim_version),
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
        publicSku: lockedSource.public_sku,
        correctedProductId,
        correctedSku: corrected.fullSku,
        productCorrectionId,
        ...(payload.correctionRequestId
          ? { correctionRequestId: Number(payload.correctionRequestId) }
          : {}),
      },
    });

    if (options.batchReview) await require('./correction-request-batch-receipts').record(
      client, options, 'completed', { correctedProductId, productCorrectionId, publicSku: corrected.publicSku,
        internalSku: corrected.fullSku, delivery: corrected.delivery }
    );
    await lifecycleGate.commit(client);

    return {
      success: true,
      correctedProductId,
      ...preview,
      corrected,
    };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw normalizeSkuWriteError(err, preview.corrected.fullSku);
  } finally {
    await require('./correction-request-batch-receipts').release(client); client.release();
  }
}

async function buildNewProductPreview(payload, options = {}) {
  const tests = require('./product/test-products');
  const isTestProduct = tests.normalizeFlag(payload);
  if (isTestProduct) {
    await tests.assertAdministrator(options.queryable || pool, Number(options.mutationContext?.actorUserId), { readOnly: !options.lockSequence });
    if (!(await (options.queryable || pool).query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0]?.enabled) {
      throw Object.assign(new Error('TEST товари потребують активної публічної ідентичності.'), { statusCode: 409, code: 'TEST_PRODUCT_NATIVE_REQUIRED' });
    }
    await tests.assertNamespaceAvailable(options.queryable || pool);
  }
  const category = String(payload.categoryCode || '').trim().toUpperCase();
  payload = { ...payload, answers: { ...(payload.answers || {}) } };
  const namePolicy = require('./product/effective-name-readiness');
  const nameContext = await namePolicy.current(options.queryable || pool, { ...(options.creationDeliveryConfig ? { config: options.creationDeliveryConfig } : {}), lock: Boolean(options.lockSequence) });
  const names = nameContext ? null : newReadiness.subjects(category, payload);
  if (!nameContext && payload.magentoNames !== undefined) throw Object.assign(new Error('Повні назви потребують перевіреної опублікованої версії правил.'), { statusCode: 409, code: 'PRODUCT_NAMES_POLICY_REQUIRED' });
  let creationDecision = null;
  if (payload.pricingDecision !== undefined) {
    const decision = { ...payload.pricingDecision };
    if (decision.mode === 'manual_uah' && decision.marketingRoundingEnabled === false) delete decision.marketingRoundingEnabled;
    creationDecision = normalizePricingDecision(decision);
  }
  const preview = await buildProductPreview(payload, { ...options, ...(creationDecision ? { pricingDecision: creationDecision } : {}) });
  if (isTestProduct && preview.mode !== 'public_identity') throw Object.assign(new Error('TEST товари потребують активної публічної ідентичності.'), { statusCode: 409, code: 'TEST_PRODUCT_NATIVE_REQUIRED' });
  preview.isTestProduct = isTestProduct;
  if (isTestProduct) preview.testTargetStatus = 2;
  preview.previewToken = getProductPreviewToken(preview, category, preview.normalizedAnswers || payload.answers, payload.isCalibrated);
  if (preview.mode === 'public_identity') preview.creationDeliveryReadiness = await require('./product/creation-delivery-readiness')
      .readCreationIntegrationReadiness(options.queryable || pool, category, preview,
      options.creationDeliveryConfig ? { config: options.creationDeliveryConfig } : {});
  if (creationDecision && preview.mode !== 'public_identity') throw validationError('Рішення про початкову ціну доступне для товарів із публічною ідентичністю.');
  if (payload.photoIds !== undefined) {
    preview.creationPhotos = require('./product-photos.service').normalizeCreationPhotos(payload);
    preview.previewToken = getProductPreviewToken(preview, category, preview.normalizedAnswers || payload.answers, payload.isCalibrated);
  }
  if (nameContext) {
    const evaluated = await namePolicy.prospective(options.queryable || pool, nameContext, payload, preview);
    const result = { ...preview, creationNames: { ...evaluated, ...nameContext.metadata },
      newProductInput: { version: 2, ...nameContext.metadata, fullNames: evaluated.manualNames } };
    result.previewToken = getProductPreviewToken(result, category, preview.normalizedAnswers || payload.answers, payload.isCalibrated);
    return result;
  }
  if (!names) return preview;
  await newReadiness.validate({ category, full_sku: preview.fullProposedSku,
    total_price_uah: preview.totalPriceUah, weight: preview.weightVal,
    details: { answers: preview.normalizedAnswers || payload.answers },
    magento_name_subject_ua: names.ua, magento_name_subject_en: names.en }, options.queryable || pool, { allowMissingPrice: true, pendingPublicIdentity: preview.mode === 'public_identity' });
  const result = { ...preview, newProductInput: { version: 1, names } };
  result.previewToken = getProductPreviewToken(result, category, preview.normalizedAnswers || payload.answers, payload.isCalibrated);
  return result;
}

async function saveProduct(payload, options = {}) {
  const tests = require('./product/test-products');
  const isTestProduct = tests.normalizeFlag(payload);
  const receipts = require('./product/product-creation-receipts');
  const attempt = receipts.normalizeCreationAttempt(payload);
  if (attempt) payload = JSON.parse(JSON.stringify(payload));
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  let fullSku = '';
  let authorityHeld = false;
  let nativeAttempt = null;

  try {
    if (attempt || isTestProduct) { await receipts.lockAuthority(client); authorityHeld = true; }
    await lifecycleGate.begin(client, 'BEGIN');
    if (isTestProduct) {
      await tests.assertAdministrator(client, mutationContext.actorUserId);
      await tests.assertNamespaceAvailable(client);
    }
    if (attempt && (await client.query('SELECT enabled FROM public_sku_activation WHERE singleton FOR SHARE')).rows[0]?.enabled) {
      nativeAttempt = attempt;
      const recovered = await receipts.recover(client, nativeAttempt, mutationContext.actorUserId);
      if (recovered) { await lifecycleGate.commit(client); return recovered; }
    }
    if (!payload.skuSchemaVersionId && !payload.characteristicConfigHash) {
      throw validationError('Для збереження потрібен skuSchemaVersionId із актуального preview.');
    }
    const activeSchema = payload.skuSchemaVersionId || payload.characteristicConfigHash
      ? null
      : await getActiveSchema(payload.category, client);
    const schemaVersionId = Number(payload.skuSchemaVersionId || activeSchema?.id);
    if (!schemaVersionId && !payload.characteristicConfigHash) {
      const err = new Error('Не вдалося визначити версію SKU-схеми для товару.');
      err.statusCode = 422;
      throw err;
    }
    const categoryCode = String(payload.category || payload.categoryCode || '').trim().toUpperCase();
    const answers = { ...(payload.answers || payload.details?.answers || {}) };
    const isCalibrated = payload.isCalibrated
      ?? payload.details?.isCalibrated
      ?? answers.is_calibrated
      ?? null;
    const preview = await buildNewProductPreview({
      categoryCode,
      isTestProduct,
      answers,
      weight: payload.weight,
      isCalibrated,
      skuSchemaVersionId: payload.skuSchemaVersionId,
      characteristicConfigHash: payload.characteristicConfigHash,
      ...(payload.photoIds !== undefined ? { photoIds: payload.photoIds, enableWhenPhotosVerified: payload.enableWhenPhotosVerified } : {}),
      ...(payload.pricingDecision !== undefined ? { pricingDecision: payload.pricingDecision } : {}),
      ...(payload.magentoNames !== undefined ? { magentoNames: payload.magentoNames } : {}),
      magento_name_subject_ua: payload.magento_name_subject_ua,
      magento_name_subject_en: payload.magento_name_subject_en,
    }, { queryable: client, lockSequence: true, mutationContext, ...(options.creationDeliveryConfig ? { creationDeliveryConfig: options.creationDeliveryConfig } : {}) });

    if (preview.mode === 'public_identity' && String(payload.characteristicConfigHash || '') !== preview.characteristicConfigHash) {
      throw Object.assign(new Error('Оновіть preview характеристик перед збереженням.'), { statusCode: 409 });
    }
    if (!payload.previewToken) {
      throw validationError('Для збереження потрібен previewToken з актуального preview.');
    }
    if (String(payload.previewToken) !== preview.previewToken) {
      const error = new Error('Ціна або параметри змінилися після preview. Оновіть preview перед збереженням.');
      error.statusCode = 409;
      throw error;
    }

    fullSku = preview.fullProposedSku;
    Object.assign(answers, preview.normalizedAnswers || {});
    if (preview.mode !== 'public_identity' && (payload.useVariation || payload.details?.variationNumber)) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sku-variation:${preview.fullProposedSku}`,
      ]);
      fullSku = (await getNextVariationSku(preview.fullProposedSku, client)).fullSku;
    }

    const manualPriceRaw = preview.pricingDecision
      ? preview.pricingDecision.mode === 'manual_uah' ? preview.pricingDecision.manualPriceUah : null
      : payload.manualPriceUah ?? payload.details?.manualPriceUah;
    const manualPriceUah = parseManualPriceUah(manualPriceRaw);
    const calculatedPriceUah = toUahNumber(preview.calculatedPriceUah);
    const autoPriceUah = preview.pricingDecision?.mode === 'manual_uah' ? null : toUahNumber(preview.totalPriceUah);
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
    const characteristicVersion = preview.mode === 'public_identity'
      ? await characteristics.persistCharacteristicConfiguration(client, await readReviewedCharacteristics(client, categoryCode, preview.characteristicConfigHash)) : null;
    const details = {
      ...(characteristicVersion ? { characteristicConfigHash: preview.characteristicConfigHash, characteristicConfigVersion: String(characteristicVersion.version) } : {}),
      answers,
      isCalibrated,
      logMessage: preview.logMessage,
      pricingScenario: preview.pricingDetails?.scenario || null,
      ...(preview.mode !== 'public_identity' ? { variationNumber: fullSku === preview.fullProposedSku ? null : Number(fullSku.slice(-3)),
        baseGeneratedSku: preview.fullProposedSku, skuSchemaVersion: preview.skuSchemaVersion } : {}),
      manualPriceUah,
      autoPriceUah,
      calculatedPriceUah,
      ...(preview.pricingDecision ? { creationPricingDecision: preview.pricingDecision } : {}),
      ...(preview.pricingDecision?.mode === 'usd_per_gram' ? { customUsdPerGramBasis: {
        usdPerGram: preview.pricingDecision.usdPerGram,
        marketingRoundingEnabled: preview.pricingDecision.marketingRoundingEnabled } } : {}),
      rateMetadata: {
        source: preview.uahRateSource || null,
        date: preview.uahRateDate || null,
        fetchedAt: preview.uahRateFetchedAt || null,
        stale: Boolean(preview.uahRateStale),
      },
    };
    const effectiveNames = preview.newProductInput?.version === 2;
    if (effectiveNames && !preview.creationNames?.ready) throw Object.assign(new Error('Потрібні повні українська та англійська назви товару.'), { statusCode: 422, code: 'PRODUCT_NAMES_REQUIRED' });
    const names = preview.newProductInput?.names;
    if (!effectiveNames) await newReadiness.validate({ category: categoryCode, full_sku: fullSku, weight, total_price_uah: totalPriceUah,
      details, magento_name_subject_ua: names?.ua, magento_name_subject_en: names?.en }, client, { pendingPublicIdentity: preview.mode === 'public_identity' });
    if (preview.mode !== 'public_identity') await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sku:${fullSku}`]);
    if (isTestProduct) {
      await client.query("SELECT set_config('amber.create_test_product','on',TRUE), set_config('amber.create_test_product_actor',$1,TRUE)", [String(mutationContext.actorUserId)]);
    }
    const result = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
        price_per_gram, uah_rate, details, sku_schema_version_id, created_by_user_id,
        magento_name_subject_ua, magento_name_subject_en, characteristic_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
       RETURNING id, public_product_identity_id`,
      [
        fullSku,
        preview.baseSku,
        preview.mode === 'public_identity' ? null : Number(preview.nextSeq),
        categoryCode,
        weight,
        Number(totalPrice || 0),
        totalPriceUah,
        pricePerGram,
        Number.isFinite(uahRate) && uahRate > 0 ? uahRate : null,
        JSON.stringify(details),
        preview.skuSchemaVersionId ? Number(preview.skuSchemaVersionId) : null,
        mutationContext.actorUserId,
        names?.ua ?? null,
        names?.en ?? null,
        characteristicVersion?.id ?? null,
      ]
    );
    const productId = Number(result.rows[0].id);
    const publicSku = (await client.query(
      'SELECT public_sku FROM public_product_identities WHERE id=$1',
      [result.rows[0].public_product_identity_id]
    )).rows[0].public_sku;
    await fullExport.initializeNewProduct(client, productId);
    if (effectiveNames) {
      const policy = require('./product/effective-name-readiness');
      const context = await policy.current(client, { ...(options.creationDeliveryConfig ? { config: options.creationDeliveryConfig } : {}), lock: true });
      if (!context || context.metadata.bindingRevisionId !== preview.newProductInput.bindingRevisionId
        || context.metadata.definitionHash !== preview.newProductInput.definitionHash) throw Object.assign(new Error('Правила назв змінилися. Повторіть перевірку.'), { statusCode: 409, code: 'PRODUCT_NAMES_STALE' });
      await policy.completeCreated(client, context, productId, preview.newProductInput.fullNames, mutationContext.actorUserId);
    }
    if (preview.creationPhotos?.photoIds.length) await require('./product-photos.service').attachCreatedProduct(client, productId,
      preview.creationPhotos, mutationContext);
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.created',
      subjectType: 'product',
      subjectId: productId,
      details: {
        fullSku,
        publicSku,
        categoryCode,
        ...(isTestProduct ? { isTestProduct: true, testTargetStatus: 2 } : {}),
      },
    });
    const savedResult = { success: true, id: result.rows[0].id, fullSku,
      internalSku: fullSku, publicSku, isTestProduct, ...(isTestProduct ? { testTargetStatus: 2 } : {}),
      ...(preview.creationDeliveryReadiness ? { creationDeliveryReadiness: preview.creationDeliveryReadiness } : {}) };
    if (nativeAttempt) await receipts.record(client, nativeAttempt, mutationContext.actorUserId, savedResult);
    await lifecycleGate.commit(client);

    return savedResult;
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw normalizeSkuWriteError(err, fullSku);
  } finally {
    await lifecycleGate.release(client);
    if (authorityHeld) await receipts.releaseAuthority(client);
    client.release();
  }
}

async function deleteProductBySku(skuToDelete, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedSku = String(skuToDelete || '').trim().toUpperCase();
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    const resolved = await resolveProductLookup(client, normalizedSku);
    if (!resolved.product) {
      const err = new Error('РђСЂС‚РёРєСѓР» РЅРµ Р·РЅР°Р№РґРµРЅРѕ Р°Р±Рѕ РІР¶Рµ Р°СЂС…С–РІРѕРІР°РЅРѕ.');
      err.statusCode = 404;
      throw err;
    }
    const lockedProduct = (await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [resolved.product.id])).rows[0];
    const previousProduct = { ...resolved.product, ...lockedProduct };
    const [previousLifecycle] = await fullExport.readFullProductStates(client, [resolved.product.id], { lock: true });
    if (lockedProduct.status === 'archived') {
      const visibilityIntent = await require('./product-lifecycle.service').queueArchivedVisibility(client,
        { productId: lockedProduct.id, actorUserId: mutationContext.actorUserId, mutationContext, previousProduct, previousLifecycle });
      await lifecycleGate.commit(client);
      return { success: true, archivedCount: 0, visibilityIntent, message: `Артикул ${normalizedSku} вже в архіві.` };
    }
    const result = await client.query(
      `UPDATE products
       SET status = 'archived', exclude_from_export = 1, archived_by_user_id = $1
       WHERE id = $2 AND COALESCE(status, 'active') <> 'archived'
       RETURNING id`,
      [mutationContext.actorUserId, resolved.product.id]
    );
    if (result.rowCount === 0) {
      const err = new Error('Артикул не знайдено або вже архівовано.');
      err.statusCode = 404;
      throw err;
    }
    const productId = Number(result.rows[0].id);
    await fullExport.retireFullProduct(client, productId);
    const visibilityIntent = await require('./product-lifecycle.service').queueArchivedVisibility(client,
      { productId, actorUserId: mutationContext.actorUserId, mutationContext, previousProduct, previousLifecycle });
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product.archived',
      subjectType: 'product',
      subjectId: productId,
      details: { fullSku: resolved.product.full_sku, publicSku: resolved.product.public_sku },
    });
    await lifecycleGate.commit(client);

    return {
      success: true,
      archivedCount: result.rowCount,
      visibilityIntent,
      message: `Артикул ${normalizedSku} перенесено в архів.`,
    };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

async function getRecentProducts() {
  return queryRecentProducts(pool);
}

module.exports = {
  decodeSku,
  getNextVariationSku,
  buildProductPreview,
  buildNewProductPreview,
  buildProductRecountPreview,
  applyProductRecount,
  saveProduct,
  deleteProductBySku,
  getRecentProducts,
  getProductBySku,
  getProductStateSignature,
  getProductPreviewToken,
};
