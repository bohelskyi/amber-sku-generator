const pool = require('../db/pool');
const { calculatePricing } = require('./pricing.service');
const { getAnswerChanges } = require('../utils/answer-changes');
const {
  resolveCalibrationState,
  shouldHidePriceForCalibration,
} = require('../utils/calibration');
const { roundUah } = require('../utils/money');
const {
  appendSkuSuffix,
  buildSkuSuffixDecodeAttempts,
  buildBaseSku,
  decodeSkuAnswers,
  decodeStoredSkuAnswers,
  decodeVisibleSkuAnswers,
  diagnoseSkuAttempts,
  parseVariationSku,
} = require('../utils/sku');
const { isRuleMatched } = require('../utils/rules');

async function getAllCategories() {
  const result = await pool.query(
    `SELECT code, name, requires_weight, skip_hidden_sku_questions
     FROM categories
     ORDER BY LENGTH(code) DESC, code ASC`
  );

  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    requires_weight: Number(row.requires_weight),
    skip_hidden_sku_questions: Number(row.skip_hidden_sku_questions || 0),
  }));
}

async function getQuestionsForCategory(categoryCode) {
  const result = await pool.query(
    `
      SELECT
        q.key,
        q.label AS q_label,
        q.sku_index,
        COALESCE(q.sku_separator, '') AS sku_separator,
        q.required,
        q.visible_if_json,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON q.id = o.question_id
      WHERE q.category_code = $1 AND COALESCE(q.include_in_sku, 1) = 1
      ORDER BY q.sku_index, LENGTH(CAST(o.value_id AS TEXT)) DESC, o.value_id ASC
    `,
    [categoryCode]
  );

  const questions = [];
  let currentQuestion = null;

  for (const row of result.rows) {
    if (!currentQuestion || currentQuestion.key !== row.key) {
      currentQuestion = {
        key: row.key,
        label: row.q_label,
        sku_index: Number(row.sku_index),
        sku_separator: row.sku_separator || '',
        required: Number(row.required),
        visible_if_json: row.visible_if_json || null,
        options: [],
      };
      questions.push(currentQuestion);
    }

    if (row.value_id !== null && row.value_id !== undefined) {
      currentQuestion.options.push({
        id: Number(row.value_id),
        label: row.o_label,
      });
    }
  }

  return questions;
}

async function getCalibrationQuestionForCategory(categoryCode) {
  const result = await pool.query(
    `SELECT visible_if_json
     FROM questions
     WHERE category_code = $1 AND key = 'is_calibrated'
     LIMIT 1`,
    [categoryCode]
  );

  return result.rows[0] || null;
}

function buildAnswerMap(decodedAnswers) {
  return decodedAnswers.reduce((answers, item) => {
    answers[item.key] = item.value_id === null ? 0 : item.value_id;
    return answers;
  }, {});
}

function haveSameDecodedAnswers(firstAnswers, secondAnswers) {
  if (!firstAnswers || !secondAnswers || firstAnswers.length !== secondAnswers.length) {
    return false;
  }

  const secondAnswerMap = buildAnswerMap(secondAnswers);
  return firstAnswers.every((answer) => (
    secondAnswerMap[answer.key] === (answer.value_id === null ? 0 : answer.value_id)
  ));
}

function normalizeAnswerMap(answers = {}) {
  return Object.entries(answers || {}).reduce((result, [key, value]) => {
    if (value === undefined || value === null || value === '') return result;
    const numericValue = Number(value);
    result[key] = Number.isNaN(numericValue) ? value : numericValue;
    return result;
  }, {});
}

function getProductDetails(product) {
  if (!product?.details || typeof product.details !== 'object') return {};
  return product.details;
}

