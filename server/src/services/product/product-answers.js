const { isRuleMatched } = require('../../utils/rules');

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

function mergeRecountAnswerPatch(previousAnswers, submittedAnswers) {
  const answerPatch = submittedAnswers && typeof submittedAnswers === 'object'
    ? submittedAnswers
    : {};
  const mergedAnswers = {
    ...previousAnswers,
    ...normalizeAnswerMap(answerPatch),
  };

  for (const [key, value] of Object.entries(answerPatch)) {
    if (value === undefined || value === null || String(value).trim() === '') {
      delete mergedAnswers[key];
    }
  }

  return mergedAnswers;
}

function getProductDetails(product) {
  if (!product?.details || typeof product.details !== 'object') return {};
  return product.details;
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

function isQuestionVisibleForSku(question, answers, isCalibrated) {
  const calibratedAnswer =
    answers.is_calibrated !== undefined
    && answers.is_calibrated !== null
    && answers.is_calibrated !== ''
      ? answers.is_calibrated
      : isCalibrated;
  return isRuleMatched(question.visible_if_json, {
    ...answers,
    is_calibrated: calibratedAnswer,
  });
}

function omitHiddenRecountAnswers(answers, schemaQuestions, isCalibrated) {
  return (schemaQuestions || []).reduce((result, question) => {
    if (!isQuestionVisibleForSku(question, answers, isCalibrated)) {
      delete result[question.key];
    }
    return result;
  }, { ...answers });
}

module.exports = {
  buildAnswerMap,
  buildProductAnswerContext,
  getCorrectionWeight,
  getProductDetails,
  getStoredAnswers,
  haveSameDecodedAnswers,
  isQuestionVisibleForSku,
  mergeRecountAnswerPatch,
  normalizeAnswerMap,
  omitHiddenRecountAnswers,
};
