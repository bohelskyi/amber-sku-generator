import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useProductRecount } from './useProductRecount';
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
  const [history, setHistory] = useState([]);
  const [exportStatus, setExportStatus] = useState(null);
  const [skuToDelete, setSkuToDelete] = useState('');
  const [exportFromSku, setExportFromSku] = useState('');
  const [exportToSku, setExportToSku] = useState('');
  const [exportError, setExportError] = useState('');
  const [isExportLoading, setIsExportLoading] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [manualPriceUah, setManualPriceUah] = useState('');
  const [isManualPriceEditing, setIsManualPriceEditing] = useState(false);
  const fetchHistory = () => {
    api.get('/products').then((res) => setHistory(res.data));
  };

  const fetchExportStatus = () => {
    api.get('/export/status').then((res) => setExportStatus(res.data));
  };

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
    setRecountManualPriceUah,
    setRecountReason,
    skuToDecode,
  } = useProductRecount({
    config,
    onApplied: () => {
      fetchHistory();
      fetchExportStatus();
    },
  });

  useEffect(() => {
    api.get('/config').then((res) => setConfig(res.data));
    fetchHistory();
    fetchExportStatus();
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
  const effectiveTotalPrice =
    hasManualPrice && Number(previewData?.uahRate) > 0
      ? (effectiveManualPriceNumber / Number(previewData.uahRate)).toFixed(2)
      : previewData?.totalPrice;
  const weightNumber = Number(weight || previewData?.weightVal || 0);
  const effectivePricePerGramUah =
    hasManualPrice && weightNumber > 0
      ? (effectiveManualPriceNumber / weightNumber).toFixed(2)
      : previewData?.pricePerGramUah;
  const effectivePricePerGram =
    hasManualPrice && Number(previewData?.uahRate) > 0 && weightNumber > 0
      ? (effectiveManualPriceNumber / Number(previewData.uahRate) / weightNumber).toFixed(2)
      : previewData?.pricePerGram;

  const clearLivePrice = () => {
    setLivePriceData(null);
    setLivePriceError('');
    setIsLivePriceLoading(false);
  };

  const normalizeAnswers = (answersMap) => {
    if (!selectedCat || !config) return answersMap;
    return pruneHiddenAnswers(config.questions?.[selectedCat] || [], answersMap);
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
    clearLivePrice();
  };

  const handleTextAnswer = (questionId, value) => {
    setAnswers((prevAnswers) => {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        const nextAnswers = { ...prevAnswers };
        delete nextAnswers[questionId];
        return normalizeAnswers(nextAnswers);
      }
      return normalizeAnswers({ ...prevAnswers, [questionId]: normalizedValue });
    });
    clearLivePrice();
  };

  const handleWeightChange = (value) => {
    setWeight(value);
    clearLivePrice();
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
      if (weight === '' || !Number.isFinite(Number(weight)) || Number(weight) < 0) {
        return;
      }
    }

    let isCancelled = false;
    const timerId = setTimeout(() => {
      setIsLivePriceLoading(true);
      setLivePriceError('');

      api.post('/price-preview', {
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

    api.post('/preview', {
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

    api.post('/save', {
      skuSchemaVersionId: previewData.skuSchemaVersionId,
      previewToken: previewData.previewToken,
      category: selectedCat,
      answers,
      isCalibrated,
      weight: isWeightRequired ? weight : previewData.weightVal || 0,
      manualPriceUah: hasManualPrice ? effectiveTotalPriceUah : null,
      useVariation: Boolean(variationData),
    }).then(() => {
      fetchHistory();
      fetchExportStatus();
      resetProductFlow(null);
    }).catch((err) => {
      setSaveError(err.response?.data?.error || err.message);
    }).finally(() => {
      setIsSaving(false);
    });
  };

  const handleBackToParameters = () => {
    setPreviewData(null);
    setSaveError('');
    setDisplaySku('');
    setVariationData(null);
    setVariationError('');
    setIsVariationLoading(false);
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  const handleAddVariation = () => {
    if (!previewData) return;
    setIsVariationLoading(true);
    setVariationError('');
    setSaveError('');

    api.post('/variation', { sku: previewData.fullProposedSku })
      .then((res) => {
        setDisplaySku(res.data.fullSku);
        setVariationData(res.data);
      })
      .catch((err) => {
        setVariationError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        setIsVariationLoading(false);
      });
  };

  const handleExportCsv = async () => {
    const fromSku = exportFromSku.trim().toUpperCase();
    const toSku = exportToSku.trim().toUpperCase();

    if (!fromSku) {
      setExportError('Вкажіть артикул, з якого починати експорт.');
      return;
    }

    setIsExportLoading(true);
    setExportError('');

    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.()
        || `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotResponse = await api.post('/export/snapshots', {
        fromSku,
        ...(toSku ? { toSku } : {}),
      }, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      const snapshot = snapshotResponse.data;
      const response = await api.get(`/export/snapshots/${snapshot.id}/csv`, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const downloadUrl = window.URL.createObjectURL(blob);
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      const fileName = fileNameMatch?.[1] || snapshot.fileName || `amber-export-${fromSku}.csv`;

      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      await api.post(`/export/snapshots/${snapshot.id}/confirm`);
      fetchExportStatus();
    } catch (err) {
      if (err.response?.data instanceof Blob) {
        const errorText = await err.response.data.text();
        try {
          const parsed = JSON.parse(errorText);
          setExportError(parsed.error || 'Не вдалося виконати експорт.');
        } catch {
          setExportError('Не вдалося виконати експорт.');
        }
      } else {
        setExportError(err.response?.data?.error || err.message);
      }
    } finally {
      setIsExportLoading(false);
    }
  };

  const handleDelete = (sku) => {
    if (!sku) return;
    if (!window.confirm(`Перенести ${sku} в архів?`)) return;

    api.post('/delete', { skuToDelete: sku })
      .then((res) => {
        alert(res.data.message);
        setSkuToDelete('');
        fetchHistory();
        fetchExportStatus();
      })
      .catch((err) => {
        alert(`ПОМИЛКА: ${err.response?.data?.error || err.message}`);
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

  const handleCopyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(`${label} скопійовано`);
      setTimeout(() => setCopyMessage(''), 1500);
    } catch {
      setCopyMessage('Не вдалося скопіювати');
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  return {
    answers,
    answeredRequiredCount,
    config,
    copyMessage,
    decodeData,
    decodeError,
    decodeErrorDetails,
    exportError,
    exportFromSku,
    exportStatus,
    exportToSku,
    effectivePricePerGram,
    effectivePricePerGramUah,
    effectiveTotalPrice,
    effectiveTotalPriceUah,
    finalSku,
    getVisibleOptions,
    getQuestionVisibility,
    handleManualPriceChange,
    handleAddVariation,
    handleApplyRecount,
    handleAnswer,
    handleBackToParameters,
    handleCancelRecount,
    handleCancelRecountConfirmation,
    handleConfirmRecount,
    handleCopyText,
    handleDecode,
    handleDecodeInputChange,
    handleDelete,
    handleExportCsv,
    handlePreview,
    handleRecountAnswer,
    handleRecountPreview,
    handleRecountTextAnswer,
    handleResetManualPrice,
    handleSave,
    handleStartManualPriceEdit,
    handleStartRecount,
    handleStopManualPriceEdit,
    handleTextAnswer,
    hasRecountChanges,
    hasManualPrice,
    history,
    isCalibrated,
    isExportLoading,
    isLivePriceLoading,
    isManualPriceEditing,
    isRecountApplying,
    isRecountConfirmOpen,
    isRecountLoading,
    isRecountOpen,
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
    recountError,
    recountManualPriceUah,
    recountPreview,
    recountReason,
    recountSubmitMode,
    recountSuccess,
    saveError,
    resetProductFlow,
    selectedCat,
    setExportError,
    setExportFromSku,
    setExportToSku,
    setSelectedCat,
    setRecountReason,
    setRecountManualPriceUah,
    setSkuToDelete,
    setWeight: handleWeightChange,
    skuToDecode,
    skuToDelete,
    variationData,
    variationError,
    weight,
  };
}