function getStoredMatrixName(productDetails) {
  const structuredName = productDetails?.pricingScenario?.name;
  if (structuredName) return String(structuredName);

  const legacyLogMessage = String(productDetails?.logMessage || '');
  const detailsMarkerIndex = legacyLogMessage.indexOf(' (');
  return detailsMarkerIndex > 0 ? legacyLogMessage.slice(0, detailsMarkerIndex) : null;
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSkuWriteError(err, sku) {
  if (err?.code !== '23505') return err;

  err.statusCode = 409;
  err.message = `Артикул ${sku} вже існує або був зарезервований. Оновіть розрахунок і спробуйте ще раз.`;
  return err;
}

function getPricingConditionValue(key, pricingAnswers, pricingDetails) {
  if (key === 'is_calibrated') {
    return pricingAnswers.is_calibrated ?? pricingDetails?.calibratedValue ?? null;
  }

  return pricingAnswers[key] ?? null;
}

function getStoredAnswers(product) {
  const productDetails = getProductDetails(product);
  return productDetails.answers && typeof productDetails.answers === 'object'
    ? normalizeAnswerMap(productDetails.answers)
    : {};
}

function buildProductAnswerContext(decodedProduct) {
  const answers = {
    ...buildAnswerMap(decodedProduct.decodedAnswers || []),
    ...getStoredAnswers(decodedProduct.product),
  };

  const storedCalibrated = getProductDetails(decodedProduct.product).isCalibrated;
  if (
    answers.is_calibrated === undefined
    && storedCalibrated !== undefined
    && storedCalibrated !== null
    && storedCalibrated !== ''
  ) {
    answers.is_calibrated = Number(storedCalibrated);
  }

  return answers;
}

function getCorrectionWeight(decodedProduct) {
  const product = decodedProduct.product;
  if (product?.weight !== null && product?.weight !== undefined && Number(product.weight) > 0) {
    return Number(product.weight);
  }

  return decodedProduct.suffix?.type === 'weight' && decodedProduct.suffix.value !== null
    ? Number(decodedProduct.suffix.value)
    : 0;
}

function getDecodedPricingPayload({
  decodedAnswers,
  product,
  pricing,
  pricingAnswers,
  suffixValue,
}) {
  const productDetails = getProductDetails(product);
  const storedPricePerGram = product?.price_per_gram !== null && product?.price_per_gram !== undefined
    ? Number(product.price_per_gram)
    : null;
  const storedUahRate = product?.uah_rate !== null && product?.uah_rate !== undefined
    ? Number(product.uah_rate)
    : null;
  const storedWeight = product?.weight !== null && product?.weight !== undefined
    ? Number(product.weight)
    : null;
  const calculatedPricePerGram = Number(pricing.pricePerGram || 0);
  const pricePerGram = storedPricePerGram !== null ? storedPricePerGram : calculatedPricePerGram;
  const uahRate = storedUahRate ?? pricing.currencyPayload?.uahRate ?? null;
  const pricePerGramUah =
    Number(pricePerGram) > 0 && Number(uahRate) > 0
      ? (Number(pricePerGram) * Number(uahRate)).toFixed(2)
      : pricing.currencyPayload?.pricePerGramUah || null;
  const dependentKeys = pricing.pricingDetails?.dependentKeys || [];
  const matrixName =
    (storedPricePerGram !== null ? getStoredMatrixName(productDetails) : null)
    || pricing.pricingDetails?.scenario?.name
    || null;
  const shouldShowCalibratedCondition =
    dependentKeys.includes('is_calibrated') ||
    pricingAnswers.is_calibrated !== undefined ||
    productDetails.isCalibrated !== undefined;
  const conditionKeys = uniqueValues([
    ...dependentKeys,
    ...(shouldShowCalibratedCondition ? ['is_calibrated'] : []),
  ]);

  return {
    source: storedPricePerGram !== null ? 'stored' : 'calculated',
    isWeightBased: Boolean(pricing.pricingDetails?.isWeightBased),
    usesWeight: Boolean(pricing.pricingDetails?.usesWeight),
    priceMode: pricing.pricingDetails?.priceMode || pricing.priceMode || 'category_default',
    weight: storedWeight ?? pricing.weightVal ?? suffixValue ?? null,
    pricePerGram,
    pricePerGramUah,
    uahRate,
    totalPrice: product?.total_price ?? pricing.totalPrice,
    totalPriceUah: roundUah(
      product?.total_price_uah ?? pricing.currencyPayload?.totalPriceUah ?? null
    ),
    logMessage: productDetails.logMessage || pricing.logMessage,
    matrixName,
    dependentKeys,
    conditions: conditionKeys.map((key) => ({
      key,
      value: getPricingConditionValue(key, pricingAnswers, pricing.pricingDetails),
      isInSku: decodedAnswers.some((answer) => answer.key === key),
    })),
    details: pricing.pricingDetails || null,
    decodedPriceAnswers: decodedAnswers
      .filter((answer) => dependentKeys.includes(answer.key))
      .map((answer) => answer.key),
  };
}

async function decodeSku(skuValue) {
  const { normalizedSku, baseFullSku, variationNumber } = parseVariationSku(skuValue);
  if (!normalizedSku) {
    throw new Error('Введіть артикул для розшифровки');
  }

  const categories = await getAllCategories();
  const category = categories.find((item) => baseFullSku.startsWith(item.code));
  if (!category) {
    const err = new Error('Не вдалося визначити категорію за кодом артикула.');
    err.statusCode = 422;
    err.details = {
      type: 'unknown_category',
      received: baseFullSku.slice(0, 2) || normalizedSku,
      categories: categories.map((item) => ({ code: item.code, name: item.name })),
    };
    throw err;
  }

  const questions = await getQuestionsForCategory(category.code);
  const calibrationQuestion = await getCalibrationQuestionForCategory(category.code);
  const skuWithoutCategory = baseFullSku.slice(category.code.length);
  const attempts = buildSkuSuffixDecodeAttempts(skuWithoutCategory);
  const productResult = await pool.query(
    `SELECT id, full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export,
            corrected_from_product_id, corrected_to_product_id, correction_reason, created_at
     FROM products
     WHERE full_sku = $1
     ORDER BY id ASC
     LIMIT 1`,
    [normalizedSku]
  );
  const product = productResult.rows[0] || null;
  const productDetails = getProductDetails(product);
  const storedAnswers = getStoredAnswers(product);

  for (const attempt of attempts) {
    const configuredDecodedAnswers =
      Number(category.skip_hidden_sku_questions || 0) === 1
        ? decodeVisibleSkuAnswers(questions, attempt.encodedPart)
        : decodeSkuAnswers(questions, attempt.encodedPart);
    const storedDecodedAnswers = !product || !Object.keys(storedAnswers).length
      ? null
      : decodeStoredSkuAnswers(questions, attempt.encodedPart, storedAnswers);
    const usesStoredHistory = Boolean(
      storedDecodedAnswers
      && !haveSameDecodedAnswers(configuredDecodedAnswers, storedDecodedAnswers)
    );
    const decodedAnswers = usesStoredHistory
      ? storedDecodedAnswers
      : configuredDecodedAnswers || storedDecodedAnswers;
    if (!decodedAnswers) continue;

    const suffixValue =
      attempt.suffixRaw !== null && /^\d+$/.test(attempt.suffixRaw)
        ? Number(attempt.suffixRaw)
        : null;
    const decodedAnswerMap = buildAnswerMap(decodedAnswers);
    const pricingAnswers = {
      ...decodedAnswerMap,
      ...storedAnswers,
    };
    const calibration = resolveCalibrationState({
      question: calibrationQuestion,
      answers: pricingAnswers,
      storedValue: productDetails.isCalibrated,
    });
    const pricingWeight =
      product?.weight !== null && product?.weight !== undefined && Number(product.weight) > 0
        ? Number(product.weight)
        : category.requires_weight === 1
          ? suffixValue
          : 0;
    const calculatedPricing = await calculatePricing(
      category.code,
      pricingAnswers,
      pricingWeight,
      calibration.value
    );
    const pricing = shouldHidePriceForCalibration(
      calibration,
      calculatedPricing.pricingDetails?.dependentKeys || []
    )
      ? null
      : calculatedPricing;

    return {
      sku: normalizedSku,
      decodeSource: usesStoredHistory ? 'stored_history' : 'current_config',
      calibration,
      category: {
        code: category.code,
        name: category.name,
        requires_weight: category.requires_weight,
        skip_hidden_sku_questions: category.skip_hidden_sku_questions,
      },
      baseSku: category.code + attempt.encodedPart,
      decodedAnswers,
      suffix: {
        raw: attempt.suffixRaw,
        type: attempt.hasSuffix
          ? category.requires_weight === 1
            ? 'weight'
            : 'sequence'
          : 'none',
        value: suffixValue,
      },
      pricing: pricing
        ? getDecodedPricingPayload({
            decodedAnswers,
            product,
            pricing,
            pricingAnswers,
            suffixValue,
          })
        : null,
      variation:
        variationNumber !== null
          ? {
              number: variationNumber,
              suffix: `-${String(variationNumber).padStart(3, '0')}`,
            }
          : null,
      existsInDb: productResult.rows.length > 0,
      product,
    };
  }

  const diagnosis = diagnoseSkuAttempts(questions, attempts, {
    skipHiddenQuestions: Number(category.skip_hidden_sku_questions || 0) === 1,
  });
  const err = new Error(
    diagnosis?.message || 'Артикул не відповідає поточній конфігурації категорії.'
  );
  err.statusCode = 422;
  err.details = {
    type: 'sku_config_mismatch',
    category: { code: category.code, name: category.name },
    issue: diagnosis,
  };
  throw err;
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
  const result = await pool.query(
    'SELECT id, full_sku, created_at FROM products WHERE full_sku = $1 ORDER BY id ASC LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );

  return result.rows[0] || null;
}

async function isSkuReserved(fullSku, queryable = pool) {
  const result = await queryable.query(
    'SELECT 1 FROM sku_registry WHERE full_sku = $1 LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );
  return result.rows.length > 0;
}

function isQuestionVisibleForSku(question, answers, isCalibrated) {
  const calibratedAnswer =
    answers.is_calibrated !== undefined &&
    answers.is_calibrated !== null &&
    answers.is_calibrated !== ''
      ? answers.is_calibrated
      : isCalibrated;
  return isRuleMatched(question.visible_if_json, {
    ...answers,
    is_calibrated: calibratedAnswer,
  });
}

async function buildProductPreview({ categoryCode, answers = {}, weight, isCalibrated }) {
  const categoryResult = await pool.query(
    `SELECT requires_weight, COALESCE(sku_separator, '') AS legacy_sku_separator, skip_hidden_sku_questions
     FROM categories
     WHERE code = $1`,
    [categoryCode]
  );
  const skipHiddenSkuQuestions =
    Number(categoryResult.rows[0]?.skip_hidden_sku_questions || 0) === 1;

  const questionRows = await pool.query(
    `SELECT key, sku_index, COALESCE(sku_separator, '') AS sku_separator, visible_if_json
     FROM questions
     WHERE category_code = $1 AND COALESCE(include_in_sku, 1) = 1
     ORDER BY sku_index ASC`,
    [categoryCode]
  );

  const answerCodes = [];
  const answerCodeParts = [];
  for (const question of questionRows.rows) {
    if (
      skipHiddenSkuQuestions &&
      !isQuestionVisibleForSku(question, answers, isCalibrated)
    ) {
      continue;
    }

    const value = answers[question.key];
    const normalizedValue = value !== undefined && value !== null && value !== '' ? value : 0;
    answerCodes.push(normalizedValue);
    answerCodeParts.push({
      value: normalizedValue,
      sku_separator: question.sku_separator || '',
    });
  }

  const legacySkuSeparator = categoryResult.rows[0]?.legacy_sku_separator || '';
  const baseSku = buildBaseSku(categoryCode, answerCodeParts);
  const compactBaseSku = buildBaseSku(categoryCode, answerCodes);
  const legacySeparatedBaseSku = buildBaseSku(categoryCode, answerCodes, legacySkuSeparator);
  const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
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

  const requiresWeight =
    categoryResult.rows.length > 0 &&
    Number(categoryResult.rows[0].requires_weight) === 1 &&
    categoryCode !== 'SK';

  if (!requiresWeight) {
    const baseSkuCandidates = Array.from(
      new Set([baseSku, compactBaseSku, legacySeparatedBaseSku])
    );
    const sequenceResult = await pool.query(
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

    return {
      mode: 'sequence',
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
    };
  }

  const weightInt = Math.round(weightVal);
  const fullProposedSku = appendSkuSuffix(baseSku, weightInt);
  const existingProduct = await pool.query(
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

  return {
    mode: 'weight',
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
  };
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

async function buildProductRecountPreview({ sourceSku, answers = {}, isCalibrated, reason = '' }) {
  const sourceDecoded = await decodeSku(sourceSku);
  if (!sourceDecoded.existsInDb || !sourceDecoded.product) {
    const err = new Error('Переоблік доступний тільки для артикула, який є в базі');
    err.statusCode = 404;
    throw err;
  }

  const categoryCode = sourceDecoded.category.code;
  const previousAnswers = buildProductAnswerContext(sourceDecoded);
  const nextAnswers = {
    ...previousAnswers,
    ...normalizeAnswerMap(answers),
  };
  const nextIsCalibrated =
    isCalibrated !== undefined && isCalibrated !== null && isCalibrated !== ''
      ? Number(isCalibrated)
      : nextAnswers.is_calibrated ?? getProductDetails(sourceDecoded.product).isCalibrated ?? null;
  if (nextIsCalibrated !== null && nextIsCalibrated !== undefined) {
    nextAnswers.is_calibrated = Number(nextIsCalibrated);
  }

  const changes = getAnswerChanges(previousAnswers, nextAnswers);
  if (changes.length === 0) {
    const err = new Error('Для переобліку змініть хоча б один параметр виробу.');
    err.statusCode = 422;
    throw err;
  }

  const weight = getCorrectionWeight(sourceDecoded);
  const correctedPreview = await buildProductPreview({
    categoryCode,
    answers: nextAnswers,
    weight,
    isCalibrated: nextIsCalibrated,
  });
  const correctionSku = await resolveCorrectionSku(correctedPreview.fullProposedSku);
  const oldPriceUah = roundUah(sourceDecoded.product.total_price_uah !== null &&
    sourceDecoded.product.total_price_uah !== undefined
      ? Number(sourceDecoded.product.total_price_uah)
      : Number(sourceDecoded.pricing?.totalPriceUah || 0)) || 0;
  const newPriceUah = roundUah(correctedPreview.totalPriceUah) || 0;

  return {
    source: {
      sku: sourceDecoded.sku,
      productId: sourceDecoded.product.id,
      answers: previousAnswers,
      decodedAnswers: sourceDecoded.decodedAnswers,
      totalPriceUah: oldPriceUah,
      pricePerGram: sourceDecoded.pricing?.pricePerGram ?? sourceDecoded.product.price_per_gram,
      pricePerGramUah: sourceDecoded.pricing?.pricePerGramUah ?? null,
      weight,
      pricing: sourceDecoded.pricing || null,
    },
    corrected: {
      categoryCode,
      answers: nextAnswers,
      fullSku: correctionSku.fullSku,
      proposedFullSku: correctedPreview.fullProposedSku,
      baseSku: correctedPreview.baseSku,
      nextSeq: correctedPreview.nextSeq,
      mode: correctedPreview.mode,
      variation: correctionSku.variation,
      weight,
      pricePerGram: correctedPreview.pricePerGram,
      pricePerGramUah: correctedPreview.pricePerGramUah,
      fixedPriceUah: correctedPreview.fixedPriceUah,
      priceMode: correctedPreview.priceMode,
      usesWeight: correctedPreview.usesWeight,
      totalPrice: correctedPreview.totalPrice,
      totalPriceUah: correctedPreview.totalPriceUah,
      uahRate: correctedPreview.uahRate,
      logMessage: correctedPreview.logMessage,
      pricingDetails: correctedPreview.pricingDetails,
    },
    changes,
    priceDeltaUah: newPriceUah - oldPriceUah,
    reason: String(reason || '').trim(),
  };
}

async function applyProductRecount(payload) {
  const preview = await buildProductRecountPreview(payload || {});
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sourceProductId = Number(preview.source.productId);
    const sourceLockResult = await client.query(
      `SELECT id, corrected_to_product_id
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
    if (sourceLockResult.rows[0].corrected_to_product_id) {
      const err = new Error('Цей товар уже був переоблікований. Оновіть декодер і відкрийте актуальний артикул.');
      err.statusCode = 409;
      throw err;
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
      correction: {
        sourceProductId,
        sourceSku: preview.source.sku,
        reason: preview.reason,
        changes: preview.changes,
      },
      baseGeneratedSku: corrected.proposedFullSku,
      variationNumber: corrected.variation?.variationNumber || null,
    };

    const insertResult = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
        price_per_gram, uah_rate, details, status, exclude_from_export, corrected_from_product_id,
        correction_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'correction', 1, $11, $12)
       RETURNING id`,
      [
        corrected.fullSku,
        corrected.baseSku,
        Number(corrected.nextSeq || 0),
        corrected.categoryCode,
        Number(corrected.weight || 0),
        Number(corrected.totalPrice || 0),
        corrected.totalPriceUah !== undefined && corrected.totalPriceUah !== null
          ? roundUah(corrected.totalPriceUah)
          : null,
        Number(corrected.pricePerGram || 0),
        corrected.uahRate !== undefined && corrected.uahRate !== null
          ? Number(corrected.uahRate)
          : null,
        JSON.stringify(details),
        sourceProductId,
        preview.reason || null,
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

    await client.query(
      `INSERT INTO product_corrections
       (source_product_id, corrected_product_id, source_sku, corrected_sku, old_payload,
        new_payload, reason, price_delta_uah)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [
        sourceProductId,
        correctedProductId,
        preview.source.sku,
        corrected.fullSku,
        JSON.stringify(preview.source),
        JSON.stringify(corrected),
        preview.reason || null,
        Number(preview.priceDeltaUah || 0),
      ]
    );

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

async function saveProduct(payload) {
  const client = await pool.connect();
  const fullSku = String(payload.fullSku || '').trim().toUpperCase();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fullSku]);
    const result = await client.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah, price_per_gram, uah_rate, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING id`,
      [
        fullSku,
        payload.baseSku,
        Number(payload.nextSeq),
        payload.category,
        Number(payload.weight || 0),
        Number(payload.totalPrice || 0),
        payload.totalPriceUah !== undefined && payload.totalPriceUah !== null
          ? roundUah(payload.totalPriceUah)
          : null,
        Number(payload.pricePerGram || 0),
        payload.uahRate !== undefined && payload.uahRate !== null ? Number(payload.uahRate) : null,
        JSON.stringify(payload.details || {}),
      ]
    );
    await client.query('COMMIT');

    return { success: true, id: result.rows[0].id, fullSku };
  } catch (err) {
    await client.query('ROLLBACK');
    throw normalizeSkuWriteError(err, fullSku);
  } finally {
    client.release();
  }
}

async function deleteProductBySku(skuToDelete) {
  const normalizedSku = String(skuToDelete || '').trim().toUpperCase();
  const result = await pool.query(
    `UPDATE products
     SET status = 'archived', exclude_from_export = 1
     WHERE full_sku = $1 AND COALESCE(status, 'active') <> 'archived'
     RETURNING id`,
    [normalizedSku]
  );
  if (result.rowCount === 0) {
    const err = new Error('Артикул не знайдено або вже архівовано.');
    err.statusCode = 404;
    throw err;
  }

  return {
    success: true,
    archivedCount: result.rowCount,
    message: `Артикул ${normalizedSku} перенесено в архів.`,
  };
}

async function getRecentProducts() {
  const result = await pool.query(
    `SELECT *
     FROM products
     WHERE COALESCE(status, 'active') <> 'archived'
     ORDER BY created_at DESC
     LIMIT 15`,
    []
  );

  return result.rows;
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
};
