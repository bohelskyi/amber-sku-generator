import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getVisibleOptionsForQuestion, isTextQuestion } from '../lib/sku-visibility';

export function useSkuManager() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [answers, setAnswers] = useState({});
  const [isCalibrated, setIsCalibrated] = useState(null);
  const [weight, setWeight] = useState('');
  const [livePriceData, setLivePriceData] = useState(null);
  const [livePriceError, setLivePriceError] = useState('');
  const [isLivePriceLoading, setIsLivePriceLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
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
  const [copyMessage, setCopyMessage] = useState('');
  const [manualPriceUah, setManualPriceUah] = useState('');
  const [isManualPriceEditing, setIsManualPriceEditing] = useState(false);

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

  const getVisibleOptions = (question, answersMap = answers, calibratedValue = isCalibrated) =>
    getVisibleOptionsForQuestion(question, answersMap, calibratedValue);

  const questionsForSelected =
    selectedCat && config ? (config.questions?.[selectedCat] || []) : [];
  const requiredQuestions = questionsForSelected
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
  const effectiveTotalPriceUah = hasManualPrice
    ? manualPriceNumber.toFixed(2)
    : previewData?.totalPriceUah;
  const effectiveTotalPrice =
    hasManualPrice && Number(previewData?.uahRate) > 0
      ? (manualPriceNumber / Number(previewData.uahRate)).toFixed(2)
      : previewData?.totalPrice;
  const weightNumber = Number(weight || 0);
  const effectivePricePerGramUah =
    hasManualPrice && weightNumber > 0
      ? (manualPriceNumber / weightNumber).toFixed(2)
      : previewData?.pricePerGramUah;
  const effectivePricePerGram =
    hasManualPrice && Number(previewData?.uahRate) > 0 && weightNumber > 0
      ? (manualPriceNumber / Number(previewData.uahRate) / weightNumber).toFixed(2)
      : previewData?.pricePerGram;

  const resetProductFlow = (catCode) => {
    setSelectedCat(catCode);
    setAnswers({});
    setIsCalibrated(null);
    setPreviewData(null);
    setDisplaySku('');
    setVariationData(null);
    setVariationError('');
    setIsVariationLoading(false);
    setLivePriceData(null);
    setLivePriceError('');
    setIsLivePriceLoading(false);
    setWeight('');
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  const handleAnswer = (questionId, valueId) => {
    const selectedValue = parseInt(valueId);
    if (answers[questionId] === selectedValue) {
      const nextAnswers = { ...answers };
      delete nextAnswers[questionId];
      setAnswers(nextAnswers);
    } else {
      const nextAnswers = { ...answers, [questionId]: selectedValue };
      setAnswers(nextAnswers);
      if (questionId === 'raw_type' && selectedValue === 2) setIsCalibrated(null);
    }
  };

  const handleTextAnswer = (questionId, value) => {
    setAnswers((prevAnswers) => {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        const nextAnswers = { ...prevAnswers };
        delete nextAnswers[questionId];
        return nextAnswers;
      }
      return { ...prevAnswers, [questionId]: normalizedValue };
    });
  };

  useEffect(() => {
    if (!selectedCat || !config) return;

    setAnswers((prevAnswers) => {
      let hasChanges = false;
      const nextAnswers = { ...prevAnswers };
      const categoryQuestions = config.questions?.[selectedCat] || [];

      for (const question of categoryQuestions) {
        const selectedValue = nextAnswers[question.id];
        if (selectedValue === undefined || isTextQuestion(question)) continue;

        const visibleOptionIds = getVisibleOptionsForQuestion(
          question,
          nextAnswers,
          isCalibrated
        ).map((option) => Number(option.id));

        if (!visibleOptionIds.includes(Number(selectedValue))) {
          delete nextAnswers[question.id];
          hasChanges = true;
        }
      }

      return hasChanges ? nextAnswers : prevAnswers;
    });
  }, [selectedCat, config, isCalibrated]);

  useEffect(() => {
    if (!selectedCat || !config) {
      setLivePriceData(null);
      setLivePriceError('');
      setIsLivePriceLoading(false);
      return;
    }

    const categoryQuestions = config.questions?.[selectedCat] || [];
    const hasMissingRequired = categoryQuestions
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
      setLivePriceData(null);
      setLivePriceError('');
      setIsLivePriceLoading(false);
      return;
    }

    if (isWeightRequired) {
      if (weight === '' || !Number.isFinite(Number(weight)) || Number(weight) < 0) {
        setLivePriceData(null);
        setLivePriceError('');
        setIsLivePriceLoading(false);
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
      setDisplaySku(res.data.fullProposedSku);
      setVariationData(null);
      setVariationError('');
      setIsVariationLoading(false);
      setManualPriceUah('');
      setIsManualPriceEditing(false);
    });
  };

  const handleSave = () => {
    if (!previewData) return;

    api.post('/save', {
      fullSku: displaySku || previewData.fullProposedSku,
      baseSku: previewData.baseSku,
      nextSeq: previewData.nextSeq,
      category: selectedCat,
      weight: isWeightRequired ? weight : 0,
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
    });
  };

  const handleBackToParameters = () => {
    setPreviewData(null);
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
    if (!window.confirm(`Видалити ${sku}?`)) return;

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
      return;
    }

    api.post('/decode', { sku: normalizedSku })
      .then((res) => {
        setSkuToDecode(normalizedSku);
        setDecodeData(res.data);
        setDecodeError('');
      })
      .catch((err) => {
        setDecodeData(null);
        setDecodeError(err.response?.data?.error || err.message);
      });
  };

  const handleDecodeInputChange = (value) => {
    setSkuToDecode(value.toUpperCase());
    setDecodeData(null);
    setDecodeError('');
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
    handleManualPriceChange,
    handleAddVariation,
    handleAnswer,
    handleBackToParameters,
    handleCopyText,
    handleDecode,
    handleDecodeInputChange,
    handleDelete,
    handleExportCsv,
    handlePreview,
    handleResetManualPrice,
    handleSave,
    handleStartManualPriceEdit,
    handleStopManualPriceEdit,
    handleTextAnswer,
    hasManualPrice,
    history,
    isCalibrated,
    isExportLoading,
    isLivePriceLoading,
    isManualPriceEditing,
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
    resetProductFlow,
    selectedCat,
    setExportError,
    setExportFromSku,
    setExportToSku,
    setIsCalibrated,
    setSelectedCat,
    setSkuToDelete,
    setWeight,
    skuToDecode,
    skuToDelete,
    variationData,
    variationError,
    weight,
  };
}
