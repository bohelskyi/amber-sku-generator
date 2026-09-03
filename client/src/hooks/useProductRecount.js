import { useState } from 'react';
import { api } from '../lib/api.js';
import {
  buildRecountPayload,
  getDecodedAnswerMap,
  haveAnswersChanged,
} from '../lib/product-recount.js';

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
  const [recountAnswers, setRecountAnswers] = useState({});
  const [recountReason, setRecountReason] = useState('');
  const [recountManualPriceUah, setRecountManualPriceUah] = useState('');
  const [recountPreview, setRecountPreview] = useState(null);
  const [recountError, setRecountError] = useState('');
  const [recountSuccess, setRecountSuccess] = useState('');
  const [isRecountLoading, setIsRecountLoading] = useState(false);
  const [isRecountApplying, setIsRecountApplying] = useState(false);
  const [recountSubmitMode, setRecountSubmitMode] = useState(null);
  const [isRecountConfirmOpen, setIsRecountConfirmOpen] = useState(false);
  const hasRecountChanges = Boolean(
    decodeData && haveAnswersChanged(getDecodedAnswerMap(decodeData), recountAnswers)
  );

  const handleDecode = (skuValue = skuToDecode) => {
    const normalizedSku = String(skuValue || '').trim().toUpperCase();
    if (!normalizedSku) {
      setDecodeData(null);
      setDecodeError('Введіть артикул для розшифровки.');
      setDecodeErrorDetails(null);
      return;
    }

    api.post('/decode', { sku: normalizedSku })
      .then((res) => {
        setSkuToDecode(normalizedSku);
        setDecodeData(res.data);
        setDecodeError('');
        setDecodeErrorDetails(null);
        setIsRecountOpen(false);
        setIsRecountConfirmOpen(false);
        setRecountPreview(null);
        setRecountError('');
      })
      .catch((err) => {
        setDecodeData(null);
        setDecodeError(err.response?.data?.error || err.message);
        setDecodeErrorDetails(err.response?.data?.details || null);
      });
  };

  const handleDecodeInputChange = (value) => {
    setSkuToDecode(value.toUpperCase());
    setDecodeData(null);
    setDecodeError('');
    setDecodeErrorDetails(null);
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
    setRecountSuccess('');
  };

  const handleStartRecount = () => {
    if (!decodeData?.existsInDb) {
      setRecountError('Переоблік доступний тільки для артикула, який є в базі.');
      return;
    }

    setRecountAnswers(getDecodedAnswerMap(decodeData));
    setRecountReason('');
    setRecountManualPriceUah('');
    setRecountPreview(null);
    setRecountError('');
    setRecountSuccess('');
    setIsRecountConfirmOpen(false);
    setIsRecountOpen(true);
  };

  const handleCancelRecount = () => {
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
  };

  const handleRecountAnswer = (questionId, valueId) => {
    const question = config?.questions?.[decodeData?.category?.code]?.find(
      (item) => item.id === questionId
    );
    const selectedValue = Number(valueId);

    setRecountAnswers((previousAnswers) => {
      const shouldClear = question?.required !== 1
        && selectedValue !== 0
        && Number(previousAnswers[questionId] || 0) === selectedValue;
      return { ...previousAnswers, [questionId]: shouldClear ? 0 : selectedValue };
    });
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
  };

  const handleRecountTextAnswer = (questionId, value) => {
    const question = config?.questions?.[decodeData?.category?.code]?.find(
      (item) => item.id === questionId
    );

    setRecountAnswers((previousAnswers) => {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        const nextAnswers = { ...previousAnswers };
        if (question?.required === 1) delete nextAnswers[questionId];
        else nextAnswers[questionId] = 0;
        return nextAnswers;
      }
      return { ...previousAnswers, [questionId]: normalizedValue };
    });
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
  };

  const getRecountPayload = () => buildRecountPayload({
    sourceSku: decodeData?.sku,
    answers: recountAnswers,
    isCalibrated: recountAnswers.is_calibrated ?? null,
    reason: recountReason,
    manualPriceUah: recountManualPriceUah,
  });

  const requestRecountPreview = (openConfirmation = false) => {
    if (!decodeData?.sku) return;
    if (!hasRecountChanges) {
      setRecountPreview(null);
      setRecountError('Для переобліку змініть хоча б один параметр виробу.');
      return;
    }
    setIsRecountLoading(true);
    setIsRecountConfirmOpen(false);
    setRecountError('');
    setRecountSuccess('');

    api.post('/recount/preview', getRecountPayload())
      .then((res) => {
        setRecountPreview(res.data);
        if (openConfirmation) setIsRecountConfirmOpen(true);
      })
      .catch((err) => {
        setRecountPreview(null);
        setRecountError(err.response?.data?.error || err.message);
      })
      .finally(() => setIsRecountLoading(false));
  };

  const handleRecountPreview = () => {
    if (!isRecountLoading) requestRecountPreview(false);
  };

  const handleApplyRecount = () => {
    if (!decodeData?.sku || !hasRecountChanges || isRecountLoading) return;
    if (recountPreview) {
      setIsRecountConfirmOpen(true);
      return;
    }
    requestRecountPreview(true);
  };

  const handleCancelRecountConfirmation = () => {
    if (!isRecountApplying) setIsRecountConfirmOpen(false);
  };

  const handleConfirmRecount = (requestedMode = submitMode) => {
    if (!decodeData?.sku || !recountPreview || !hasRecountChanges || isRecountApplying) return;
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
    handleRecountPreview,
    handleRecountTextAnswer,
    handleStartRecount,
    hasRecountChanges,
    isRecountApplying,
    isRecountConfirmOpen,
    isRecountLoading,
    isRecountOpen,
    recountAnswers,
    recountError,
    recountManualPriceUah,
    recountPreview,
    recountReason,
    recountSubmitMode,
    recountSuccess,
    setRecountReason,
    setRecountManualPriceUah,
    skuToDecode,
  };
}
