export const isTextQuestion = (question) => (question?.input_type || 'options') === 'text';

const normalizeRuleValue = (value) => {
  if (value === null || value === undefined) return value;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
};

const asRuleObject = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const isVisibilityRuleMatched = (rule, context) => {
  const normalizedRule = asRuleObject(rule);

  for (const [key, expected] of Object.entries(normalizedRule)) {
    const actual = context[key];
    const actualNormalized = normalizeRuleValue(actual);

    if (Array.isArray(expected)) {
      const expectedNormalized = expected.map((item) => normalizeRuleValue(item));
      if (!expectedNormalized.includes(actualNormalized)) return false;
    } else {
      const expectedNormalized = normalizeRuleValue(expected);
      if (actualNormalized !== expectedNormalized) return false;
    }
  }

  return true;
};

export const isQuestionVisible = (
  question,
  answersMap = {},
  calibratedValue = null
) => {
  const calibratedAnswer =
    answersMap.is_calibrated !== undefined &&
    answersMap.is_calibrated !== null &&
    answersMap.is_calibrated !== ''
      ? answersMap.is_calibrated
      : calibratedValue;
  const context = {
    ...answersMap,
    is_calibrated: calibratedAnswer,
  };

  return isVisibilityRuleMatched(question?.visible_if_json ?? question?.visible_if, context);
};

export const getVisibleOptionsForQuestion = (
  question,
  answersMap = {},
  calibratedValue = null
) => {
  if (isTextQuestion(question)) return [];

  const calibratedAnswer =
    answersMap.is_calibrated !== undefined &&
    answersMap.is_calibrated !== null &&
    answersMap.is_calibrated !== ''
      ? answersMap.is_calibrated
      : calibratedValue;
  const context = {
    ...answersMap,
    is_calibrated: calibratedAnswer,
  };

  return (question.options || []).filter((option) => {
    const hiddenRule = asRuleObject(option.hidden_if_json);
    const isExplicitlyHidden = Object.keys(hiddenRule).length > 0
      && isVisibilityRuleMatched(hiddenRule, context);

    return isVisibilityRuleMatched(option.visible_if_json, context) && !isExplicitlyHidden;
  });
};
