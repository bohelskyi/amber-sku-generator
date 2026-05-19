const { isRuleMatched } = require('./rules');

function parseVariationSku(skuValue) {
  const normalizedSku = String(skuValue || '').trim().toUpperCase();
  const variationMatch = normalizedSku.match(/^(.*)-(\d{3})$/);

  if (!variationMatch) {
    return {
      normalizedSku,
      baseFullSku: normalizedSku,
      variationNumber: null,
    };
  }

  return {
    normalizedSku,
    baseFullSku: variationMatch[1],
    variationNumber: Number(variationMatch[2]),
  };
}

function normalizeSkuSeparator(separator) {
  const normalizedSeparator = String(separator || '').trim();
  if (!normalizedSeparator) return '';
  return /^[._/-]{1,3}$/.test(normalizedSeparator) ? normalizedSeparator : '';
}

function buildBaseSku(categoryCode, answerCodes, separator = '') {
  const normalizedSeparator = normalizeSkuSeparator(separator);
  if (normalizedSeparator) {
    const normalizedCodes = answerCodes.map((answerCode) => String(answerCode));
    return `${categoryCode}${normalizedCodes.join(normalizedSeparator)}`;
  }

  return answerCodes.reduce((baseSku, answerCode) => {
    const value =
      answerCode && typeof answerCode === 'object' ? answerCode.value : answerCode;
    const partSeparator =
      answerCode && typeof answerCode === 'object'
        ? normalizeSkuSeparator(answerCode.sku_separator)
        : '';

    return `${baseSku}${partSeparator}${String(value)}${partSeparator}`;
  }, String(categoryCode || ''));
}

function appendSkuSuffix(baseSku, suffixValue) {
  return `${baseSku}${String(suffixValue).padStart(3, '0')}`;
}

function stripSkuSeparators(encodedPart) {
  return String(encodedPart || '').replace(/[._/-]/g, '');
}

function getQuestionSeparator(question) {
  return normalizeSkuSeparator(question?.sku_separator);
}

function decodeQuestionOption(question, option) {
  return {
    key: question.key,
    label: question.label,
    sku_index: question.sku_index,
    value_id: option.id,
    value_label: option.label,
    is_placeholder: false,
  };
}

function decodePlaceholder(question) {
  return {
    key: question.key,
    label: question.label,
    sku_index: question.sku_index,
    value_id: null,
    value_label: 'Не обрано',
    is_placeholder: true,
  };
}

function decodeSkuAnswersWithQuestionSeparators(
  questions,
  encodedPart,
  index = 0,
  decodedAnswers = []
) {
  if (index === questions.length) {
    return encodedPart.length === 0 ? decodedAnswers : null;
  }

  const question = questions[index];
  const questionSeparator = getQuestionSeparator(question);

  if (questionSeparator) {
    if (!encodedPart.startsWith(questionSeparator)) return null;

    const encodedAfterOpeningSeparator = encodedPart.slice(questionSeparator.length);
    const closingSeparatorIndex = encodedAfterOpeningSeparator.indexOf(questionSeparator);
    if (closingSeparatorIndex < 0) return null;

    const optionCode = encodedAfterOpeningSeparator.slice(0, closingSeparatorIndex);
    const remainingEncodedPart = encodedAfterOpeningSeparator.slice(
      closingSeparatorIndex + questionSeparator.length
    );
    const option = question.options.find((item) => String(item.id) === optionCode);

    if (option) {
      return decodeSkuAnswersWithQuestionSeparators(
        questions,
        remainingEncodedPart,
        index + 1,
        [...decodedAnswers, decodeQuestionOption(question, option)]
      );
    }

    const hasZeroOption = question.options.some((item) => Number(item.id) === 0);
    if (question.required !== 1 && !hasZeroOption && optionCode === '0') {
      return decodeSkuAnswersWithQuestionSeparators(
        questions,
        remainingEncodedPart,
        index + 1,
        [...decodedAnswers, decodePlaceholder(question)]
      );
    }

    return null;
  }

  const options = [...question.options].sort(
    (a, b) => String(b.id).length - String(a.id).length || a.id - b.id
  );

  for (const option of options) {
    const optionCode = String(option.id);
    if (!encodedPart.startsWith(optionCode)) continue;

    const nextDecoded = decodeSkuAnswersWithQuestionSeparators(
      questions,
      encodedPart.slice(optionCode.length),
      index + 1,
      [
        ...decodedAnswers,
        decodeQuestionOption(question, option),
      ]
    );

    if (nextDecoded) return nextDecoded;
  }

  const hasZeroOption = question.options.some((option) => Number(option.id) === 0);
  if (question.required !== 1 && !hasZeroOption && encodedPart.startsWith('0')) {
    return decodeSkuAnswersWithQuestionSeparators(questions, encodedPart.slice(1), index + 1, [
      ...decodedAnswers,
      decodePlaceholder(question),
    ]);
  }

  return null;
}

function buildVisibilityContext(answers, isCalibrated) {
  return {
    ...answers,
    is_calibrated: isCalibrated,
  };
}

function isQuestionVisible(question, answers, isCalibrated) {
  return isRuleMatched(question.visible_if_json, buildVisibilityContext(answers, isCalibrated));
}

