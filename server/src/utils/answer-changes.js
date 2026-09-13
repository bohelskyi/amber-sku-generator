function getAnswerChanges(previousAnswers = {}, nextAnswers = {}) {
  const keys = new Set([
    ...Object.keys(previousAnswers),
    ...Object.keys(nextAnswers),
  ]);

  return Array.from(keys)
    .filter((key) => String(previousAnswers[key] ?? '') !== String(nextAnswers[key] ?? ''))
    .map((key) => ({
      key,
      from: previousAnswers[key] ?? null,
      to: nextAnswers[key] ?? null,
    }));
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

function filterPresentableAnswerChanges(changes, { oldPayload, newPayload } = {}) {
  if (!Array.isArray(changes)) return [];
  return changes.filter((change) => !isPresentationalNoOp(change, oldPayload, newPayload));
}

module.exports = {
  filterPresentableAnswerChanges,
  getAnswerChanges,
};
