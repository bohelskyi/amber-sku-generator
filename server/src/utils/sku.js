const { isRuleMatched } = require('./rules');

function parseVariationSku(skuValue) {
  const normalizedSku = String(skuValue || '').trim().toUpperCase();
  const variationMatch = normalizedSku.match(/^(.*\d{3})-(\d{3})$/);

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

function buildSkuSuffixDecodeAttempts(skuWithoutCategory) {
  const encodedValue = String(skuWithoutCategory || '');
  const attempts = [];
  const seenAttempts = new Set();

  const addAttempt = (encodedPart, suffixRaw, hasSuffix) => {
    const attemptKey = `${encodedPart}\u0000${suffixRaw || ''}\u0000${hasSuffix ? 1 : 0}`;
    if (seenAttempts.has(attemptKey)) return;
    seenAttempts.add(attemptKey);
    attempts.push({ encodedPart, suffixRaw, hasSuffix });
  };

  for (let suffixLength = 3; suffixLength <= encodedValue.length; suffixLength += 1) {
    const suffixRaw = encodedValue.slice(-suffixLength);
    if (!/^\d+$/.test(suffixRaw)) continue;
    addAttempt(encodedValue.slice(0, -suffixLength), suffixRaw, true);
  }

  addAttempt(encodedValue, null, false);
  return attempts;
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

function decodeStoredSkuAnswers(questions, encodedPart, storedAnswers = {}) {
  if (!storedAnswers || typeof storedAnswers !== 'object') return null;

  const answerCodes = [];
  const decodedAnswers = [];

  for (const question of questions) {
    const hasStoredValue =
      Object.prototype.hasOwnProperty.call(storedAnswers, question.key)
      && storedAnswers[question.key] !== null
      && storedAnswers[question.key] !== '';
    const storedValue = hasStoredValue ? storedAnswers[question.key] : 0;
    const option = question.options.find(
      (item) => String(item.id) === String(storedValue)
    );

    if (option) {
      decodedAnswers.push(decodeQuestionOption(question, option));
      answerCodes.push({ value: option.id, sku_separator: question.sku_separator });
      continue;
    }

    const hasZeroOption = question.options.some((item) => Number(item.id) === 0);
    if (Number(storedValue) !== 0 || hasZeroOption) return null;

    decodedAnswers.push(decodePlaceholder(question));
    answerCodes.push({ value: 0, sku_separator: question.sku_separator });
  }

  const source = String(encodedPart || '');
  const configuredSkuPart = buildBaseSku('', answerCodes);
  const compactSkuPart = buildBaseSku('', answerCodes.map((answer) => answer.value));
  const matchesStoredAnswers =
    source === configuredSkuPart || stripSkuSeparators(source) === compactSkuPart;

  return matchesStoredAnswers ? decodedAnswers : null;
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

function getExpectedQuestionValues(question) {
  const expected = question.options.map((option) => ({
    code: String(option.id),
    label: option.label,
  }));
  const hasZeroOption = question.options.some((option) => Number(option.id) === 0);

  if (question.required !== 1 && !hasZeroOption) {
    expected.unshift({ code: '0', label: 'Не обрано' });
  }

  return expected;
}

function getMoreSpecificFailure(currentFailure, candidateFailure) {
  if (!currentFailure) return candidateFailure;
  if (!candidateFailure) return currentFailure;
  if (candidateFailure.questionIndex !== currentFailure.questionIndex) {
    return candidateFailure.questionIndex > currentFailure.questionIndex
      ? candidateFailure
      : currentFailure;
  }
  if (candidateFailure.offset !== currentFailure.offset) {
    return candidateFailure.offset > currentFailure.offset ? candidateFailure : currentFailure;
  }
  return currentFailure;
}

function createQuestionFailure(type, question, questionIndex, offset, remaining, received) {
  const readableReceived = received || 'кінець артикула';
  let message = `Параметр «${question.label}» має невідомий код «${readableReceived}».`;

  if (type === 'missing_opening_separator') {
    message = `Перед параметром «${question.label}» очікується роздільник «${getQuestionSeparator(question)}».`;
  } else if (type === 'missing_closing_separator') {
    message = `Після значення параметра «${question.label}» немає закривального роздільника «${getQuestionSeparator(question)}».`;
  }

  return {
    type,
    message,
    questionIndex,
    position: questionIndex + 1,
    offset,
    questionKey: question.key,
    questionLabel: question.label,
    received: readableReceived,
    remaining: remaining || '',
    expected: getExpectedQuestionValues(question),
    separator: getQuestionSeparator(question) || null,
  };
}

function diagnoseSkuPath(
  questions,
  encodedPart,
  { useSeparators = false, skipHiddenQuestions = false, isCalibrated = 0 } = {}
) {
  function walk(questionIndex, remaining, answers, offset) {
    if (questionIndex === questions.length) {
      if (!remaining) return { success: true };
      return {
        success: false,
        failure: {
          type: 'extra_characters',
          message: `Після останнього параметра залишився нерозпізнаний фрагмент «${remaining}».`,
          questionIndex,
          position: questionIndex + 1,
          offset,
          questionKey: null,
          questionLabel: null,
          received: remaining,
          remaining,
          expected: [],
          separator: null,
        },
      };
    }

    const question = questions[questionIndex];
    if (
      skipHiddenQuestions
      && !isQuestionVisible(question, answers, isCalibrated)
    ) {
      return walk(questionIndex + 1, remaining, answers, offset);
    }

    const separator = useSeparators ? getQuestionSeparator(question) : '';
    if (separator) {
      if (!remaining.startsWith(separator)) {
        return {
          success: false,
          failure: createQuestionFailure(
            'missing_opening_separator',
            question,
            questionIndex,
            offset,
            remaining,
            remaining.slice(0, separator.length)
          ),
        };
      }

      const afterOpeningSeparator = remaining.slice(separator.length);
      const closingSeparatorIndex = afterOpeningSeparator.indexOf(separator);
      if (closingSeparatorIndex < 0) {
        return {
          success: false,
          failure: createQuestionFailure(
            'missing_closing_separator',
            question,
            questionIndex,
            offset + separator.length,
            afterOpeningSeparator,
            afterOpeningSeparator
          ),
        };
      }

      const optionCode = afterOpeningSeparator.slice(0, closingSeparatorIndex);
      const consumedLength = separator.length * 2 + optionCode.length;
      const nextRemaining = remaining.slice(consumedLength);
      const option = question.options.find((item) => String(item.id) === optionCode);
      const hasZeroOption = question.options.some((item) => Number(item.id) === 0);
      const isPlaceholder = question.required !== 1 && !hasZeroOption && optionCode === '0';

      if (!option && !isPlaceholder) {
        return {
          success: false,
          failure: createQuestionFailure(
            'invalid_option',
            question,
            questionIndex,
            offset + separator.length,
            afterOpeningSeparator,
            optionCode
          ),
        };
      }

      const value = option ? option.id : 0;
      return walk(
        questionIndex + 1,
        nextRemaining,
        { ...answers, [question.key]: value },
        offset + consumedLength
      );
    }

    const options = [...question.options].sort(
      (a, b) => String(b.id).length - String(a.id).length || a.id - b.id
    );
    let bestFailure = null;
    let matchedPrefix = false;

    for (const option of options) {
      const optionCode = String(option.id);
      if (!remaining.startsWith(optionCode)) continue;
      matchedPrefix = true;
      const result = walk(
        questionIndex + 1,
        remaining.slice(optionCode.length),
        { ...answers, [question.key]: option.id },
        offset + optionCode.length
      );
      if (result.success) return result;
      bestFailure = getMoreSpecificFailure(bestFailure, result.failure);
    }

    const hasZeroOption = question.options.some((option) => Number(option.id) === 0);
    if (question.required !== 1 && !hasZeroOption && remaining.startsWith('0')) {
      matchedPrefix = true;
      const result = walk(
        questionIndex + 1,
        remaining.slice(1),
        { ...answers, [question.key]: 0 },
        offset + 1
      );
      if (result.success) return result;
      bestFailure = getMoreSpecificFailure(bestFailure, result.failure);
    }

    if (matchedPrefix && bestFailure) return { success: false, failure: bestFailure };

    return {
      success: false,
      failure: createQuestionFailure(
        'invalid_option',
        question,
        questionIndex,
        offset,
        remaining,
        remaining.slice(0, 1)
      ),
    };
  }

  return walk(0, String(encodedPart || ''), {}, 0);
}

function diagnoseSkuAnswers(questions, encodedPart, { skipHiddenQuestions = false } = {}) {
  const source = String(encodedPart || '');
  const configuredSeparators = questions
    .map((question) => getQuestionSeparator(question))
    .filter(Boolean);
  const containsConfiguredSeparator = configuredSeparators.some((separator) =>
    source.includes(separator)
  );
  const calibratedCandidates = skipHiddenQuestions ? [0, 1, 2, null] : [0];
  let bestFailure = null;

  for (const isCalibrated of calibratedCandidates) {
    if (containsConfiguredSeparator) {
      const separatedResult = diagnoseSkuPath(questions, source, {
        useSeparators: true,
        skipHiddenQuestions,
        isCalibrated,
      });
      if (separatedResult.success) return null;
      bestFailure = getMoreSpecificFailure(bestFailure, separatedResult.failure);
    }

    const compactResult = diagnoseSkuPath(questions, stripSkuSeparators(source), {
      skipHiddenQuestions,
      isCalibrated,
    });
    if (compactResult.success) return null;
    bestFailure = getMoreSpecificFailure(bestFailure, compactResult.failure);
  }

  return bestFailure;
}

function diagnoseSkuAttempts(questions, attempts, options = {}) {
  let bestDiagnosis = null;

  for (const attempt of attempts) {
    const diagnosis = diagnoseSkuAnswers(questions, attempt.encodedPart, options);
    if (!diagnosis) continue;

    const candidate = {
      ...diagnosis,
      encodedPart: attempt.encodedPart,
      suffixRaw: attempt.suffixRaw,
      hasSuffix: attempt.hasSuffix,
    };
    bestDiagnosis = getMoreSpecificFailure(bestDiagnosis, candidate);
  }

  return bestDiagnosis;
}

module.exports = {
  appendSkuSuffix,
  buildSkuSuffixDecodeAttempts,
  buildBaseSku,
  parseVariationSku,
  decodeSkuAnswers,
  decodeStoredSkuAnswers,
  decodeVisibleSkuAnswers,
  diagnoseSkuAnswers,
  diagnoseSkuAttempts,
  normalizeSkuSeparator,
  stripSkuSeparators,
};
