import { useEffect, useState } from 'react';
import { productsApi } from '../api/products-api';
import { useProductRecount } from './useProductRecount';
import { useCopyFeedback } from './product/useCopyFeedback';
import { useProductExportController } from './product/useProductExportController';
import { useProductRecordsController } from './product/useProductRecordsController';
import { getApiError } from '../lib/http-error';
import {
  isValidPositivePrice,
  requiresManualPrice as needsManualPrice,
} from '../lib/pricing-validation';
import {
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
} from '../lib/sku-visibility';

function pruneHiddenAnswers(categoryQuestions, answersMap) {
  const nextAnswers = { ...answersMap };
  let removedAnswer = false;

  do {
    removedAnswer = false;
    const calibratedValue = nextAnswers.is_calibrated ?? null;

    for (const question of categoryQuestions) {
      const selectedValue = nextAnswers[question.id];
      if (selectedValue === undefined) continue;

      if (!isQuestionVisible(question, nextAnswers, calibratedValue)) {
        delete nextAnswers[question.id];
        removedAnswer = true;
        continue;
      }

      if (isTextQuestion(question)) continue;

      const visibleOptionIds = getVisibleOptionsForQuestion(
        question,
        nextAnswers,
        calibratedValue
      ).map((option) => Number(option.id));

      if (!visibleOptionIds.includes(Number(selectedValue))) {
        delete nextAnswers[question.id];
        removedAnswer = true;
      }
    }
  } while (removedAnswer);

  return nextAnswers;
}

