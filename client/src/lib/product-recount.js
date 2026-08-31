export function getDecodedAnswerMap(decoded) {
  const decodedMap = (decoded?.decodedAnswers || []).reduce((result, answer) => {
    result[answer.key] = answer.value_id === null ? 0 : answer.value_id;
    return result;
  }, {});
  const storedAnswers =
    decoded?.product?.details?.answers && typeof decoded.product.details.answers === 'object'
      ? decoded.product.details.answers
      : {};
  const nextAnswers = { ...decodedMap, ...storedAnswers };
  const storedCalibrated = decoded?.product?.details?.isCalibrated;
  if (storedCalibrated !== undefined && storedCalibrated !== null) {
    nextAnswers.is_calibrated = storedCalibrated;
  }
  return nextAnswers;
}

export function haveAnswersChanged(previousAnswers, nextAnswers) {
  const keys = new Set([
    ...Object.keys(previousAnswers || {}),
    ...Object.keys(nextAnswers || {}),
  ]);

  return Array.from(keys).some(
    (key) => String(previousAnswers?.[key] ?? '') !== String(nextAnswers?.[key] ?? '')
  );
}

export function buildRecountPayload({
  sourceSku,
  answers,
  isCalibrated,
  reason,
  manualPriceUah,
}) {
  return {
    sourceSku,
    answers,
    isCalibrated,
    reason,
    manualPriceUah: manualPriceUah === '' ? null : Number(manualPriceUah),
  };
}
