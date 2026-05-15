export const isTextQuestion = (question) => (question?.input_type || 'options') === 'text';

const normalizeRuleValue = (value) => {
  if (value === null || value === undefined) return value;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
};

export const isVisibilityRuleMatched = (rule, context) => {
  if (!rule || typeof rule !== 'object') return true;

  for (const [key, expected] of Object.entries(rule)) {
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
  const context = {
    ...answersMap,
    is_calibrated: calibratedValue,
  };

  return isVisibilityRuleMatched(question?.visible_if_json ?? question?.visible_if, context);
};

export const getVisibleOptionsForQuestion = (
  question,
  answersMap = {},
  calibratedValue = null
) => {
  if (isTextQuestion(question)) return [];

  const context = {
    ...answersMap,
    is_calibrated: calibratedValue,
  };

  return (question.options || []).filter((option) =>
    isVisibilityRuleMatched(option.visible_if_json, context)
  );
};
