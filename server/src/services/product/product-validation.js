const { getOptionValue, isOptionalPlaceholderAnswer } = require('../../utils/sku');
const { isRuleMatched } = require('../../utils/rules');
const { isQuestionVisibleForSku } = require('./product-answers');
const { validateNumericAnswer } = require('../../utils/numbers');

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
    Number(Boolean(first.archived)) - Number(Boolean(second.archived))
    || getRuleSpecificity(second.visible_if_json) - getRuleSpecificity(first.visible_if_json)
  ))[0] || null;
}

function isOptionAvailable(option, answers) {
  return Boolean(option)
    && !option.archived
    && isRuleMatched(option.visible_if_json, answers)
    && !(option.hidden_if_json && isRuleMatched(option.hidden_if_json, answers));
}

function inspectNonSkuAnswer(question, answers, isCalibrated, { previousAnswers = {} } = {}) {
  const visible = !question.archived && isQuestionVisibleForSku(question, answers, isCalibrated);
  if (!visible) return { issue: null, visible };

  const value = answers[question.key];
  const hasValue = value !== undefined && value !== null && String(value).trim() !== '';
  if (Number(question.required) === 1 && !hasValue) {
    return { issue: 'required', visible, value, hasValue, option: null };
  }
  if (hasValue && question.numeric_validation) validateNumericAnswer(question, value);
  if (!hasValue || question.input_type === 'text') {
    return { issue: null, visible, value, hasValue, option: null };
  }

  const option = getContextualOption(question, value, answers);
  return {
    issue: isOptionAvailable(option, answers) || (option?.archived && Object.hasOwn(previousAnswers, question.key)
      && String(previousAnswers[question.key]) === String(value)
      && isRuleMatched(option.visible_if_json, answers)
      && !(option.hidden_if_json && isRuleMatched(option.hidden_if_json, answers))) ? null : 'unavailable',
    visible,
    value,
    hasValue,
    option,
  };
}

function inspectSkuAnswer(question, answers, isCalibrated, { previousAnswers = {} } = {}) {
  const visible = !question.archived && isQuestionVisibleForSku(question, answers, isCalibrated);
  const value = answers[question.key];
  const hasValue = value !== undefined && value !== null && value !== '';
  const option = hasValue ? getContextualOption(question, value, answers) : null;
  const isPlaceholder = hasValue && isOptionalPlaceholderAnswer(question, value, option);
  let issue = null;

  if (Number(question.required) === 1 && visible && !hasValue) {
    issue = 'required';
  } else if (hasValue && option && !isOptionAvailable(option, answers)
    && !(option.archived && Object.hasOwn(previousAnswers, question.key)
      && String(previousAnswers[question.key]) === String(value)
      && isRuleMatched(option.visible_if_json, answers)
      && !(option.hidden_if_json && isRuleMatched(option.hidden_if_json, answers)))) {
    issue = 'unavailable';
  } else if (hasValue && !option && !isPlaceholder) {
    issue = 'unknown';
  }

  return { hasValue, isPlaceholder, issue, option, value, visible };
}

module.exports = {
  getContextualOption,
  inspectNonSkuAnswer,
  inspectSkuAnswer,
  isOptionAvailable,
};
