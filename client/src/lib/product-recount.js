import { physicalWeightPolicy, validateNumericInput } from './product-numeric-input.js';
import {
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
} from './sku-visibility.js';

const hasRecountAnswerValue = (value) => (
  value !== undefined && value !== null && String(value).trim() !== ''
);

const isOptionalPlaceholderAnswer = (question, value) => (
  Number(question?.required) !== 1
  && Number(question?.include_in_sku ?? 1) === 1
  && hasRecountAnswerValue(value)
  && String(value).trim() === '0'
  && !(question?.options || []).some((option) => String(option.id).trim() === '0')
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
  // Stored-history absence must not preselect the genuine SV processing zero.
  // The operator chooses it explicitly; the server validates the recount target.
  if (decoded?.decodeSource === 'stored_history' && decoded?.category?.code === 'SV'
    && !Object.hasOwn(storedAnswers, 'stone_processing')
    && decoded.decodedAnswers?.some((answer) => answer.key === 'stone_processing'
      && answer.is_placeholder === true && answer.value_id === null)) {
    delete nextAnswers.stone_processing;
  }
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

export function getRecountWeightState(decoded) {
  const answers = getDecodedAnswerMap(decoded);
  const physical = decoded?.product?.weight ?? (decoded?.suffix?.type === 'weight' ? decoded.suffix.value : null);
  const answer = answers.weight;
  const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';
  const policy = { ...physicalWeightPolicy, minInclusive: true };
  const physicalResult = present(physical) ? validateNumericInput(physical, policy) : null;
  const answerResult = present(answer) ? validateNumericInput(answer, policy) : null;
  const conflict = Boolean((physicalResult && !physicalResult.valid) || (answerResult && !answerResult.valid)
    || (physicalResult && answerResult && physicalResult.normalized !== answerResult.normalized));
  const single = physicalResult?.normalized ?? answerResult?.normalized;
  return { physical, answer, conflict, initialWeight: conflict || single == null ? '' : String(single) };
}

// Presentation hint only. The server checks the catalog and pricing rules again.
const INFORMATION_FIELDS_V1 = {
  BR: ['braclet_size'],
  NM: ['neckle_size'],
  KL: ['exact_size'],
  CH: ['bead_length', 'bead_width', 'rosary_length'],
  SV: ['size'],
};

export function getInformationOnlyPatch(decoded, answers, weight, submitMode = 'apply') {
  const category = decoded?.category?.code;
  const eligible = INFORMATION_FIELDS_V1[category] || [];
  if (submitMode !== 'apply' || !decoded?.product?.id || eligible.length === 0
      || getRecountWeightState(decoded).conflict
      || Number(String(weight).replace(',', '.')) !== getRecountSourceWeight(decoded)) return null;
  const previous = getDecodedAnswerMap(decoded);
  const keys = new Set([...Object.keys(previous), ...Object.keys(answers || {})]);
  const changed = [...keys].filter(
    (key) => String(previous[key] ?? '') !== String(answers?.[key] ?? '')
  );
  if (changed.length === 0 || changed.some((key) => !eligible.includes(key))) return null;
  return Object.fromEntries(changed.map((key) => [key, answers?.[key] ?? null]));
}

export function getCorrectionMarketingRoundingDefault(config, categoryCode) {
  const storedValue = config?.categories?.[categoryCode]?.marketing_rounding_enabled;
  return Number(storedValue ?? 1) !== 0;
}

export function haveRecountTargetChanged(decoded, answers, weight) {
  if (!decoded) return false;
  if (haveAnswersChanged(getDecodedAnswerMap(decoded), answers)) return true;
  if (Number(decoded.category?.requires_weight) !== 1 && !getRecountWeightState(decoded).conflict
      && !Object.hasOwn(getDecodedAnswerMap(decoded), 'weight')) return false;

  const nextWeight = String(weight ?? '').trim();
  const numeric = validateNumericInput(weight, { ...physicalWeightPolicy, minInclusive: true });
  return nextWeight === '' || !numeric.valid
    || getRecountWeightState(decoded).conflict || numeric.normalized !== getRecountSourceWeight(decoded);
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

function getDistinctTargetOptions(question, answers, previousAnswers = {}) {
  const inheritedQuestion = { ...question, options: (question.options || []).map((option) => (
    (option.archived === true || option.archived === 1)
      && Object.hasOwn(previousAnswers, question.id) && String(previousAnswers[question.id]) === String(option.id)
      ? { ...option, archived: false } : option
  )) };
  const distinctOptions = new Map();
  for (const option of getVisibleOptionsForQuestion(
    inheritedQuestion,
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
  retainedHiddenAnswers = {},
  { previousAnswers = {} } = {}
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
      if (question.archived === true || question.archived === 1) {
        if (Object.hasOwn(previousAnswers, questionId)) nextAnswers[questionId] = previousAnswers[questionId];
        else delete nextAnswers[questionId];
        continue;
      }
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

      if (isOptionalPlaceholderAnswer(question, selectedValue)) continue;
      if (!hasSelectedValue && isOptionalPlaceholderAnswer(question, retainedValue)) {
        nextAnswers[questionId] = retainedValue;
        changed = true;
        continue;
      }

      const targetOptions = getDistinctTargetOptions(question, nextAnswers, previousAnswers);
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
  const normalizedValue = String(value ?? '');
  return {
    ...previousAnswers,
    [question?.id]: normalizedValue.trim() === '' ? null : normalizedValue,
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

export function getDirectRecountManualPrice(preview, manualPriceUah) {
  const corrected = preview?.corrected;
  const hasAutomaticPrice = Number(corrected?.autoPriceUah) > 0
    || (!(Number(corrected?.manualPriceUah) > 0)
      && Number(corrected?.totalPriceUah) > 0);
  return hasAutomaticPrice ? null : manualPriceUah;
}

export function buildCorrectionRequestPayload(basePayload, pricingDecision, previewSignature) {
  const { manualPriceUah: _legacyManualPrice, ...requestPayload } = basePayload;
  return {
    ...requestPayload,
    pricingDecision,
    previewSignature,
  };
}
