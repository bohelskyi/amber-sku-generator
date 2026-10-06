const { calculatePricing } = require('../pricing.service');
const {
  resolveCalibrationState,
  shouldHidePriceForCalibration,
} = require('../../utils/calibration');
const { toUahNumber } = require('../../utils/money');
const { getRuleDependencies } = require('../../utils/rules');
const {
  buildSkuSuffixDecodeAttempts,
  decodeSkuAnswers,
  decodeVisibleSkuAnswers,
  diagnoseSkuAttempts,
  parseVariationSku,
} = require('../../utils/sku');
const {
  getSchemaVersion,
  getSchemaVersionById,
  parseVersionedSkuPart,
} = require('../sku-schema.service');
const {
  buildAnswerMap,
  getProductDetails,
  getStoredAnswers,
} = require('./product-answers');
const { getContextualOption } = require('./product-validation');
const { resolveProductLookup } = require('./public-identity');

async function getAllCategories(queryable) {
  const result = await queryable.query(
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

async function getCalibrationQuestionForCategory(categoryCode, queryable) {
  const result = await queryable.query(
    `SELECT visible_if_json
     FROM questions
     WHERE category_code = $1 AND key = 'is_calibrated'
     LIMIT 1`,
    [categoryCode]
  );

  return result.rows[0] || null;
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

function getPricingConditionValue(key, pricingAnswers, pricingDetails) {
  if (key === 'is_calibrated') {
    return pricingAnswers.is_calibrated ?? pricingDetails?.calibratedValue ?? null;
  }

  return pricingAnswers[key] ?? null;
}

function getDecodedPricingPayload({
  decodedAnswers,
  product,
  pricing,
  pricingAnswers,
  suffixValue,
}) {
  const productDetails = getProductDetails(product);
  const hasStoredProduct = Boolean(product);
  const storedCalculatedPriceUah = toUahNumber(
    productDetails.calculatedPriceUah ?? productDetails.autoPriceUah
  );
  const storedAutomaticPriceUah = toUahNumber(
    productDetails.autoPriceUah
      ?? (productDetails.manualPriceUah === null || productDetails.manualPriceUah === undefined
        ? product?.total_price_uah
        : null)
  );
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
    dependentKeys.includes('is_calibrated')
    || pricingAnswers.is_calibrated !== undefined
    || productDetails.isCalibrated !== undefined;
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
    calculatedPriceUah: hasStoredProduct
      ? storedCalculatedPriceUah
      : toUahNumber(pricing.currencyPayload?.calculatedPriceUah),
    automaticPriceUah: hasStoredProduct
      ? storedAutomaticPriceUah
      : toUahNumber(pricing.currencyPayload?.totalPriceUah),
    totalPriceUah: toUahNumber(
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

async function projectStoredProduct(lookup, category, queryable) {
  const product = lookup.product;
  const details = getProductDetails(product);
  const answers = getStoredAnswers(product);
  const semantic = product.characteristic_version_id
    ? await require('./characteristic-config').getCharacteristicVersion(queryable, product.characteristic_version_id) : null;
  const schema = semantic || (product.sku_schema_version_id
    ? await getSchemaVersionById(product.sku_schema_version_id, queryable)
    : await getSchemaVersion(category.code, details.skuSchemaVersion || 1, queryable));
  const questions = schema?.questions || [];
  const decodedAnswers = questions.filter(question => !semantic || Object.hasOwn(answers,question.key)).map((question) => {
    const value = answers[question.key];
    const option = getContextualOption(question, value, answers);
    const isPlaceholder = value === undefined
      || (!semantic && value === 0 && !option && !question.options.some((item) => item.sku_code === '0'));
    return {
      key: question.key,
      label: question.label,
      sku_index: question.sku_index,
      value_id: isPlaceholder ? null : value,
      value_label: isPlaceholder ? 'Не обрано' : option?.label || String(value),
      is_placeholder: isPlaceholder,
    };
  });
  const calibration = resolveCalibrationState({
    question: await getCalibrationQuestionForCategory(category.code, queryable),
    answers,
    storedValue: details.isCalibrated,
  });
  // Historical pricing is read from the row, never recalculated or hidden by today's rules.
  const scenario = details.pricingScenario;
  const configuredMode = semantic && details.creationPricingDecision?.mode === 'manual_uah'
    ? 'manual_uah' : scenario?.price_mode || 'category_default';
  const priceMode = configuredMode === 'category_default' && Number(product.price_per_gram) > 0
    ? 'per_gram_usd' : configuredMode;
  const dependentKeys = uniqueValues([
    ...getRuleDependencies(scenario?.match_json),
    ...[scenario?.axis_x_key, scenario?.axis_y_key].flatMap((axis) =>
      String(axis || '').split('+').map((key) => key.trim() === 'weight_band' ? 'weight' : key.trim())),
  ]);
  const pricing = getDecodedPricingPayload({
    decodedAnswers, product, pricingAnswers: answers, suffixValue: null,
    pricing: { pricingDetails: {
      scenario: details.pricingScenario || null,
      priceMode,
      isWeightBased: priceMode === 'per_gram_usd',
      usesWeight: priceMode === 'per_gram_usd' || dependentKeys.includes('weight'),
      dependentKeys,
    } },
  });
  let weightConflict = null;
  if (Object.hasOwn(answers, 'weight')) {
    try { require('../../utils/numbers').resolveProductWeight(product.weight, answers.weight); }
    catch (cause) { weightConflict = { code: cause.code || 'WEIGHT_INVALID', details: cause.details || null, message: cause.message }; }
  }
  const { baseFullSku, variationNumber } = parseVariationSku(product.full_sku);
  const suffixRaw = baseFullSku.startsWith(product.base_sku)
    ? baseFullSku.slice(product.base_sku.length) : '';
  const hasSuffix = /^\d+$/.test(suffixRaw);
  return {
    sku: product.full_sku || product.public_sku,
    internalSku: product.full_sku,
    publicSku: product.public_sku || null,
    ...require('./test-products').projection(product),
    lookupKind: lookup.lookupKind,
    decodeSource: 'stored_history',
    weightConflict,
    characteristicConfig: semantic ? { id: String(semantic.id), version: String(semantic.version), configHash: semantic.config_hash } : null,
    skuSchema: {
      id: !semantic && schema ? Number(schema.id) : null,
      version: schema?.version ?? details.skuSchemaVersion ?? null,
      marker: schema?.marker || '',
      status: schema?.status || null,
    },
    calibration,
    category,
    baseSku: product.base_sku,
    decodedAnswers,
    suffix: {
      raw: hasSuffix ? suffixRaw : null,
      type: hasSuffix ? (category.requires_weight === 1 ? 'weight' : 'sequence') : 'none',
      value: hasSuffix ? Number(product.sequence_number) : null,
    },
    pricing,
    variation: variationNumber === null ? null : {
      number: variationNumber, suffix: `-${String(variationNumber).padStart(3, '0')}`,
    },
    existsInDb: true,
    product,
  };
}

async function decodeSku(skuValue, queryable) {
  const lookup = await resolveProductLookup(queryable, skuValue);
  const internalLookupSku = lookup.product?.full_sku || skuValue;
  const { normalizedSku, baseFullSku, variationNumber } = parseVariationSku(internalLookupSku);
  if (!normalizedSku) {
    throw new Error('Введіть артикул для розшифровки');
  }

  const categories = await getAllCategories(queryable);
  const category = lookup.product
    ? categories.find((item) => item.code === lookup.product.category)
    : categories.find((item) => baseFullSku.startsWith(item.code));
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

  if (lookup.product) return projectStoredProduct(lookup, category, queryable);

  const parsedSchema = parseVersionedSkuPart(baseFullSku.slice(category.code.length));
  const schema = await getSchemaVersion(category.code, parsedSchema.version, queryable);
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
  const calibrationQuestion = await getCalibrationQuestionForCategory(category.code, queryable);
  const attempts = buildSkuSuffixDecodeAttempts(parsedSchema.encodedWithSuffix);

  for (const attempt of attempts) {
    const rawDecodedAnswers =
      Number(category.skip_hidden_sku_questions || 0) === 1
        ? decodeVisibleSkuAnswers(questions, attempt.encodedPart)
        : decodeSkuAnswers(questions, attempt.encodedPart);
    if (!rawDecodedAnswers) continue;
    const decodedAnswers = resolveContextualAnswerLabels(rawDecodedAnswers, questions);

    const suffixValue =
      attempt.suffixRaw !== null && /^\d+$/.test(attempt.suffixRaw)
        ? Number(attempt.suffixRaw)
        : null;
    const pricingAnswers = buildAnswerMap(decodedAnswers);
    const calibration = resolveCalibrationState({
      question: calibrationQuestion,
      answers: pricingAnswers,
    });
    const pricingWeight = category.requires_weight === 1 ? suffixValue : 0;
    const calculatedPricing = await calculatePricing(
      category.code,
      pricingAnswers,
      pricingWeight,
      calibration.value,
      { queryable }
    );
    const pricing = shouldHidePriceForCalibration(
      calibration,
      calculatedPricing.pricingDetails?.dependentKeys || []
    )
      ? null
      : calculatedPricing;

    return {
      sku: normalizedSku,
      internalSku: normalizedSku,
      publicSku: null,
      lookupKind: lookup.lookupKind,
      decodeSource: 'versioned_schema',
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
            product: null,
            pricing,
            pricingAnswers,
            suffixValue,
          })
        : null,
      variation: variationNumber !== null
        ? {
            number: variationNumber,
            suffix: `-${String(variationNumber).padStart(3, '0')}`,
          }
        : null,
      existsInDb: false,
      product: null,
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

module.exports = {
  decodeSku,
  getDecodedPricingPayload,
  resolveContextualAnswerLabels,
};