function decodeVisibleSkuAnswersWithQuestionSeparators(
  questions,
  encodedPart,
  index = 0,
  decodedAnswers = [],
  answerMap = {},
  isCalibrated = 0
) {
  if (index === questions.length) {
    return encodedPart.length === 0 ? decodedAnswers : null;
  }

  const question = questions[index];
  if (!isQuestionVisible(question, answerMap, isCalibrated)) {
    return decodeVisibleSkuAnswersWithQuestionSeparators(
      questions,
      encodedPart,
      index + 1,
      decodedAnswers,
      answerMap,
      isCalibrated
    );
  }

  const questionSeparator = getQuestionSeparator(question);

  if (questionSeparator) {
    if (!encodedPart.startsWith(questionSeparator)) return null;

    const encodedAfterOpeningSeparator = encodedPart.slice(questionSeparator.length);
    const closingSeparatorIndex = encodedAfterOpeningSeparator.indexOf(questionSeparator);
    if (closingSeparatorIndex < 0) return null;

    const optionCode = encodedAfterOpeningSeparator.slice(0, closingSeparatorIndex);
    const remainingEncodedPart = encodedAfterOpeningSeparator.slice(
      closingSeparatorIndex + questionSeparator.length
    );
    const option = question.options.find((item) => String(item.id) === optionCode);

    if (option) {
      return decodeVisibleSkuAnswersWithQuestionSeparators(
        questions,
        remainingEncodedPart,
        index + 1,
        [...decodedAnswers, decodeQuestionOption(question, option)],
        { ...answerMap, [question.key]: option.id },
        isCalibrated
      );
    }

    const hasZeroOption = question.options.some((item) => Number(item.id) === 0);
    if (question.required !== 1 && !hasZeroOption && optionCode === '0') {
      return decodeVisibleSkuAnswersWithQuestionSeparators(
        questions,
        remainingEncodedPart,
        index + 1,
        [...decodedAnswers, decodePlaceholder(question)],
        { ...answerMap, [question.key]: 0 },
        isCalibrated
      );
    }

    return null;
  }

  const options = [...question.options].sort(
    (a, b) => String(b.id).length - String(a.id).length || a.id - b.id
  );

  for (const option of options) {
    const optionCode = String(option.id);
    if (!encodedPart.startsWith(optionCode)) continue;

    const nextDecoded = decodeVisibleSkuAnswersWithQuestionSeparators(
      questions,
      encodedPart.slice(optionCode.length),
      index + 1,
      [...decodedAnswers, decodeQuestionOption(question, option)],
      { ...answerMap, [question.key]: option.id },
      isCalibrated
    );

    if (nextDecoded) return nextDecoded;
  }

  const hasZeroOption = question.options.some((option) => Number(option.id) === 0);
  if (question.required !== 1 && !hasZeroOption && encodedPart.startsWith('0')) {
    return decodeVisibleSkuAnswersWithQuestionSeparators(
      questions,
      encodedPart.slice(1),
      index + 1,
      [...decodedAnswers, decodePlaceholder(question)],
      { ...answerMap, [question.key]: 0 },
      isCalibrated
    );
  }

  return null;
}

function decodeCompactSkuAnswers(questions, encodedPart) {
  const compactQuestions = questions.map((question) => ({ ...question, sku_separator: '' }));
  return decodeSkuAnswersWithQuestionSeparators(compactQuestions, stripSkuSeparators(encodedPart));
}

function decodeVisibleCompactSkuAnswers(questions, encodedPart, isCalibrated) {
  const compactQuestions = questions.map((question) => ({ ...question, sku_separator: '' }));
  return decodeVisibleSkuAnswersWithQuestionSeparators(
    compactQuestions,
    stripSkuSeparators(encodedPart),
    0,
    [],
    {},
    isCalibrated
  );
}

function decodeSkuAnswers(questions, encodedPart) {
  const configuredSeparators = questions
    .map((question) => getQuestionSeparator(question))
    .filter(Boolean);
  const containsConfiguredSeparator = configuredSeparators.some((separator) =>
    String(encodedPart || '').includes(separator)
  );

  if (containsConfiguredSeparator) {
    const decodedWithSeparators = decodeSkuAnswersWithQuestionSeparators(
      questions,
      String(encodedPart || '')
    );
    if (decodedWithSeparators) return decodedWithSeparators;
  }

  return decodeCompactSkuAnswers(questions, encodedPart);
}

function decodeVisibleSkuAnswers(questions, encodedPart) {
  const configuredSeparators = questions
    .map((question) => getQuestionSeparator(question))
    .filter(Boolean);
  const containsConfiguredSeparator = configuredSeparators.some((separator) =>
    String(encodedPart || '').includes(separator)
  );
  const calibratedCandidates = [0, 1, 2, null];

  for (const isCalibrated of calibratedCandidates) {
    if (containsConfiguredSeparator) {
      const decodedWithSeparators = decodeVisibleSkuAnswersWithQuestionSeparators(
        questions,
        String(encodedPart || ''),
        0,
        [],
        {},
        isCalibrated
      );
      if (decodedWithSeparators) return decodedWithSeparators;
    }

    const decodedCompact = decodeVisibleCompactSkuAnswers(questions, encodedPart, isCalibrated);
    if (decodedCompact) return decodedCompact;
  }

  return null;
}

module.exports = {
  appendSkuSuffix,
  buildBaseSku,
  parseVariationSku,
  decodeSkuAnswers,
  decodeVisibleSkuAnswers,
  normalizeSkuSeparator,
  stripSkuSeparators,
};
