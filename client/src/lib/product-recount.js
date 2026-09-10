import {
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
} from './sku-visibility.js';

const hasRecountAnswerValue = (value) => (
  value !== undefined && value !== null && String(value).trim() !== ''
);

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

function normalizePricingDependencyState(pricingDetails) {
  return {
    dependentKeys: Array.isArray(pricingDetails?.dependentKeys)
      ? pricingDetails.dependentKeys
      : [],
    usesWeight: Boolean(pricingDetails?.usesWeight),
  };
}

export function getRecountPricingDependencyState({
  currentPricing,
  hasRecountChanges = false,
  isRecountPreviewUnavailable = false,
  recountPreview,
} = {}) {
  if (isRecountPreviewUnavailable) {
    return { dependentKeys: [], usesWeight: false };
  }

  if (hasRecountChanges && recountPreview) {
    return normalizePricingDependencyState(recountPreview.corrected?.pricingDetails);
  }

  return normalizePricingDependencyState(currentPricing);
}

function getDistinctTargetOptions(question, answers) {
  const distinctOptions = new Map();
  for (const option of getVisibleOptionsForQuestion(
    question,
    answers,
    answers.is_calibrated ?? null
  )) {
    if (option.id === undefined || option.id === null) continue;
    const valueKey = String(option.id);
    if (!distinctOptions.has(valueKey)) distinctOptions.set(valueKey, option);
  }
  return [...distinctOptions.values()];
}

function getRecountAnswerStateKey(answers) {
  return JSON.stringify(
    Object.keys(answers).sort().map((key) => [key, answers[key]])
  );
}

export function normalizeRecountTargetState(
  questions,
  answers,
  retainedHiddenAnswers = {}
) {
  const categoryQuestions = Array.isArray(questions) ? questions : [];
  const nextAnswers = { ...(answers || {}) };
  const nextRetainedHiddenAnswers = { ...(retainedHiddenAnswers || {}) };
  const autoEligibleQuestionIds = new Set(
    categoryQuestions
      .filter((question) => !isTextQuestion(question))
      .filter((question) => (
        hasRecountAnswerValue(nextAnswers[question.id])
        || hasRecountAnswerValue(nextRetainedHiddenAnswers[question.id])
      ))
      .map((question) => question.id)
  );
  const affectedQuestionIds = new Set();
  const seenStates = new Set();
  const optionCount = categoryQuestions.reduce(
    (count, question) => count + (question.options?.length || 0),
    0
  );
  const maxIterations = Math.max(4, categoryQuestions.length + optionCount + 1);
  let allowAutoSelection = true;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let stateKey = getRecountAnswerStateKey(nextAnswers);
    if (seenStates.has(stateKey)) {
      if (!allowAutoSelection) {
        return { answers: nextAnswers, retainedHiddenAnswers: nextRetainedHiddenAnswers };
      }

      allowAutoSelection = false;
      seenStates.clear();
      let resetAffectedAnswer = false;
      for (const questionId of affectedQuestionIds) {
        if (nextAnswers[questionId] !== null) {
          nextAnswers[questionId] = null;
          resetAffectedAnswer = true;
        }
      }
      if (!resetAffectedAnswer) {
        return { answers: nextAnswers, retainedHiddenAnswers: nextRetainedHiddenAnswers };
      }
      stateKey = getRecountAnswerStateKey(nextAnswers);
    }
    seenStates.add(stateKey);

    let changed = false;
    for (const question of categoryQuestions) {
      const questionId = question.id;
      const selectedValue = nextAnswers[questionId];
      const hasSelectedValue = hasRecountAnswerValue(selectedValue);
      const isVisible = isQuestionVisible(
        question,
        nextAnswers,
        nextAnswers.is_calibrated ?? null
      );

      if (!isVisible) {
        if (hasSelectedValue) {
          nextRetainedHiddenAnswers[questionId] = selectedValue;
          nextAnswers[questionId] = null;
          affectedQuestionIds.add(questionId);
          changed = true;
        }
        continue;
      }

      const retainedValue = nextRetainedHiddenAnswers[questionId];
      const hasRetainedValue = hasRecountAnswerValue(retainedValue);

      if (isTextQuestion(question)) continue;

      const targetOptions = getDistinctTargetOptions(question, nextAnswers);
      const retainedSelectionIsValid = hasRetainedValue && targetOptions.some(
        (option) => String(option.id) === String(retainedValue)
      );
      const isCalibrationContext = questionId === 'is_calibrated'
        || question.key === 'is_calibrated';
      if (
        isCalibrationContext
        && !hasSelectedValue
        && retainedSelectionIsValid
      ) {
        nextAnswers[questionId] = retainedValue;
        affectedQuestionIds.add(questionId);
        changed = true;
        continue;
      }

      const selectionIsValid = hasSelectedValue && targetOptions.some(
        (option) => String(option.id) === String(selectedValue)
      );
      if (selectionIsValid) continue;

      if (hasSelectedValue) {
        autoEligibleQuestionIds.add(questionId);
        affectedQuestionIds.add(questionId);
      }
      if (!autoEligibleQuestionIds.has(questionId)) continue;

      const normalizedValue = allowAutoSelection && targetOptions.length === 1
        ? targetOptions[0].id
        : null;
      if (String(selectedValue ?? '') !== String(normalizedValue ?? '')) {
        nextAnswers[questionId] = normalizedValue;
        affectedQuestionIds.add(questionId);
        changed = true;
      }
    }

    if (!changed) {
      return { answers: nextAnswers, retainedHiddenAnswers: nextRetainedHiddenAnswers };
    }
  }

  for (const questionId of affectedQuestionIds) nextAnswers[questionId] = null;
  return { answers: nextAnswers, retainedHiddenAnswers: nextRetainedHiddenAnswers };
}

export function normalizeRecountTargetAnswers(questions, answers) {
  return normalizeRecountTargetState(questions, answers).answers;
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
