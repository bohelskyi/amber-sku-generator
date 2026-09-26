import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  RECOUNT_PREVIEW_DEBOUNCE_MS,
  buildRecountPayload,
  buildRecountPreviewPayload,
  buildCorrectionRequestPayload,
  createRecountPreviewGate,
  getCorrectionMarketingRoundingDefault,
  getDecodedAnswerMap,
  getDirectRecountManualPrice,
  getInformationOnlyPatch,
  getRecountSourceWeight,
  haveRecountTargetChanged,
  normalizeRecountTargetState,
  updateRecountOptionAnswer,
  updateRecountTextAnswer,
} from '../lib/product-recount.js';
import { getRecountFieldBlockers } from '../lib/recount-blockers.js';

export function useProductRecount({
  canChangeProductPrice = false,
  canApplyDirectPriceChange = canChangeProductPrice,
  canCreatePriceChangeRequest = false,
  canPriceOverride = false,
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
  const [recountPricingMode, setRecountPricingMode] = useState('system_auto');
  const [recountUsdPerGram, setRecountUsdPerGram] = useState('');
  const [recountMarketingRounding, setRecountMarketingRounding] = useState(true);
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
  const [isPriceChangeOpen, setIsPriceChangeOpen] = useState(false);
  const [priceChangeMode, setPriceChangeMode] = useState('manual_uah');
  const [priceChangeManualUah, setPriceChangeManualUah] = useState('');
  const [priceChangeManualRounding, setPriceChangeManualRounding] = useState(false);
  const [priceChangeUsdPerGram, setPriceChangeUsdPerGram] = useState('');
  const [priceChangeMarketingRounding, setPriceChangeMarketingRounding] = useState(true);
  const [priceChangePreview, setPriceChangePreview] = useState(null);
  const [priceChangeError, setPriceChangeError] = useState('');
  const [isPriceChangeLoading, setIsPriceChangeLoading] = useState(false);
  const [isPriceChangeApplying, setIsPriceChangeApplying] = useState(false);
  const previewRequestGateRef = useRef(createRecountPreviewGate());
  const previewRequestIdRef = useRef(0);
  const priceChangeRequestIdRef = useRef(0);
  const hasRecountChanges = Boolean(
    isRecountOpen && haveRecountTargetChanged(decodeData, recountAnswers, recountWeight)
  );
  const informationPatch = getInformationOnlyPatch(
    decodeData, recountAnswers, recountWeight, submitMode
  );
  const isInformationOnly = Boolean(informationPatch);
  const useDecisionPreview = canPriceOverride && submitMode !== 'apply';
  const pricingDecision = useMemo(() => {
    if (recountPricingMode === 'usd_per_gram') return {
      mode: 'usd_per_gram',
      usdPerGram: recountUsdPerGram,
      marketingRoundingEnabled: recountMarketingRounding,
    };
    if (recountPricingMode === 'manual_uah') return {
      mode: 'manual_uah', manualPriceUah: recountManualPriceUah,
    };
    return { mode: 'system_auto' };
  }, [recountPricingMode, recountUsdPerGram, recountMarketingRounding, recountManualPriceUah]);
  const priceChangeDecision = useMemo(() => {
    if (priceChangeMode === 'system_auto') return { mode: 'system_auto' };
    return priceChangeMode === 'usd_per_gram'
      ? {
        mode: 'usd_per_gram',
        usdPerGram: priceChangeUsdPerGram,
        marketingRoundingEnabled: priceChangeMarketingRounding,
      }
      : {
        mode: 'manual_uah',
        manualPriceUah: priceChangeManualUah,
        marketingRoundingEnabled: priceChangeManualRounding,
      };
  }, [
    priceChangeManualUah,
    priceChangeManualRounding,
    priceChangeMarketingRounding,
    priceChangeMode,
    priceChangeUsdPerGram,
  ]);
  const recountPreviewPayload = useMemo(() => {
    const basePayload = buildRecountPreviewPayload({
      sourceSku: decodeData?.sku,
      answers: recountAnswers,
      isCalibrated: recountAnswers.is_calibrated ?? null,
      weight: recountWeight,
    });
    if (!useDecisionPreview) return basePayload;
    const { manualPriceUah: _legacyManualPrice, ...decisionPayload } = basePayload;
    return { ...decisionPayload, pricingDecision };
  }, [decodeData?.sku, recountAnswers, recountWeight, useDecisionPreview, pricingDecision]);
  const previewPath = useDecisionPreview
    ? '/admin/correction-requests/preview' : '/recount/preview';
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
    priceChangeRequestIdRef.current += 1;
    api.post('/decode', { sku: normalizedSku })
      .then((res) => {
        setSkuToDecode(normalizedSku);
        setDecodeData(res.data);
        setDecodeError('');
        setDecodeErrorDetails(null);
        setIsRecountOpen(false);
        setIsRecountConfirmOpen(false);
        setIsPriceChangeOpen(false);
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
    priceChangeRequestIdRef.current += 1;
    setSkuToDecode(value.toUpperCase());
    setDecodeData(null);
    setDecodeError('');
    setDecodeErrorDetails(null);
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setIsPriceChangeOpen(false);
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
    setRecountPricingMode('system_auto');
    setRecountUsdPerGram('');
    setRecountMarketingRounding(getCorrectionMarketingRoundingDefault(
      config,
      decodeData?.category?.code
    ));
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
    priceChangeRequestIdRef.current += 1;
    setIsRecountOpen(false);
    setIsRecountConfirmOpen(false);
    setIsPriceChangeOpen(false);
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

  const getRecountPayload = (requestMode = false) => {
    const payload = buildRecountPayload({
      sourceSku: decodeData?.sku,
      answers: recountAnswers,
      isCalibrated: recountAnswers.is_calibrated ?? null,
      weight: recountWeight,
      reason: recountReason,
      manualPriceUah: getDirectRecountManualPrice(
        recountPreview,
        recountManualPriceUah
      ),
    });
    if (!requestMode) payload.sourceStateSignature = recountPreview?.source?.stateSignature;
    return requestMode && useDecisionPreview
      ? buildCorrectionRequestPayload(payload, pricingDecision, recountPreview?.previewSignature)
      : payload;
  };

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

    api.post(previewPath, recountPreviewPayload)
      .then((res) => {
        if (requestId !== previewRequestIdRef.current
            || !previewRequestGateRef.current.isCurrent(requestId)) return;
        setRecountPreview(res.data);
        setRecountError('');
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
    if (isInformationOnly) {
      previewRequestIdRef.current = previewRequestGateRef.current.invalidate();
      const resetTimerId = window.setTimeout(() => {
        setRecountPreview(null);
        setIsRecountPreviewCurrent(false);
        setIsRecountPreviewUnavailable(false);
        setIsRecountLoading(false);
      }, 0);
      return () => window.clearTimeout(resetTimerId);
    }
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
      api.post(previewPath, recountPreviewPayload)
        .then((res) => {
          if (requestId !== previewRequestIdRef.current
              || !previewRequestGateRef.current.isCurrent(requestId)) return;
          setRecountPreview(res.data);
          setRecountError('');
          setIsRecountPreviewCurrent(true);
          setIsRecountPreviewUnavailable(false);
          setRecountValidationActive(false);
          setRecountValidationMessage('');
        })
        .catch(() => {
          if (requestId !== previewRequestIdRef.current
              || !previewRequestGateRef.current.isCurrent(requestId)) return;
          if (!isRecountConfirmOpen) setRecountPreview(null);
          setIsRecountPreviewCurrent(false);
          setIsRecountPreviewUnavailable(true);
          if (isRecountConfirmOpen) setRecountError('Вкажіть коректну ціну для вибраного режиму.');
        })
        .finally(() => {
          if (requestId === previewRequestIdRef.current
              && previewRequestGateRef.current.isCurrent(requestId)) {
            setIsRecountLoading(false);
          }
        });
    }, RECOUNT_PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timerId);
  }, [hasRecountChanges, isInformationOnly, isRecountOpen,
    recountPreviewPayload, previewPath, isRecountConfirmOpen]);

  useEffect(() => () => {
    previewRequestGateRef.current.invalidate();
  }, []);

  useEffect(() => {
    if (!isPriceChangeOpen || !decodeData?.product?.id) return undefined;
    const value = priceChangeMode === 'usd_per_gram'
      ? priceChangeUsdPerGram : priceChangeManualUah;
    const scale = priceChangeMode === 'usd_per_gram' ? 4 : 2;
    const normalized = String(value ?? '').trim().replace(',', '.');
    const amount = Number(normalized);
    const valid = priceChangeMode === 'system_auto'
      || (/^\d+(?:\.\d+)?$/.test(normalized)
        && Number.isFinite(amount) && amount > 0
        && Number(amount.toFixed(scale)) === amount);
    const requestId = ++priceChangeRequestIdRef.current;
    if (!valid) {
      const resetTimerId = window.setTimeout(() => {
        setPriceChangePreview(null);
        setIsPriceChangeLoading(false);
      }, 0);
      return () => window.clearTimeout(resetTimerId);
    }

    const timerId = window.setTimeout(() => {
      setIsPriceChangeLoading(true);
      setPriceChangePreview(null);
      setPriceChangeError('');
      api.post(canApplyDirectPriceChange
        ? '/product-price-change/preview'
        : '/admin/correction-requests/preview', {
        ...(!canApplyDirectPriceChange ? { requestType: 'price_change' } : {}),
        productId: decodeData.product.id,
        pricingDecision: priceChangeDecision,
      })
        .then((res) => {
          if (requestId !== priceChangeRequestIdRef.current) return;
          setPriceChangePreview(res.data);
          setPriceChangeError('');
        })
        .catch((err) => {
          if (requestId !== priceChangeRequestIdRef.current) return;
          setPriceChangePreview(null);
          setPriceChangeError(err.response?.data?.error || err.message);
        })
        .finally(() => {
          if (requestId === priceChangeRequestIdRef.current) {
            setIsPriceChangeLoading(false);
          }
        });
    }, RECOUNT_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timerId);
  }, [
    decodeData?.product?.id,
    canApplyDirectPriceChange,
    isPriceChangeOpen,
    priceChangeDecision,
    priceChangeManualUah,
    priceChangeMode,
    priceChangeUsdPerGram,
  ]);

  const handleApplyRecount = () => {
    if (!decodeData?.sku) return;
    if (isInformationOnly && !isRecountApplying) {
      const sourceSku = decodeData.sku;
      const productId = decodeData.product.id;
      const answersPatch = informationPatch;
      setIsRecountApplying(true);
      setRecountError('');
      api.post('/product-information/preview', { productId, answersPatch })
        .then(async (res) => {
          const accepted = window.confirm(
            `Оновити лише інформаційні характеристики ${sourceSku}? `
            + 'SKU, товар і ціна залишаться тими самими.'
          );
          if (!accepted) return;
          const applied = await api.post('/product-information/apply', {
            productId, answersPatch, previewToken: res.data.previewToken,
            reason: recountReason,
          });
          setIsRecountOpen(false);
          const guidance = applied.data.exportGuidance?.mode;
          setRecountSuccess(guidance === 'reexport'
            ? `Характеристики ${sourceSku} оновлено. Для вже представленого товару створіть окремий Magento-знімок цього SKU.`
            : guidance === 'excluded'
              ? `Характеристики ${sourceSku} оновлено. Товар виключений з експорту.`
              : `Характеристики ${sourceSku} оновлено. Товар увійде до наступного звичайного експорту.`);
          Promise.resolve(onApplied?.({ result: applied.data, sourceSku,
            correctedSku: sourceSku, informationOnly: true })).catch(() => {});
          handleDecode(sourceSku);
        })
        .catch((err) => setRecountError(err.response?.data?.error || err.message))
        .finally(() => setIsRecountApplying(false));
      return;
    }
    if (!hasRecountChanges) {
      if (!canChangeProductPrice || isPriceChangeApplying) return;
      priceChangeRequestIdRef.current += 1;
      setPriceChangeMode(
        canApplyDirectPriceChange || canPriceOverride ? 'manual_uah' : 'system_auto'
      );
      setPriceChangeManualUah('');
      setPriceChangeManualRounding(false);
      setPriceChangeUsdPerGram('');
      setPriceChangeMarketingRounding(getCorrectionMarketingRoundingDefault(
        config,
        decodeData?.category?.code
      ));
      setPriceChangePreview(null);
      setPriceChangeError('');
      setIsPriceChangeLoading(false);
      setIsPriceChangeOpen(true);
      return;
    }
    if (isRecountLoading) return;
    if (recountPreview && isRecountPreviewCurrent) {
      setIsRecountConfirmOpen(true);
      return;
    }
    requestRecountPreview({ openConfirmation: true, surfaceValidation: true });
  };

  const handleCancelRecountConfirmation = () => {
    if (!isRecountApplying) setIsRecountConfirmOpen(false);
  };

  const handleCancelPriceChange = () => {
    if (isPriceChangeApplying) return;
    priceChangeRequestIdRef.current += 1;
    setIsPriceChangeOpen(false);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handlePriceChangeMode = (value) => {
    priceChangeRequestIdRef.current += 1;
    setPriceChangeMode(value);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handlePriceChangeManualUah = (value) => {
    priceChangeRequestIdRef.current += 1;
    setPriceChangeManualUah(value);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handlePriceChangeManualRounding = (value) => {
    priceChangeRequestIdRef.current += 1;
    setPriceChangeManualRounding(value);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handlePriceChangeUsdPerGram = (value) => {
    priceChangeRequestIdRef.current += 1;
    setPriceChangeUsdPerGram(value);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handlePriceChangeMarketingRounding = (value) => {
    priceChangeRequestIdRef.current += 1;
    setPriceChangeMarketingRounding(value);
    setPriceChangePreview(null);
    setPriceChangeError('');
    setIsPriceChangeLoading(false);
  };

  const handleConfirmPriceChange = () => {
    if (!canApplyDirectPriceChange) return;
    if (!decodeData?.product?.id || !priceChangePreview?.previewToken
        || priceChangePreview.unchanged || isPriceChangeLoading || isPriceChangeApplying) return;
    const sourceSku = decodeData.sku;
    setIsPriceChangeApplying(true);
    setPriceChangeError('');
    api.post('/product-price-change/apply', {
      productId: decodeData.product.id,
      pricingDecision: priceChangeDecision,
      previewToken: priceChangePreview.previewToken,
    })
      .then((res) => {
        setIsPriceChangeOpen(false);
        setIsRecountOpen(false);
        setPriceChangePreview(null);
        setRecountSuccess(`Ціну товару ${sourceSku} змінено.`);
        Promise.resolve(onApplied?.({
          result: res.data,
          sourceSku,
          correctedSku: sourceSku,
          priceChanged: true,
        })).catch(() => {});
        handleDecode(sourceSku);
      })
      .catch((err) => {
        setPriceChangeError(err.response?.data?.error || err.message);
      })
      .finally(() => setIsPriceChangeApplying(false));
  };

  const handleRequestPriceChange = () => {
    if (!canCreatePriceChangeRequest || !decodeData?.product?.id
        || !priceChangePreview?.previewToken || priceChangePreview.unchanged
        || isPriceChangeLoading || isPriceChangeApplying) return;
    if (priceChangeDecision.mode !== 'system_auto' && !canPriceOverride) {
      setPriceChangeError('Недостатньо дозволу для вибраного режиму ціни в запиті.');
      return;
    }
    const sourceSku = decodeData.sku;
    setIsPriceChangeApplying(true);
    setPriceChangeError('');
    api.post('/admin/correction-requests', {
      requestType: 'price_change',
      productId: decodeData.product.id,
      pricingDecision: priceChangeDecision,
      previewToken: priceChangePreview.previewToken,
    })
      .then((res) => {
        setIsPriceChangeOpen(false);
        setIsRecountOpen(false);
        setPriceChangePreview(null);
        setRecountSuccess(`Створено запит на зміну ціни #${res.data.request.id}.`);
        Promise.resolve(onRequestCreated?.({
          request: res.data.request,
          sourceSku,
        })).catch(() => {});
        handleDecode(sourceSku);
      })
      .catch((err) => setPriceChangeError(err.response?.data?.error || err.message))
      .finally(() => setIsPriceChangeApplying(false));
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
      getRecountPayload(isRequestMode)
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
    handleCancelPriceChange,
    handleConfirmPriceChange,
    handleRequestPriceChange,
    handleConfirmRecount,
    handleDecode,
    handleDecodeInputChange,
    handleRecountAnswer,
    handleRecountTextAnswer,
    handleRecountWeightChange,
    handleStartRecount,
    hasRecountChanges,
    isRecountApplying,
    isInformationOnly,
    isRecountConfirmOpen,
    isRecountLoading,
    isRecountOpen,
    isRecountPreviewCurrent,
    isRecountPreviewUnavailable,
    isPriceChangeApplying,
    isPriceChangeLoading,
    isPriceChangeOpen,
    priceChangeError,
    priceChangeManualUah,
    priceChangeManualRounding,
    priceChangeMarketingRounding,
    priceChangeMode,
    priceChangePreview,
    priceChangeUsdPerGram,
    recountAnswers,
    recountBlockers,
    recountError,
    recountManualPriceUah,
    recountPricingMode,
    recountUsdPerGram,
    recountMarketingRounding,
    recountPreview,
    recountReason,
    recountSubmitMode,
    recountSuccess,
    recountValidationAttempt,
    recountWeight,
    setRecountReason,
    setRecountManualPriceUah,
    setRecountPricingMode,
    setRecountUsdPerGram,
    setRecountMarketingRounding,
    setPriceChangeManualUah: handlePriceChangeManualUah,
    setPriceChangeManualRounding: handlePriceChangeManualRounding,
    setPriceChangeMarketingRounding: handlePriceChangeMarketingRounding,
    setPriceChangeMode: handlePriceChangeMode,
    setPriceChangeUsdPerGram: handlePriceChangeUsdPerGram,
    skuToDecode,
  };
}