export function useSkuManager() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [answers, setAnswers] = useState({});
  const [weight, setWeight] = useState('');
  const [livePriceData, setLivePriceData] = useState(null);
  const [livePriceError, setLivePriceError] = useState('');
  const [isLivePriceLoading, setIsLivePriceLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [displaySku, setDisplaySku] = useState('');
  const [variationData, setVariationData] = useState(null);
  const [variationError, setVariationError] = useState('');
  const [isVariationLoading, setIsVariationLoading] = useState(false);
  const [manualPriceUah, setManualPriceUah] = useState('');
  const [isManualPriceEditing, setIsManualPriceEditing] = useState(false);
  const productExport = useProductExportController();
  const records = useProductRecordsController({ onArchived: productExport.fetchExportStatus });
  const copyFeedback = useCopyFeedback();

  const {
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
    setRecountManualPriceUah,
    setRecountReason,
    skuToDecode,
  } = useProductRecount({
    config,
    onApplied: () => {
      records.fetchHistory();
      productExport.fetchExportStatus();
    },
  });

  useEffect(() => {
    productsApi.getConfig().then((res) => setConfig(res.data));
  }, []);

  const isCalibrated = answers.is_calibrated ?? null;

  const getVisibleOptions = (question, answersMap = answers, calibratedValue = isCalibrated) =>
    getVisibleOptionsForQuestion(question, answersMap, calibratedValue);
  const getQuestionVisibility = (question, answersMap = answers, calibratedValue = isCalibrated) =>
    isQuestionVisible(question, answersMap, calibratedValue);

  const questionsForSelected =
    selectedCat && config ? (config.questions?.[selectedCat] || []) : [];
  const visibleQuestionsForSelected = questionsForSelected.filter((question) =>
    getQuestionVisibility(question)
  );
  const requiredQuestions = visibleQuestionsForSelected
    .filter((question) => question.required === 1)
    .filter((question) => isTextQuestion(question) || getVisibleOptions(question).length > 0);
  const requiredCount = requiredQuestions.length;
  const answeredRequiredCount = requiredQuestions.filter((question) => {
    const value = answers[question.id];
    if (isTextQuestion(question)) return value !== undefined && String(value).trim() !== '';
    return value !== undefined;
  }).length;
  const progressPercent = selectedCat
    ? (requiredCount === 0 ? 100 : Math.round((answeredRequiredCount / requiredCount) * 100))
    : 0;
  const categoryConfig = selectedCat && config ? config.categories[selectedCat] : null;
  const isWeightRequired = categoryConfig ? categoryConfig.requires_weight === 1 : true;
  const finalSku = displaySku || previewData?.fullProposedSku || '';
  const isVariationActive = Boolean(variationData);
  const manualPriceNumber =
    manualPriceUah.trim() === '' ? null : Number(manualPriceUah);
  const hasManualPrice =
    manualPriceNumber !== null && isValidPositivePrice(manualPriceNumber);
  const requiresManualPrice = needsManualPrice(previewData);
  const effectiveManualPriceNumber = hasManualPrice ? manualPriceNumber : null;
  const effectiveTotalPriceUah = hasManualPrice
    ? effectiveManualPriceNumber
    : previewData?.totalPriceUah;

  const clearLivePrice = () => {
    setLivePriceData(null);
    setLivePriceError('');
    setIsLivePriceLoading(false);
  };

  const beginLivePriceRefresh = () => {
    setLivePriceError('');
  };

  const normalizeAnswers = (answersMap) => {
    if (!selectedCat || !config) return answersMap;
    return pruneHiddenAnswers(config.questions?.[selectedCat] || [], answersMap);
  };

  const invalidateProductPreview = () => {
    setPreviewData(null);
    setSaveError('');
    setDisplaySku('');
    setVariationData(null);
    setVariationError('');
    setIsVariationLoading(false);
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  const resetProductFlow = (catCode) => {
    setSelectedCat(catCode);
    setAnswers({});
    setPreviewData(null);
    setSaveError('');
    setIsSaving(false);
    setDisplaySku('');
    setVariationData(null);
    setVariationError('');
    setIsVariationLoading(false);
    clearLivePrice();
    setWeight('');
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  const handleAnswer = (questionId, valueId) => {
    invalidateProductPreview();
    const selectedValue = Number.parseInt(valueId, 10);
    setAnswers((prevAnswers) => {
      const nextAnswers = { ...prevAnswers };

      if (prevAnswers[questionId] === selectedValue) {
        delete nextAnswers[questionId];
      } else {
        nextAnswers[questionId] = selectedValue;
        if (questionId === 'raw_type' && selectedValue === 2) delete nextAnswers.is_calibrated;
      }

      return normalizeAnswers(nextAnswers);
    });
    beginLivePriceRefresh();
  };

  const handleTextAnswer = (questionId, value) => {
    invalidateProductPreview();
    setAnswers((prevAnswers) => {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        const nextAnswers = { ...prevAnswers };
        delete nextAnswers[questionId];
        return normalizeAnswers(nextAnswers);
      }
      return normalizeAnswers({ ...prevAnswers, [questionId]: normalizedValue });
    });
    beginLivePriceRefresh();
  };

  const handleWeightChange = (value) => {
    invalidateProductPreview();
    setWeight(value);
    beginLivePriceRefresh();
  };

  useEffect(() => {
    if (!selectedCat || !config) return;

    const categoryQuestions = config.questions?.[selectedCat] || [];
    const hasMissingRequired = categoryQuestions
      .filter((question) => isQuestionVisible(question, answers, isCalibrated))
      .filter((question) => question.required === 1)
      .filter((question) =>
        isTextQuestion(question) ||
        getVisibleOptionsForQuestion(question, answers, isCalibrated).length > 0
      )
      .some((question) => {
        const value = answers[question.id];
        if (isTextQuestion(question)) return value === undefined || String(value).trim() === '';
        return value === undefined;
      });

    if (hasMissingRequired) {
      return;
    }

    if (isWeightRequired) {
      if (weight === '' || !Number.isFinite(Number(weight)) || Number(weight) <= 0) {
        return;
      }
    }

    let isCancelled = false;
    const timerId = setTimeout(() => {
      setIsLivePriceLoading(true);
      setLivePriceError('');

      productsApi.previewPrice({
        categoryCode: selectedCat,
        answers,
        weight: isWeightRequired ? weight : 0,
        isCalibrated: isCalibrated === null ? 0 : isCalibrated,
      })
        .then((res) => {
          if (!isCancelled) setLivePriceData(res.data);
        })
        .catch((err) => {
          if (isCancelled) return;
          setLivePriceData(null);
          setLivePriceError(err.response?.data?.error || err.message);
        })
        .finally(() => {
          if (!isCancelled) setIsLivePriceLoading(false);
        });
    }, 350);

    return () => {
      isCancelled = true;
      clearTimeout(timerId);
    };
  }, [selectedCat, config, answers, weight, isCalibrated, isWeightRequired]);

  const handlePreview = () => {
    if (isWeightRequired && !weight) return alert('Введіть вагу!');
    if (parseFloat(weight) < 0) return alert("Вага не може бути від'ємною!");

    const missingRequired = questionsForSelected
      .filter((question) => getQuestionVisibility(question))
      .filter((question) => question.required === 1)
      .filter((question) => isTextQuestion(question) || getVisibleOptions(question).length > 0)
      .filter((question) => {
        const value = answers[question.id];
        if (isTextQuestion(question)) return value === undefined || String(value).trim() === '';
        return value === undefined;
      });

    if (missingRequired.length > 0) {
      return alert(`Будь ласка, заповніть обов'язкові питання: ${missingRequired.map((question) => question.label).join(', ')}`);
    }

    return productsApi.preview({
      categoryCode: selectedCat,
      answers,
      weight: isWeightRequired ? weight : 0,
      isCalibrated: isCalibrated === null ? 0 : isCalibrated,
    }).then((res) => {
      setPreviewData(res.data);
      setSaveError('');
      setDisplaySku(res.data.fullProposedSku);
      setVariationData(null);
      setVariationError('');
      setIsVariationLoading(false);
      setManualPriceUah('');
      setIsManualPriceEditing(false);
    });
  };

  const handleSave = () => {
    if (!previewData || isSaving) return;
    if (requiresManualPrice && !hasManualPrice) {
      setSaveError('Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.');
      return;
    }

    setIsSaving(true);
    setSaveError('');

    productsApi.save({
      skuSchemaVersionId: previewData.skuSchemaVersionId,
      previewToken: previewData.previewToken,
      category: selectedCat,
      answers,
      isCalibrated,
      weight: isWeightRequired ? weight : previewData.weightVal || 0,
      manualPriceUah: hasManualPrice ? effectiveTotalPriceUah : null,
      useVariation: Boolean(variationData),
    }).then(() => {
      records.fetchHistory();
      productExport.fetchExportStatus();
      resetProductFlow(null);
    }).catch((err) => {
      setSaveError(getApiError(err));
    }).finally(() => {
      setIsSaving(false);
    });
  };

  const handleAddVariation = () => {
    if (!previewData) return;
    setIsVariationLoading(true);
    setVariationError('');
    setSaveError('');

    productsApi.getVariation(previewData.fullProposedSku)
      .then((res) => {
        setDisplaySku(res.data.fullSku);
        setVariationData(res.data);
      })
      .catch((err) => {
        setVariationError(getApiError(err));
      })
      .finally(() => {
        setIsVariationLoading(false);
      });
  };

  const handleManualPriceChange = (value) => {
    if (value === '') {
      setManualPriceUah('');
      return;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;
    setManualPriceUah(value);
  };

  const handleStartManualPriceEdit = () => {
    setManualPriceUah(String(effectiveTotalPriceUah || previewData?.totalPriceUah || ''));
    setIsManualPriceEditing(true);
  };

  const handleStopManualPriceEdit = () => {
    if (hasManualPrice) setManualPriceUah(String(effectiveManualPriceNumber));
    setIsManualPriceEditing(false);
  };

  const handleResetManualPrice = () => {
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  return {
    ...copyFeedback,
    ...productExport,
    ...records,
    answers,
    answeredRequiredCount,
    config,
    decodeData,
    decodeError,
    decodeErrorDetails,
    effectiveTotalPriceUah,
    finalSku,
    getVisibleOptions,
    getQuestionVisibility,
    handleManualPriceChange,
    handleAddVariation,
    handleApplyRecount,
    handleAnswer,
    handleCancelRecount,
    handleCancelRecountConfirmation,
    handleConfirmRecount,
    handleDecode,
    handleDecodeInputChange,
    handlePreview,
    handleRecountAnswer,
    handleRecountTextAnswer,
    handleRecountWeightChange,
    handleResetManualPrice,
    handleSave,
    handleStartManualPriceEdit,
    handleStartRecount,
    handleStopManualPriceEdit,
    handleTextAnswer,
    hasRecountChanges,
    hasManualPrice,
    isCalibrated,
    isLivePriceLoading,
    isManualPriceEditing,
    isRecountApplying,
    isRecountConfirmOpen,
    isRecountLoading,
    isRecountOpen,
    isRecountPreviewCurrent,
    isRecountPreviewUnavailable,
    isSaving,
    isTextQuestion,
    isVariationActive,
    isVariationLoading,
    isWeightRequired,
    livePriceData,
    livePriceError,
    manualPriceUah,
    previewData,
    progressPercent,
    requiredCount,
    requiresManualPrice,
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
    saveError,
    resetProductFlow,
    selectedCat,
    setSelectedCat,
    setRecountReason,
    setRecountManualPriceUah,
    setWeight: handleWeightChange,
    skuToDecode,
    variationData,
    variationError,
    weight,
  };
}
