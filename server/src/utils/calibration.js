const { isRuleMatched } = require('./rules');

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeValue(value) {
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? value : numericValue;
}

function resolveCalibrationState({ question, answers = {}, storedValue }) {
  if (hasValue(storedValue)) {
    return {
      status: 'known',
      value: normalizeValue(storedValue),
      source: 'stored',
    };
  }

  if (hasValue(answers.is_calibrated)) {
    return {
      status: 'known',
      value: normalizeValue(answers.is_calibrated),
      source: 'answers',
    };
  }

  if (!question || !isRuleMatched(question.visible_if_json, answers)) {
    return {
      status: 'not_applicable',
      value: null,
      source: null,
    };
  }

  return {
    status: 'unknown',
    value: null,
    source: null,
  };
}

module.exports = {
  resolveCalibrationState,
};
