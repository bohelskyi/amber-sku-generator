import { getAnswerValueLabel } from './answer-labels.js';
import { isQuestionVisible } from './sku-visibility.js';

const isAbsentValue = (value) => value === null || value === undefined
  || (typeof value === 'string' && value.trim() === '');

function getDecodedAnswer(payload, key) {
  return payload?.decodedAnswers?.find((answer) => answer.key === key);
}

// Historical schema evidence takes precedence over today's catalog and labels.
// Never infer absence from numeric zero or from a translated display string.
export function shouldPresentDecodedAnswer(answer) {
  return answer.is_placeholder !== true
    && (answer.is_placeholder === false || !isAbsentValue(answer.value_id));
}

function isAbsentAnswer(value, key, payload) {
  if (isAbsentValue(value)) return true;
  const decoded = getDecodedAnswer(payload, key);
  return decoded && decoded.is_placeholder !== false
    && (decoded.is_placeholder === true || decoded.value_id === null)
    && String(value).trim() === '0';
}

export function getPresentableRecountChanges(changes, { config, categoryCode, source, target } = {}) {
  return (Array.isArray(changes) ? changes : [])
    .filter((change) => {
      const fromAbsent = isAbsentAnswer(change.from, change.key, source);
      const toAbsent = isAbsentAnswer(change.to, change.key, target);
      if (fromAbsent && toAbsent) return false;
      if (!fromAbsent && !toAbsent && String(change.from) === String(change.to)) return false;

      const question = config?.questions?.[categoryCode]?.find((item) => item.id === change.key);
      // A removed answer under a hidden target question is target cleanup.
      // With no visibility evidence, retain the change rather than guess.
      return !(toAbsent && question && target?.answers
        && isAbsentValue(target.answers[change.key])
        && !isQuestionVisible(question, target.answers, target.answers.is_calibrated ?? null));
    });
}

export function getPresentedAnswerLabel(config, categoryCode, key, value, payload) {
  if (isAbsentAnswer(value, key, payload)) return getAnswerValueLabel(config, categoryCode, key, null);
  const decoded = getDecodedAnswer(payload, key);
  if (decoded && shouldPresentDecodedAnswer(decoded)
      && String(decoded.value_id) === String(value) && decoded.value_label !== undefined) {
    return decoded.value_label;
  }
  const question = config?.questions?.[categoryCode]?.find((item) => item.id === key);
  const options = question?.options || config?.extraConfig?.[key]?.options || [];
  return options.find((option) => String(option.id) === String(value))?.label ?? String(value);
}
