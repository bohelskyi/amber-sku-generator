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

function decodeCompactSkuAnswers(questions, encodedPart) {
  const compactQuestions = questions.map((question) => ({ ...question, sku_separator: '' }));
  return decodeSkuAnswersWithQuestionSeparators(compactQuestions, stripSkuSeparators(encodedPart));
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

module.exports = {
  appendSkuSuffix,
  buildBaseSku,
  parseVariationSku,
  decodeSkuAnswers,
  normalizeSkuSeparator,
  stripSkuSeparators,
};
