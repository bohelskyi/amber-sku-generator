export function getQuestionLabel(config, categoryCode, key) {
  const question = (config?.questions?.[categoryCode] || []).find((item) => item.id === key);
  return question?.label
    || config?.extraConfig?.[key]?.label
    || (key === 'is_calibrated' ? 'Калібрування' : key);
}

function isAbsentAnswerValue(value) {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

function isZeroAnswerValue(value) {
  return !isAbsentAnswerValue(value) && String(value).trim() === '0';
}

function hasPlaceholderEvidence(payload, key) {
  return (Array.isArray(payload?.decodedAnswers) ? payload.decodedAnswers : [])
    .some((answer) => (
      String(answer?.key) === String(key)
      && (answer?.is_placeholder === true || answer?.value_id === null)
    ));
}

function isPresentationalNoOp(change, oldPayload, newPayload) {
  const fromAbsent = isAbsentAnswerValue(change?.from);
  const toAbsent = isAbsentAnswerValue(change?.to);
  if (fromAbsent && toAbsent) return true;
  if (!fromAbsent && !toAbsent && String(change.from) === String(change.to)) return true;

  if (isZeroAnswerValue(change?.from) && toAbsent) {
    return hasPlaceholderEvidence(oldPayload, change.key);
  }
  if (fromAbsent && isZeroAnswerValue(change?.to)) {
    return hasPlaceholderEvidence(newPayload, change.key);
  }
  return false;
}

export function filterPresentableAnswerChanges(changes, { oldPayload, newPayload } = {}) {
  if (!Array.isArray(changes)) return [];
  return changes.filter((change) => !isPresentationalNoOp(change, oldPayload, newPayload));
}

export function getAnswerValueLabel(config, categoryCode, key, value) {
  const question = (config?.questions?.[categoryCode] || []).find((item) => item.id === key);
  if (isAbsentAnswerValue(value)) {
    return question && question.required !== 1 ? 'Не обрано' : 'Невідомо';
  }
  const options = question?.options || config?.extraConfig?.[key]?.options || [];
  const option = options.find((item) => Number(item.id) === Number(value));
  if (option) return option.label;
  if (question?.required !== 1 && isZeroAnswerValue(value)) return 'Не обрано';
  return String(value);
}
