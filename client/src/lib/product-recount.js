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

export const RECOUNT_PREVIEW_DEBOUNCE_MS = 350;

export function getRecountSourceWeight(decoded) {
  const storedWeight = decoded?.product?.weight;
  if (storedWeight !== null && storedWeight !== undefined && Number(storedWeight) > 0) {
    return Number(storedWeight);
  }
  if (decoded?.suffix?.type === 'weight' && decoded.suffix.value !== null) {
    return Number(decoded.suffix.value);
  }
  return 0;
}

export function haveRecountTargetChanged(decoded, answers, weight) {
  if (!decoded) return false;
  if (haveAnswersChanged(getDecodedAnswerMap(decoded), answers)) return true;
  if (Number(decoded.category?.requires_weight) !== 1) return false;

  const nextWeight = String(weight ?? '').trim();
  return nextWeight === '' || Number(nextWeight) !== getRecountSourceWeight(decoded);
}

export function createRecountPreviewGate() {
  let latestRequestId = 0;
  return {
    invalidate() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent(requestId) {
      return requestId === latestRequestId;
    },
  };
}

export function updateRecountOptionAnswer(previousAnswers, question, valueId) {
  const questionId = question?.id;
  if (valueId === null || valueId === undefined || valueId === '') {
    return { ...previousAnswers, [questionId]: null };
  }

  const selectedValue = Number(valueId);
  const previousValue = previousAnswers?.[questionId];
  const hadPreviousValue = previousValue !== undefined
    && previousValue !== null
    && String(previousValue).trim() !== '';
  const shouldClear = question?.required !== 1
    && hadPreviousValue
    && Number(previousValue) === selectedValue;
  return {
    ...previousAnswers,
    [questionId]: shouldClear ? null : selectedValue,
  };
}

export function updateRecountTextAnswer(previousAnswers, question, value) {
  const normalizedValue = String(value || '').trim();
  return {
    ...previousAnswers,
    [question?.id]: normalizedValue || null,
  };
}

export function buildRecountPayload({
  sourceSku,
  answers,
  isCalibrated,
  weight,
  reason,
  manualPriceUah,
}) {
  const manualPriceText = String(manualPriceUah ?? '').trim();
  return {
    sourceSku,
    answers,
    isCalibrated,
    ...(weight !== undefined ? { weight } : {}),
    reason,
    manualPriceUah: manualPriceText === '' ? null : Number(manualPriceUah),
  };
}

export function buildRecountPreviewPayload({
  sourceSku,
  answers,
  isCalibrated,
  weight,
}) {
  return buildRecountPayload({
    sourceSku,
    answers,
    isCalibrated,
    weight,
    reason: '',
    manualPriceUah: null,
  });
}
