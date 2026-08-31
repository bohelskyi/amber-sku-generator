const crypto = require('node:crypto');
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
  getOptionCode,
  getOptionValue,
  isOptionalPlaceholderAnswer,
  parseVariationSku,
} = require('../utils/sku');
const { isRuleMatched } = require('../utils/rules');
const {
  getActiveSchema,
  getSchemaVersion,
  getSchemaVersionById,
  parseVersionedSkuPart,
} = require('./sku-schema.service');

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

function getRuleSpecificity(rule) {
  return rule && typeof rule === 'object' ? Object.keys(rule).length : 0;
}

function getContextualOption(question, value, answers) {
  const candidates = (question.options || []).filter(
    (option) => String(getOptionValue(option)) === String(value)
  );
  const eligible = candidates.filter((option) => (
    isRuleMatched(option.visible_if_json, answers)
    && !(option.hidden_if_json && isRuleMatched(option.hidden_if_json, answers))
  ));
  return [...(eligible.length ? eligible : candidates)].sort((first, second) => (
    getRuleSpecificity(second.visible_if_json) - getRuleSpecificity(first.visible_if_json)
  ))[0] || null;
}

function resolveContextualAnswerLabels(decodedAnswers, questions) {
  const answers = buildAnswerMap(decodedAnswers);
  const questionsByKey = new Map(questions.map((question) => [question.key, question]));
  return decodedAnswers.map((answer) => {
    if (answer.is_placeholder) return answer;
    const option = getContextualOption(
      questionsByKey.get(answer.key) || { options: [] },
      answer.value_id,
      answers
    );
    return option ? { ...answer, value_label: option.label } : answer;
  });
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

  const productResult = await pool.query(
    `SELECT id, full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export,
            corrected_from_product_id, corrected_to_product_id, correction_reason, created_at,
            sku_schema_version_id
     FROM products
     WHERE full_sku = $1
     ORDER BY id ASC
     LIMIT 1`,
    [normalizedSku]
  );
  const product = productResult.rows[0] || null;
  const parsedSchema = parseVersionedSkuPart(baseFullSku.slice(category.code.length));
  const schema = await getSchemaVersion(category.code, parsedSchema.version);
  if (!schema) {
    const err = new Error(
      `SKU-схему V${parsedSchema.version} для категорії ${category.code} не знайдено.`
    );
    err.statusCode = 422;
    err.details = {
      type: 'unknown_sku_schema',
      category: { code: category.code, name: category.name },
      version: parsedSchema.version,
      marker: parsedSchema.marker,
    };
    throw err;
  }
  const questions = schema.questions;
  const calibrationQuestion = await getCalibrationQuestionForCategory(category.code);
  const attempts = buildSkuSuffixDecodeAttempts(parsedSchema.encodedWithSuffix);
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
    const rawDecodedAnswers = usesStoredHistory
      ? storedDecodedAnswers
      : configuredDecodedAnswers || storedDecodedAnswers;
    if (!rawDecodedAnswers) continue;
    const decodedAnswers = resolveContextualAnswerLabels(rawDecodedAnswers, questions);

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
      decodeSource: usesStoredHistory ? 'stored_history' : 'versioned_schema',
      skuSchema: {
        id: Number(schema.id),
        version: schema.version,
        marker: schema.marker,
        status: schema.status,
      },
      calibration,
      category: {
        code: category.code,
        name: category.name,
        requires_weight: category.requires_weight,
        skip_hidden_sku_questions: category.skip_hidden_sku_questions,
      },
      baseSku: category.code + schema.marker + attempt.encodedPart,
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
    skuSchema: { version: schema.version, marker: schema.marker },
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

function isOptionAvailable(option, answers) {
  return Boolean(option)
    && !option.archived
    && isRuleMatched(option.visible_if_json, answers)
    && !(option.hidden_if_json && isRuleMatched(option.hidden_if_json, answers));
}

function getProductStateSignature(product) {
  const relevantState = {
    id: Number(product?.id),
    fullSku: product?.full_sku || null,
    category: product?.category || null,
    weight: product?.weight === null ? null : Number(product?.weight),
    totalPrice: product?.total_price === null ? null : Number(product?.total_price),
    totalPriceUah: product?.total_price_uah === null ? null : Number(product?.total_price_uah),
    pricePerGram: product?.price_per_gram === null ? null : Number(product?.price_per_gram),
    uahRate: product?.uah_rate === null ? null : Number(product?.uah_rate),
    status: product?.status || 'active',
    correctedToProductId: product?.corrected_to_product_id || null,
    schemaVersionId: product?.sku_schema_version_id || null,
    details: getProductDetails(product),
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevantState)).digest('hex');
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
  const rounded = roundUah(value);
  if (!Number.isFinite(Number(value)) || rounded === null || rounded <= 0) {
    throw validationError('Ручна ціна повинна бути більшою за 0.');
  }
  return rounded;
}

