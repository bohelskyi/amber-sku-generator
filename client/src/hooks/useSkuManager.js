import { useEffect, useState } from 'react';
import { api } from '../lib/api';
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

function getDecodedAnswerMap(decoded) {
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

function haveAnswersChanged(previousAnswers, nextAnswers) {
  const keys = new Set([
    ...Object.keys(previousAnswers || {}),
    ...Object.keys(nextAnswers || {}),
  ]);

  return Array.from(keys).some(
    (key) => String(previousAnswers?.[key] ?? '') !== String(nextAnswers?.[key] ?? '')
  );
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
  const [skuToDecode, setSkuToDecode] = useState('');
  const [decodeData, setDecodeData] = useState(null);
  const [decodeError, setDecodeError] = useState('');
  const [decodeErrorDetails, setDecodeErrorDetails] = useState(null);
  const [isRecountOpen, setIsRecountOpen] = useState(false);
  const [recountAnswers, setRecountAnswers] = useState({});
  const [recountReason, setRecountReason] = useState('');
  const [recountPreview, setRecountPreview] = useState(null);
  const [recountError, setRecountError] = useState('');
  const [recountSuccess, setRecountSuccess] = useState('');
  const [isRecountLoading, setIsRecountLoading] = useState(false);
  const [isRecountApplying, setIsRecountApplying] = useState(false);
  const [isRecountConfirmOpen, setIsRecountConfirmOpen] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [manualPriceUah, setManualPriceUah] = useState('');
  const [isManualPriceEditing, setIsManualPriceEditing] = useState(false);
  const hasRecountChanges = Boolean(
    decodeData && haveAnswersChanged(getDecodedAnswerMap(decodeData), recountAnswers)
  );

  const fetchHistory = () => {
    api.get('/products').then((res) => setHistory(res.data));
  };

  const fetchExportStatus = () => {
    api.get('/export/status').then((res) => setExportStatus(res.data));
  };

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
    manualPriceNumber !== null && Number.isFinite(manualPriceNumber) && manualPriceNumber >= 0;
  const roundedManualPriceNumber = hasManualPrice ? Math.round(manualPriceNumber) : null;
  const effectiveTotalPriceUah = hasManualPrice
    ? roundedManualPriceNumber
    : previewData?.totalPriceUah;
  const effectiveTotalPrice =
    hasManualPrice && Number(previewData?.uahRate) > 0
      ? (roundedManualPriceNumber / Number(previewData.uahRate)).toFixed(2)
      : previewData?.totalPrice;
  const weightNumber = Number(weight || previewData?.weightVal || 0);
  const effectivePricePerGramUah =
    hasManualPrice && weightNumber > 0
      ? (roundedManualPriceNumber / weightNumber).toFixed(2)
      : previewData?.pricePerGramUah;
  const effectivePricePerGram =
    hasManualPrice && Number(previewData?.uahRate) > 0 && weightNumber > 0
      ? (roundedManualPriceNumber / Number(previewData.uahRate) / weightNumber).toFixed(2)
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

    setIsSaving(true);
    setSaveError('');

    api.post('/save', {
      fullSku: displaySku || previewData.fullProposedSku,
      baseSku: previewData.baseSku,
      nextSeq: previewData.nextSeq,
      category: selectedCat,
      weight: isWeightRequired ? weight : previewData.weightVal || 0,
      totalPrice: effectiveTotalPrice,
      totalPriceUah: effectiveTotalPriceUah,
      pricePerGram: effectivePricePerGram,
      uahRate: previewData.uahRate,
      details: {
        answers,
        isCalibrated,
        logMessage: previewData.logMessage,
        variationNumber: variationData?.variationNumber || null,
        baseGeneratedSku: previewData.fullProposedSku,
        manualPriceUah: hasManualPrice ? effectiveTotalPriceUah : null,
        autoPriceUah: previewData.totalPriceUah,
      },
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
      const response = await api.get('/export/csv', {
        params: {
          fromSku,
          ...(toSku ? { toSku } : {}),
        },
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const downloadUrl = window.URL.createObjectURL(blob);
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      const fileName = fileNameMatch?.[1] || `amber-export-${fromSku}.csv`;

      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
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

  const handleDecode = (skuValue = skuToDecode) => {
    const normalizedSku = skuValue.trim().toUpperCase();
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

    setRecountAnswers((prevAnswers) => {
      const shouldClear =
        question?.required !== 1
        && selectedValue !== 0
        && Number(prevAnswers[questionId] || 0) === selectedValue;

      return {
        ...prevAnswers,
        [questionId]: shouldClear ? 0 : selectedValue,
      };
    });
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
  };

  const handleRecountTextAnswer = (questionId, value) => {
    const question = config?.questions?.[decodeData?.category?.code]?.find(
      (item) => item.id === questionId
    );

    setRecountAnswers((prevAnswers) => {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        const nextAnswers = { ...prevAnswers };
        if (question?.required === 1) delete nextAnswers[questionId];
        else nextAnswers[questionId] = 0;
        return nextAnswers;
      }
      return { ...prevAnswers, [questionId]: normalizedValue };
    });
    setIsRecountConfirmOpen(false);
    setRecountPreview(null);
    setRecountError('');
  };

  const buildRecountPayload = () => ({
    sourceSku: decodeData?.sku,
    answers: recountAnswers,
    isCalibrated: recountAnswers.is_calibrated ?? null,
    reason: recountReason,
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

    api.post('/recount/preview', buildRecountPayload())
      .then((res) => {
        setRecountPreview(res.data);
        if (openConfirmation) setIsRecountConfirmOpen(true);
      })
      .catch((err) => {
        setRecountPreview(null);
        setRecountError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        setIsRecountLoading(false);
      });
  };

  const handleRecountPreview = () => {
    if (isRecountLoading) return;
    requestRecountPreview(false);
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
    if (isRecountApplying) return;
    setIsRecountConfirmOpen(false);
  };

  const handleConfirmRecount = () => {
    if (!decodeData?.sku || !recountPreview || !hasRecountChanges || isRecountApplying) return;

    setIsRecountApplying(true);
    setRecountError('');
    setRecountSuccess('');

    api.post('/recount/apply', buildRecountPayload())
      .then((res) => {
        const correctedSku = res.data.corrected.fullSku;
        setIsRecountConfirmOpen(false);
        setRecountSuccess(`Створено коригувальний артикул ${correctedSku}. Він не потрапить в експорт.`);
        setIsRecountOpen(false);
        setRecountPreview(null);
        fetchHistory();
        fetchExportStatus();
        handleDecode(correctedSku);
      })
      .catch((err) => {
        setIsRecountConfirmOpen(false);
        setRecountError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        setIsRecountApplying(false);
      });
  };

  const handleManualPriceChange = (value) => {
    if (value === '') {
      setManualPriceUah('');
      return;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) return;
    setManualPriceUah(value);
  };

  const handleStartManualPriceEdit = () => {
    setManualPriceUah(String(effectiveTotalPriceUah || previewData?.totalPriceUah || ''));
    setIsManualPriceEditing(true);
  };

  const handleStopManualPriceEdit = () => {
    if (hasManualPrice) setManualPriceUah(String(roundedManualPriceNumber));
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
    recountAnswers,
    recountError,
    recountPreview,
    recountReason,
    recountSuccess,
    saveError,
    resetProductFlow,
    selectedCat,
    setExportError,
    setExportFromSku,
    setExportToSku,
    setSelectedCat,
    setRecountReason,
    setSkuToDelete,
    setWeight: handleWeightChange,
    skuToDecode,
    skuToDelete,
    variationData,
    variationError,
    weight,
  };
}
