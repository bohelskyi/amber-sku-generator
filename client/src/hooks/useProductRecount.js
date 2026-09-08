import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  RECOUNT_PREVIEW_DEBOUNCE_MS,
  buildRecountPayload,
  buildRecountPreviewPayload,
  createRecountPreviewGate,
  getDecodedAnswerMap,
  getRecountSourceWeight,
  haveRecountTargetChanged,
  normalizeRecountTargetState,
  updateRecountOptionAnswer,
  updateRecountTextAnswer,
} from '../lib/product-recount.js';
import { getRecountFieldBlockers } from '../lib/recount-blockers.js';

export function useProductRecount({
  config,
  onApplied,
  onRequestCreated,
  submitMode = 'apply',
} = {}) {
  const [skuToDecode, setSkuToDecode] = useState('');
  const [decodeData, setDecodeData] = useState(null);
  const [decodeError, setDecodeError] = useState('');
  const [decodeErrorDetails, setDecodeErrorDetails] = useState(null);
  const [isRecountOpen, setIsRecountOpen] = useState(false);
  const [recountTarget, setRecountTarget] = useState({
    answers: {},
    retainedHiddenAnswers: {},
  });
  const recountAnswers = recountTarget.answers;
  const [recountWeight, setRecountWeight] = useState('');
  const [recountReason, setRecountReason] = useState('');
  const [recountManualPriceUah, setRecountManualPriceUah] = useState('');
  const [recountPreview, setRecountPreview] = useState(null);
  const [recountError, setRecountError] = useState('');
  const [recountSuccess, setRecountSuccess] = useState('');
  const [isRecountLoading, setIsRecountLoading] = useState(false);
  const [isRecountApplying, setIsRecountApplying] = useState(false);
  const [recountSubmitMode, setRecountSubmitMode] = useState(null);
  const [isRecountConfirmOpen, setIsRecountConfirmOpen] = useState(false);
  const [recountValidationActive, setRecountValidationActive] = useState(false);
  const [recountValidationAttempt, setRecountValidationAttempt] = useState(0);
  const [recountValidationMessage, setRecountValidationMessage] = useState('');
  const [isRecountPreviewCurrent, setIsRecountPreviewCurrent] = useState(false);
  const [isRecountPreviewUnavailable, setIsRecountPreviewUnavailable] = useState(false);
  const previewRequestGateRef = useRef(createRecountPreviewGate());
  const previewRequestIdRef = useRef(0);
  const hasRecountChanges = Boolean(
    haveRecountTargetChanged(decodeData, recountAnswers, recountWeight)
  );
  const recountPreviewPayload = useMemo(() => buildRecountPreviewPayload({
    sourceSku: decodeData?.sku,
    answers: recountAnswers,
    isCalibrated: recountAnswers.is_calibrated ?? null,
    weight: recountWeight,
  }), [decodeData?.sku, recountAnswers, recountWeight]);
  const requiresRecountWeight = Number(decodeData?.category?.requires_weight) === 1;
  const recountBlockers = recountValidationActive
    ? getRecountFieldBlockers({
      questions: config?.questions?.[decodeData?.category?.code] || [],
      answers: recountAnswers,
      requiresWeight: requiresRecountWeight,
      serverMessage: recountValidationMessage,
      weight: recountWeight,
    })
    : [];

  const showRecountValidationFailure = (message = '') => {
    const hasMatchingField = getRecountFieldBlockers({
      questions: config?.questions?.[decodeData?.category?.code] || [],
      answers: recountAnswers,
      requiresWeight: requiresRecountWeight,
      serverMessage: message,
      weight: recountWeight,
    }).some((blocker) => blocker.message === message);
    if (!hasMatchingField) {
      setRecountValidationActive(false);
      setRecountValidationMessage('');
      return;
    }

    setRecountValidationActive(true);
    setRecountValidationMessage(message);
    setRecountValidationAttempt((attempt) => attempt + 1);
  };

  const handleDecode = (skuValue = skuToDecode) => {
    const normalizedSku = String(skuValue || '').trim().toUpperCase();
    if (!normalizedSku) {
      setDecodeData(null);
      setDecodeError('Введіть артикул для розшифровки.');
      setDecodeErrorDetails(null);
      return;
    }

    previewRequestGateRef.current.invalidate();
    api.post('/decode', { sku: normalizedSku })
      .then((res) => {
        setSkuToDecode(normalizedSku);
        setDecodeData(res.data);
        setDecodeError('');
        setDecodeErrorDetails(null);
        setIsRecountOpen(false);
        setIsRecountConfirmOpen(false);
        setRecountPreview(null);
        setIsRecountPreviewCurrent(false);
        setIsRecountPreviewUnavailable(false);
        setIsRecountLoading(false);
        setRecountError('');
        setRecountValidationActive(false);
        setRecountValidationMessage('');
      })
      .catch((err) => {
        setDecodeData(null);
        setDecodeError(err.response?.data?.error || err.message);
        setDecodeErrorDetails(err.response?.data?.details || null);
      });
  };

  const handleDecodeInputChange = (value) => {
    previewRequestGateRef.current.invalidate();
    setSkuToDecode(value.toUpperCase());
    setDecodeData(null);
    setDecodeError('');
    setDecodeErrorDetails(null);
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(false);
    setRecountError('');
    setRecountSuccess('');
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const handleStartRecount = () => {
    if (!decodeData?.existsInDb) {
      setRecountError('Переоблік доступний тільки для артикула, який є в базі.');
      return;
    }

    setRecountTarget({
      answers: getDecodedAnswerMap(decodeData),
      retainedHiddenAnswers: {},
    });
    setRecountWeight(String(getRecountSourceWeight(decodeData) || ''));
    setRecountReason('');
    setRecountManualPriceUah('');
    setRecountPreview(null);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(false);
    setRecountError('');
    setRecountSuccess('');
    setIsRecountConfirmOpen(false);
    setIsRecountOpen(true);
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const handleCancelRecount = () => {
    previewRequestGateRef.current.invalidate();
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(false);
    setRecountError('');
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const handleRecountAnswer = (questionId, valueId) => {
    const categoryQuestions = config?.questions?.[decodeData?.category?.code] || [];
    const question = categoryQuestions.find(
      (item) => item.id === questionId
    );
    setRecountTarget((previousTarget) => {
      const retainedHiddenAnswers = { ...previousTarget.retainedHiddenAnswers };
      delete retainedHiddenAnswers[questionId];
      return normalizeRecountTargetState(
        categoryQuestions,
        updateRecountOptionAnswer(previousTarget.answers, question, valueId),
        retainedHiddenAnswers
      );
    });
    previewRequestIdRef.current = previewRequestGateRef.current.invalidate();
    setIsRecountConfirmOpen(false);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(true);
    setRecountError('');
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const handleRecountTextAnswer = (questionId, value) => {
    const categoryQuestions = config?.questions?.[decodeData?.category?.code] || [];
    const question = categoryQuestions.find(
      (item) => item.id === questionId
    );

    setRecountTarget((previousTarget) => {
      const retainedHiddenAnswers = { ...previousTarget.retainedHiddenAnswers };
      delete retainedHiddenAnswers[questionId];
      return normalizeRecountTargetState(
        categoryQuestions,
        updateRecountTextAnswer(previousTarget.answers, question, value),
        retainedHiddenAnswers
      );
    });
    previewRequestIdRef.current = previewRequestGateRef.current.invalidate();
    setIsRecountConfirmOpen(false);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(true);
    setRecountError('');
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const handleRecountWeightChange = (value) => {
    setRecountWeight(value);
    previewRequestIdRef.current = previewRequestGateRef.current.invalidate();
    setIsRecountConfirmOpen(false);
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    setIsRecountLoading(true);
    setRecountError('');
    setRecountValidationActive(false);
    setRecountValidationMessage('');
  };

  const getRecountPayload = () => buildRecountPayload({
    sourceSku: decodeData?.sku,
    answers: recountAnswers,
    isCalibrated: recountAnswers.is_calibrated ?? null,
    weight: recountWeight,
    reason: recountReason,
    manualPriceUah: recountManualPriceUah,
  });

  const requestRecountPreview = ({ openConfirmation = false, surfaceValidation = false } = {}) => {
    if (!decodeData?.sku) return;
    if (!hasRecountChanges) {
      setRecountPreview(null);
      setIsRecountPreviewCurrent(false);
      const message = 'Для переобліку змініть хоча б один параметр виробу.';
      setRecountError(message);
      return;
    }
    setIsRecountLoading(true);
    setIsRecountConfirmOpen(false);
    setRecountError('');
    setRecountSuccess('');
    setIsRecountPreviewCurrent(false);
    setIsRecountPreviewUnavailable(false);
    const requestId = previewRequestGateRef.current.invalidate();
    previewRequestIdRef.current = requestId;

    api.post('/recount/preview', recountPreviewPayload)
      .then((res) => {
        if (requestId !== previewRequestIdRef.current
            || !previewRequestGateRef.current.isCurrent(requestId)) return;
        setRecountPreview(res.data);
        setIsRecountPreviewCurrent(true);
        setIsRecountPreviewUnavailable(false);
        setRecountValidationActive(false);
        setRecountValidationMessage('');
        if (openConfirmation) setIsRecountConfirmOpen(true);
      })
      .catch((err) => {
        if (requestId !== previewRequestIdRef.current
            || !previewRequestGateRef.current.isCurrent(requestId)) return;
        const message = err.response?.data?.error || err.message;
        setRecountPreview(null);
        setIsRecountPreviewCurrent(false);
        setIsRecountPreviewUnavailable(true);
        if (surfaceValidation) {
          setRecountError(message);
          showRecountValidationFailure(message);
        }
      })
      .finally(() => {
        if (requestId === previewRequestIdRef.current
            && previewRequestGateRef.current.isCurrent(requestId)) {
          setIsRecountLoading(false);
        }
      });
  };

  useEffect(() => {
    if (!isRecountOpen || !recountPreviewPayload.sourceSku) return undefined;
    if (!hasRecountChanges) {
      previewRequestIdRef.current = previewRequestGateRef.current.invalidate();
      const resetTimerId = window.setTimeout(() => {
        setRecountPreview(null);
        setIsRecountPreviewCurrent(false);
        setIsRecountPreviewUnavailable(false);
        setIsRecountLoading(false);
      }, 0);
      return () => window.clearTimeout(resetTimerId);
    }

    const requestId = previewRequestGateRef.current.invalidate();
    previewRequestIdRef.current = requestId;
    const timerId = window.setTimeout(() => {
      api.post('/recount/preview', recountPreviewPayload)
        .then((res) => {
          if (requestId !== previewRequestIdRef.current
              || !previewRequestGateRef.current.isCurrent(requestId)) return;
          setRecountPreview(res.data);
          setIsRecountPreviewCurrent(true);
          setIsRecountPreviewUnavailable(false);
          setRecountValidationActive(false);
          setRecountValidationMessage('');
        })
        .catch(() => {
          if (requestId !== previewRequestIdRef.current
              || !previewRequestGateRef.current.isCurrent(requestId)) return;
          setRecountPreview(null);
          setIsRecountPreviewCurrent(false);
          setIsRecountPreviewUnavailable(true);
        })
        .finally(() => {
          if (requestId === previewRequestIdRef.current
              && previewRequestGateRef.current.isCurrent(requestId)) {
            setIsRecountLoading(false);
          }
        });
    }, RECOUNT_PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timerId);
  }, [hasRecountChanges, isRecountOpen, recountPreviewPayload]);

  useEffect(() => () => {
    previewRequestGateRef.current.invalidate();
  }, []);

  const handleApplyRecount = () => {
    if (!decodeData?.sku || !hasRecountChanges || isRecountLoading) return;
    if (recountPreview && isRecountPreviewCurrent) {
      setIsRecountConfirmOpen(true);
      return;
    }
    requestRecountPreview({ openConfirmation: true, surfaceValidation: true });
  };

  const handleCancelRecountConfirmation = () => {
    if (!isRecountApplying) setIsRecountConfirmOpen(false);
  };

  const handleConfirmRecount = (requestedMode = submitMode) => {
    if (!decodeData?.sku || !recountPreview || !isRecountPreviewCurrent
        || !hasRecountChanges || isRecountApplying || isRecountLoading) return;
    const requiresManualPrice = !(Number(recountPreview.corrected?.totalPriceUah) > 0);
    if (requiresManualPrice && !(Number(recountManualPriceUah) > 0)) {
      setRecountError('Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.');
      return;
    }

    const sourceSku = decodeData.sku;
    const effectiveSubmitMode = requestedMode === 'request' ? 'request' : 'apply';
    setIsRecountApplying(true);
    setRecountSubmitMode(effectiveSubmitMode);
    setRecountError('');
    setRecountSuccess('');

    const isRequestMode = effectiveSubmitMode === 'request';
    api.post(
      isRequestMode ? '/admin/correction-requests' : '/recount/apply',
      getRecountPayload()
    )
      .then((res) => {
        setIsRecountConfirmOpen(false);
        setIsRecountOpen(false);
        setRecountPreview(null);
        if (isRequestMode) {
          const request = res.data.request;
          setRecountSuccess(`Створено запит на виправлення #${request.id}.`);
          Promise.resolve(onRequestCreated?.({ request, sourceSku })).catch(() => {});
          handleDecode(sourceSku);
          return;
        }

        const correctedSku = res.data.corrected.fullSku;
        setRecountSuccess(`Створено коригувальний артикул ${correctedSku}. Він не потрапить в експорт.`);
        Promise.resolve(onApplied?.({ result: res.data, sourceSku, correctedSku })).catch(() => {});
        handleDecode(correctedSku);
      })
      .catch((err) => {
        setRecountError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        setIsRecountApplying(false);
        setRecountSubmitMode(null);
      });
  };

  return {
    decodeData,
    decodeError,
    decodeErrorDetails,
    handleApplyRecount,
    handleCancelRecount,
    handleCancelRecountConfirmation,
    handleConfirmRecount,
    handleDecode,
    handleDecodeInputChange,
    handleRecountAnswer,
    handleRecountTextAnswer,
    handleRecountWeightChange,
    handleStartRecount,
    hasRecountChanges,
    isRecountApplying,
    isRecountConfirmOpen,
    isRecountLoading,
    isRecountOpen,
    isRecountPreviewCurrent,
    isRecountPreviewUnavailable,
    recountAnswers,
    recountBlockers,
    recountError,
    recountManualPriceUah,
    recountPreview,
    recountReason,
    recountSubmitMode,
    recountSuccess,
    recountValidationAttempt,
    recountWeight,
    setRecountReason,
    setRecountManualPriceUah,
    skuToDecode,
  };
}
