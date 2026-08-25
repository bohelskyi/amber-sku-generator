import { hasRuleConditions, isRuleMatched } from './rules.js';

export const isTextQuestion = (question) => (question?.input_type || 'options') === 'text';

export const isVisibilityRuleMatched = isRuleMatched;

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
    const hiddenRule = option.hidden_if_json;
    const isExplicitlyHidden = hasRuleConditions(hiddenRule)
      && isVisibilityRuleMatched(hiddenRule, context);

    return isVisibilityRuleMatched(option.visible_if_json, context) && !isExplicitlyHidden;
  });
};