function getProductPreviewToken(preview, categoryCode, answers, isCalibrated) {
  const stableAnswers = Object.entries(answers)
    .map(([key, value]) => [key, value ?? null])
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey));
  const payload = {
    categoryCode,
    answers: stableAnswers,
    isCalibrated: Number(answers.is_calibrated ?? isCalibrated ?? 0),
    weight: Number(preview.weightVal || 0),
    skuSchemaVersionId: Number(preview.skuSchemaVersionId),
    baseSku: preview.baseSku,
    mode: preview.mode,
    priceMode: preview.priceMode,
    pricePerGram: preview.pricePerGram,
    fixedPriceUah: preview.fixedPriceUah ?? null,
    totalPrice: preview.totalPrice,
    totalPriceUah: preview.totalPriceUah ?? null,
    uahRate: preview.uahRate ?? null,
    uahRateDate: preview.uahRateDate ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
    if (!isQuestionVisibleForSku(question, answers, isCalibrated)) continue;
    const value = answers[question.key];
    const hasValue = value !== undefined && value !== null && String(value).trim() !== '';
    if (question.required === 1 && !hasValue) {
      throw validationError(`Заповніть обов'язкове поле «${question.label}».`);
    }
    if (!hasValue || question.input_type === 'text') continue;
    const option = getContextualOption(question, value, answers);
    if (!isOptionAvailable(option, answers)) {
      throw validationError(`Значення «${value}» недоступне для поля «${question.label}».`);
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
    if (
      skipHiddenSkuQuestions &&
      !isQuestionVisibleForSku(question, normalizedAnswers, isCalibrated)
    ) {
      continue;
    }

    const value = normalizedAnswers[question.key];
    const hasValue = value !== undefined && value !== null && value !== '';
    if (Number(question.required) === 1
        && isQuestionVisibleForSku(question, normalizedAnswers, isCalibrated)
        && !hasValue) {
      throw validationError(`Заповніть обов'язкове поле «${question.label}».`);
    }
    const option = hasValue ? getContextualOption(question, value, normalizedAnswers) : null;
    const isPlaceholder = hasValue && isOptionalPlaceholderAnswer(question, value, option);
    if (hasValue && option && !isOptionAvailable(option, normalizedAnswers)) {
      throw validationError(`Значення «${value}» недоступне для поля «${question.label}».`);
    }
    if (hasValue && !option && !isPlaceholder) {
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
      stateSignature: getProductStateSignature(sourceDecoded.product),
    },
    corrected: {
      categoryCode,
      skuSchemaVersionId: correctedPreview.skuSchemaVersionId,
      skuSchemaVersion: correctedPreview.skuSchemaVersion,
      skuSchemaMarker: correctedPreview.skuSchemaMarker,
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
      manualPriceUah: previewManualPrice,
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
    const correctionAutoPriceUah = roundUah(freshPreview.totalPriceUah);
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
      uahRate: freshPreview.uahRate,
      logMessage: freshPreview.logMessage,
      pricingDetails: freshPreview.pricingDetails,
    });
    preview.priceDeltaUah = correctionFinalPriceUah - Number(preview.source.totalPriceUah || 0);

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
        correction_reason, sku_schema_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'active', 1, $11, $12, $13)
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
        Number(corrected.skuSchemaVersionId),
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

    if (payload.correctionRequestId) {
      const requestResult = await client.query(
        `UPDATE correction_requests
         SET status = 'completed',
             corrected_product_id = $1,
             proposed_sku = $2,
             final_payload = $3::jsonb,
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
           AND source_product_id = $5
           AND preview_signature = $6
           AND status IN ('pending', 'in_progress')
         RETURNING id`,
        [
          correctedProductId,
          corrected.fullSku,
          JSON.stringify(corrected),
          Number(payload.correctionRequestId),
          sourceProductId,
          String(payload.correctionRequestSignature || ''),
        ]
      );
      if (requestResult.rows.length === 0) {
        const err = new Error('Запит на виправлення змінив статус. Оновіть сторінку.');
        err.statusCode = 409;
        throw err;
      }
    }

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
    const autoPriceUah = roundUah(preview.totalPriceUah);
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
        price_per_gram, uah_rate, details, sku_schema_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
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
  getProductStateSignature,
  getProductPreviewToken,
};
