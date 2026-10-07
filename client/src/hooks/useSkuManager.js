import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProductPhotos } from './useProductPhotos.js';
import { useCreationIntegrationTask } from './useCreationIntegrationTask.js';
import { normalizeNumericAnswers, physicalWeightPolicy, validateNumericInput } from '../lib/product-numeric-input.js';
import { productsApi } from '../api/products-api';
import { createRequirements, isCreateQuestionRequired } from '../lib/product-create-readiness';
import { useProductRecount } from './useProductRecount';
import { useCopyFeedback } from './product/useCopyFeedback';
import { useExportWorkflow } from './product/useExportWorkflow';
import { getApiError } from '../lib/http-error';
import { hasTestCreationCapability, matchesTestCreationResult } from '../lib/test-product.js';
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

      if (question.archived === true || question.archived === 1 || !isQuestionVisible(question, nextAnswers, calibratedValue)) {
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

export function useSkuManager({
  canChangeProductPrice = false,
  canApplyDirectPriceChange = canChangeProductPrice,
  canCreatePriceChangeRequest = false,
  canPriceOverride = false,
  canViewConfig = true,
  canCreateProducts = true,
  canCreateTestProducts = false,
  submitMode = 'apply',
} = {}) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [configAttempt, setConfigAttempt] = useState(0);
  const [selectedCat, setSelectedCat] = useState(null);
  const [isTestProduct, setIsTestProduct] = useState(false);
  const [answers, setAnswers] = useState({});
  const [nameSubjects, setNameSubjects] = useState({ magento_name_subject_ua: '', magento_name_subject_en: '' });
  const [weight, setWeight] = useState('');
  const [livePriceData, setLivePriceData] = useState(null);
  const [livePriceError, setLivePriceError] = useState('');
  const [isLivePriceLoading, setIsLivePriceLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [savedProduct, setSavedProduct] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreationSaveUncertain, setIsCreationSaveUncertain] = useState(false);
  const [displaySku, setDisplaySku] = useState('');
  const [variationData, setVariationData] = useState(null);
  const [variationError, setVariationError] = useState('');
  const [isVariationLoading, setIsVariationLoading] = useState(false);
  const [manualPriceUah, setManualPriceUah] = useState('');
  const [isManualPriceEditing, setIsManualPriceEditing] = useState(false);
  const [creationPricingMode, setCreationPricingMode] = useState('system_auto');
  const [creationUsdPerGram, setCreationUsdPerGram] = useState('');
  const [creationMarketingRounding, setCreationMarketingRounding] = useState(true);
  const [creationFieldErrors, setCreationFieldErrors] = useState({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewSequence = useRef(0); const previewFlight = useRef(false); const saveFlight = useRef(false);
  const nativeSaveAttempt = useRef(null);
  const inputContext = useRef('');
  const isNativeCreation = config?.productCreation?.identityMode === 'public_identity' || previewData?.identityMode === 'public_identity' || previewData?.mode === 'public_identity';
  const creationPricingAvailable = isNativeCreation && config?.productCreation?.pricingDecision?.available === true;
  const creationPhotosAvailable = isNativeCreation && config?.productPhotoRequirements?.available === true;
  const testProductCreationAvailable = canCreateProducts && canCreateTestProducts && hasTestCreationCapability(config);
  const creationPhotos = useProductPhotos({ allowProductActivation: !isTestProduct, canEdit: canCreateProducts && creationPhotosAvailable && !isSaving && !isPreviewing && !isCreationSaveUncertain });
  const creationPhotoPayload = { ...creationPhotos.creationPayload, ...(isTestProduct ? { enableWhenPhotosVerified: false } : {}) };
  const photoContext = creationPhotosAvailable ? JSON.stringify(creationPhotoPayload) : '';
  const priorPhotoContext = useRef(photoContext);
  const productExport = useExportWorkflow();
  const copyFeedback = useCopyFeedback();

  const {
    decodeData,
    decodeError,
    decodeErrorDetails,
    handleApplyRecount,
    handleCancelRecount,
    handleCancelRecountConfirmation,
    handleCancelInformationConfirmation,
    handleCancelPriceChange,
    handleConfirmPriceChange,
    handleRequestPriceChange,
    handleConfirmRecount,
    handleConfirmInformationUpdate,
    handleDecode,
    handleDecodeInputChange,
    handleRecountAnswer,
    handleRecountTextAnswer,
    handleRecountWeightChange,
    handleRecountNameChange,
    handleStartRecount,
    handleStartPriceChange,
    hasRecountChanges,
    informationPreview,
    isInformationOnly,
    isDecodeLoading,
    isRecountApplying,
    isRecountConfirmOpen,
    isInformationConfirmOpen,
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
    setRecountManualPriceUah,
    setRecountPricingMode,
    setRecountUsdPerGram,
    setRecountMarketingRounding,
    setPriceChangeManualUah,
    setPriceChangeManualRounding,
    setPriceChangeMarketingRounding,
    setPriceChangeMode,
    setPriceChangeUsdPerGram,
    setRecountReason,
    skuToDecode,
  } = useProductRecount({
    canChangeProductPrice,
    canApplyDirectPriceChange,
    canCreatePriceChangeRequest,
    canPriceOverride,
    config,
    onApplied: () => productExport.fetchExportStatus(),
    submitMode,
  });

  useEffect(() => {
    if (!canViewConfig) {
      const timer = window.setTimeout(() => {
        setConfig(null);
        setConfigError('');
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let live = true;
    productsApi.getConfig().then((res) => { if (live) setConfig(res.data); })
      .catch((error) => { if (live) setConfigError(getApiError(error)); });
    return () => { live = false; };
  }, [canViewConfig, configAttempt]);

  const isCalibrated = answers.is_calibrated ?? null;

  const getVisibleOptions = (question, answersMap = answers, calibratedValue = isCalibrated) =>
    getVisibleOptionsForQuestion(question, answersMap, calibratedValue);
  const getQuestionVisibility = (question, answersMap = answers, calibratedValue = isCalibrated) =>
    question.archived !== true && question.archived !== 1 && isQuestionVisible(question, answersMap, calibratedValue);

  const questionsForSelected =
    selectedCat && config ? (config.questions?.[selectedCat] || []) : [];
  const visibleQuestionsForSelected = questionsForSelected.filter((question) =>
    getQuestionVisibility(question)
  );
  const createRules = createRequirements(config, selectedCat, answers, previewData, nameSubjects);
  const requiredQuestions = visibleQuestionsForSelected
    .filter((question) => isCreateQuestionRequired(question, createRules))
    .filter((question) => isTextQuestion(question) || getVisibleOptions(question).length > 0);
  const requiredCount = requiredQuestions.length + (createRules.namesRequired ? 2 : 0);
  const answeredRequiredCount = requiredQuestions.filter((question) => {
    const value = answers[question.id];
    if (isTextQuestion(question)) return value !== undefined && String(value).trim() !== '';
    return value !== undefined;
  }).length + (createRules.namesRequired ? Object.values(nameSubjects).filter(v => v.trim()).length : 0);
  const progressPercent = selectedCat
    ? (requiredCount === 0 ? 100 : Math.round((answeredRequiredCount / requiredCount) * 100))
    : 0;
  const categoryConfig = selectedCat && config ? config.categories[selectedCat] : null;
  const isWeightRequired = categoryConfig ? categoryConfig.requires_weight === 1 : true;
  const finalSku = displaySku || previewData?.fullProposedSku || '';
  const isVariationActive = Boolean(variationData);
  const manualPriceNumber =
    manualPriceUah.trim() === '' ? null : Number(manualPriceUah.replace(',', '.'));
  const hasManualPrice =
    creationPricingMode === 'manual_uah' && manualPriceNumber !== null && isValidPositivePrice(manualPriceNumber);
  const requiresManualPrice = needsManualPrice(previewData);
  const effectiveManualPriceNumber = hasManualPrice ? manualPriceNumber : null;
  const effectiveTotalPriceUah = !creationPricingAvailable && hasManualPrice
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
    if (isCreationSaveUncertain || saveFlight.current) return false;
    ++previewSequence.current;
    nativeSaveAttempt.current = null;
    setPreviewData(null);
    setCreationFieldErrors({});
    setSaveError('');
    setDisplaySku('');
    setVariationData(null);
    setVariationError('');
    setIsVariationLoading(false);
    setIsManualPriceEditing(false);
    return true;
  };

  const resetProductFlow = (catCode, { confirmed = false } = {}) => {
    if (!confirmed && (isCreationSaveUncertain || saveFlight.current)) return;
    setIsCreationSaveUncertain(false);
    ++previewSequence.current;
    nativeSaveAttempt.current = null;
    creationPhotos.reset();
    setCreationFieldErrors({});
    if (catCode) setSavedProduct(null);
    setNameSubjects({ magento_name_subject_ua: '', magento_name_subject_en: '' });
    setSelectedCat(catCode);
    setIsTestProduct(false);
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
    setCreationPricingMode('system_auto');
    setCreationUsdPerGram('');
    setCreationMarketingRounding(config?.categories?.[catCode]?.marketing_rounding_enabled !== 0);
    setIsManualPriceEditing(false);
  };

  useEffect(() => {
    if (priorPhotoContext.current !== photoContext && !isCreationSaveUncertain) { priorPhotoContext.current = photoContext; ++previewSequence.current; nativeSaveAttempt.current = null; setPreviewData(null); setDisplaySku(''); setSaveError(''); }
  }, [photoContext, isCreationSaveUncertain]);

  const handleAnswer = (questionId, valueId) => {
    if (!invalidateProductPreview()) return;
    if (questionId === config?.productCreateRequirements?.[selectedCat]?.automaticName?.question) {
      setNameSubjects({ magento_name_subject_ua: '', magento_name_subject_en: '' });
    }
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
    if (!invalidateProductPreview()) return;
    if (questionId === 'weight') setWeight(value);
    setAnswers((prevAnswers) => {
      const normalizedValue = String(value ?? '');
      if (!normalizedValue.trim()) {
        const nextAnswers = { ...prevAnswers };
        delete nextAnswers[questionId];
        return normalizeAnswers(nextAnswers);
      }
      return normalizeAnswers({ ...prevAnswers, [questionId]: normalizedValue });
    });
    beginLivePriceRefresh();
  };

  const handleWeightChange = (value) => {
    if (!invalidateProductPreview()) return;
    setWeight(value);
    if (questionsForSelected.some((question) => question.id === 'weight')) setAnswers((previous) => normalizeAnswers({ ...previous, weight: value }));
    beginLivePriceRefresh();
  };
  const handleNameSubject = (field, value) => {
    if (!invalidateProductPreview()) return;
    setNameSubjects(previous => ({ ...previous, [field]: value }));
  };

  const pricingDecision = creationPricingMode === 'manual_uah'
    ? { mode: 'manual_uah', manualPriceUah: manualPriceUah.replace(',', '.') }
    : creationPricingMode === 'usd_per_gram'
      ? { mode: 'usd_per_gram', usdPerGram: creationUsdPerGram.replace(',', '.'), marketingRoundingEnabled: creationMarketingRounding }
      : { mode: 'system_auto' };
  const namePayload = createRules.fullNames
    ? Object.values(nameSubjects).some(value => value.trim()) ? { magentoNames: { all: nameSubjects.magento_name_subject_ua, en: nameSubjects.magento_name_subject_en } } : {}
    : nameSubjects;
  const requestContext = JSON.stringify({ selectedCat, answers, weight, namePayload, pricingDecision, photoContext, isTestProduct });
  useLayoutEffect(() => { inputContext.current = requestContext; }, [requestContext]);

  const numericInputs = () => {
    const normalized = normalizeNumericAnswers(visibleQuestionsForSelected, answers, selectedCat);
    const needsPhysicalWeight = isWeightRequired || (isNativeCreation && Object.hasOwn(answers, 'weight'));
    const weightInput = Object.hasOwn(answers, 'weight') ? answers.weight : weight;
    const parsed = needsPhysicalWeight ? validateNumericInput(weightInput, physicalWeightPolicy) : { valid: true, normalized: 0 };
    if (!parsed.valid || needsPhysicalWeight && parsed.normalized === undefined) normalized.fieldErrors.weight = parsed.error || 'Вкажіть вагу виробу.';
    return { ...normalized, weight: parsed.normalized ?? 0 };
  };
  const taskNumeric = numericInputs();
  const creationIntegrationTask = useCreationIntegrationTask({
    available: config?.productIntegrationRequests?.available === true,
    canCreate: canCreateProducts && (!isTestProduct || testProductCreationAvailable),
    busy: isSaving || isPreviewing || isCreationSaveUncertain || creationPhotos.hasPendingUploads,
    previewData,
    product: { ...namePayload, ...(isTestProduct ? { isTestProduct: true } : {}), categoryCode: selectedCat, answers: isNativeCreation ? taskNumeric.answers : answers,
      weight: isNativeCreation ? taskNumeric.weight : isWeightRequired ? taskNumeric.weight : 0,
      ...(creationPricingAvailable ? { pricingDecision } : {}),
      ...(creationPhotosAvailable ? creationPhotoPayload : {}), isCalibrated },
  });

  useEffect(() => {
    if (!selectedCat || !config || isTestProduct && !testProductCreationAvailable) return;

    const categoryQuestions = (config.questions?.[selectedCat] || []).filter((question) => question.archived !== true && question.archived !== 1);
    const hasMissingRequired = categoryQuestions
      .filter((question) => isQuestionVisible(question, answers, isCalibrated))
      .filter((question) => isCreateQuestionRequired(question, createRequirements(config, selectedCat, answers)))
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

    const numeric = normalizeNumericAnswers(categoryQuestions.filter((question) => isQuestionVisible(question, answers, isCalibrated)), answers, selectedCat);
    if (Object.keys(numeric.fieldErrors).length) return;
    const physical = validateNumericInput(Object.hasOwn(answers, 'weight') ? answers.weight : weight, physicalWeightPolicy);
    if (isWeightRequired && (!physical.valid || physical.normalized === undefined)) return;

    let isCancelled = false;
    const timerId = setTimeout(() => {
      setIsLivePriceLoading(true);
      setLivePriceError('');

      productsApi.previewPrice({
        ...(isTestProduct ? { isTestProduct: true } : {}),
        categoryCode: selectedCat,
        answers: isNativeCreation ? numeric.answers : answers,
        weight: isWeightRequired || isNativeCreation && Object.hasOwn(answers, 'weight') ? physical.normalized : 0,
        isCalibrated,
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
  }, [selectedCat, config, answers, weight, isCalibrated, isWeightRequired, isNativeCreation, isTestProduct, testProductCreationAvailable]);

  const handlePreview = () => {
    if (isTestProduct && !testProductCreationAvailable) {
      setSaveError('Для створення TEST товару потрібен чинний доступ Адміністратора. Ознака TEST збережена.');
      return Promise.reject(new Error('Для створення TEST товару потрібен чинний доступ Адміністратора.'));
    }
    if (isCreationSaveUncertain) return Promise.reject(new Error('Спочатку перевірте результат попереднього збереження.'));
    if (previewFlight.current || isSaving) return Promise.reject(new Error('Перевірка вже виконується.'));
    if (creationPhotosAvailable && creationPhotos.hasPendingUploads) return Promise.reject(new Error('Завершіть збереження фотографій або приберіть невдалі спроби.'));
    const numeric = numericInputs();
    if (Object.keys(numeric.fieldErrors).length) {
      setCreationFieldErrors(numeric.fieldErrors);
      return Promise.reject(Object.assign(new Error('Перевірте числові поля.'), { response: { data: { fieldErrors: numeric.fieldErrors } } }));
    }
    if (creationPricingMode === 'manual_uah' || creationPricingAvailable && creationPricingMode === 'usd_per_gram') {
      const amount = validateNumericInput(creationPricingMode === 'manual_uah' ? manualPriceUah : creationUsdPerGram, { kind: 'decimal', min: 0, minInclusive: false, maxFractionDigits: creationPricingMode === 'manual_uah' ? 2 : 4 });
      if (!amount.valid || amount.normalized === undefined) return Promise.reject(new Error(amount.error || 'Вкажіть додатну ціну.'));
    }

    const missingRequired = questionsForSelected
      .filter((question) => getQuestionVisibility(question))
      .filter((question) => isCreateQuestionRequired(question, createRules))
      .filter((question) => isTextQuestion(question) || getVisibleOptions(question).length > 0)
      .filter((question) => {
        const value = answers[question.id];
        if (isTextQuestion(question)) return value === undefined || String(value).trim() === '';
        return value === undefined;
      });

    if (missingRequired.length > 0) {
      return Promise.reject(new Error(
        `Заповніть обов'язкові поля: ${missingRequired.map((question) => question.label).join(', ')}`
      ));
    }

    const ticket = ++previewSequence.current; const context = inputContext.current;
    previewFlight.current = true; setIsPreviewing(true); setCreationFieldErrors({});
    return productsApi.preview({
      ...(isTestProduct ? { isTestProduct: true } : {}),
      ...namePayload,
      categoryCode: selectedCat,
      answers: isNativeCreation ? numeric.answers : answers,
      weight: isNativeCreation ? numeric.weight : isWeightRequired ? numeric.weight : 0,
      ...(creationPricingAvailable ? { pricingDecision } : {}),
      ...(creationPhotosAvailable ? creationPhotoPayload : {}),
      isCalibrated,
    }).then((res) => {
      if (ticket !== previewSequence.current || context !== inputContext.current) return;
      if (!matchesTestCreationResult(res.data, isTestProduct)) throw new Error('Сервер не підтвердив обраний тип товару. Повторіть перевірку.');
      setPreviewData(res.data);
      setSaveError('');
      setDisplaySku(res.data.fullProposedSku);
      setVariationData(null);
      setVariationError('');
      setIsVariationLoading(false);
      setIsManualPriceEditing(false);
    }).catch((error) => {
      if (ticket === previewSequence.current && context === inputContext.current) setCreationFieldErrors(error.response?.data?.fieldErrors || error.response?.data?.details?.fieldErrors || {});
      throw error;
    }).finally(() => { previewFlight.current = false; setIsPreviewing(false); });
  };

  const handleSave = () => {
    const recoveringNativeSave = isCreationSaveUncertain && Boolean(nativeSaveAttempt.current);
    if (!previewData || isSaving || previewFlight.current || saveFlight.current) return;
    if (!recoveringNativeSave && (isTestProduct && !testProductCreationAvailable || !matchesTestCreationResult(previewData, isTestProduct))) { setSaveError('Серверна перевірка типу товару не підтверджена. Потрібна нова перевірка й чинний доступ.'); return; }
    if (!recoveringNativeSave && creationPhotosAvailable && creationPhotos.hasPendingUploads) { setSaveError('Завершіть збереження фотографій або приберіть невдалі спроби.'); return; }
    if (!recoveringNativeSave && previewData.creationNames?.ready === false) { setSaveError('Заповніть повні назви UA/EN і повторіть перевірку.'); return; }
    if (!recoveringNativeSave && isNativeCreation && (!previewData.characteristicConfigHash || !previewData.normalizedAnswers)) { setSaveError('Перевірка характеристик неповна. Повторіть перевірку даних.'); return; }
    if (!recoveringNativeSave && creationPricingMode === 'manual_uah' && !hasManualPrice) { setSaveError('Вкажіть додатну ручну ціну.'); return; }
    if (!recoveringNativeSave && requiresManualPrice && !hasManualPrice) {
      setSaveError('Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.');
      return;
    }

    saveFlight.current = true;
    setIsSaving(true);
    setSaveError('');

    const payload = {
      ...(isTestProduct ? { isTestProduct: true } : {}),
      ...namePayload,
      ...(isNativeCreation ? { characteristicConfigHash: previewData.characteristicConfigHash } : { skuSchemaVersionId: previewData.skuSchemaVersionId }),
      previewToken: previewData.previewToken,
      category: selectedCat,
      answers: isNativeCreation ? previewData.normalizedAnswers : answers,
      isCalibrated,
      weight: isNativeCreation ? previewData.weightVal : isWeightRequired ? String(weight).replace(',', '.') : previewData.weightVal || 0,
      ...(creationPricingAvailable ? { pricingDecision } : {}),
      ...(creationPhotosAvailable ? creationPhotoPayload : {}),
      ...(!creationPricingAvailable ? { manualPriceUah: hasManualPrice ? effectiveTotalPriceUah : null } : {}),
      ...(!isNativeCreation ? { useVariation: Boolean(variationData) } : {}),
    };
    if (isNativeCreation && !nativeSaveAttempt.current) nativeSaveAttempt.current = JSON.parse(JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() }));
    productsApi.save(isNativeCreation ? nativeSaveAttempt.current : payload).then((response) => {
      if (!matchesTestCreationResult(response.data, isNativeCreation ? nativeSaveAttempt.current?.isTestProduct === true : isTestProduct, true)) throw new Error('Сервер не підтвердив незмінну ознаку TEST товару та його окремий артикул.');
      if (isNativeCreation && (!Number.isSafeInteger(Number(response?.data?.id)) || Number(response.data.id) <= 0
        || typeof response.data.publicSku !== 'string' || !response.data.publicSku.trim() || response.data.success === false)) {
        throw new Error('Сервер не повернув підтвердження збереженого товару.');
      }
      setSavedProduct(response.data);
      productExport.fetchExportStatus();
      setIsCreationSaveUncertain(false);
      resetProductFlow(null, { confirmed: true });
    }).catch((err) => {
      const uncertain = isNativeCreation && (!err.response || err.response.status >= 500);
      if (uncertain || isCreationSaveUncertain) setIsCreationSaveUncertain(true);
      setSaveError(uncertain || isCreationSaveUncertain ? 'Результат збереження ще не підтверджено. Товар міг бути збережений. Перевірте результат тієї самої спроби.' : getApiError(err));
      setCreationFieldErrors(err.response?.data?.fieldErrors || err.response?.data?.details?.fieldErrors || {});
    }).finally(() => {
      saveFlight.current = false;
      setIsSaving(false);
    });
  };
  const resumeIntegrationTask = ({product,photos}) => {
    if (product.isTestProduct === true && !testProductCreationAvailable) throw new Error('Збережена задача містить TEST товар. Для відновлення потрібен чинний доступ Адміністратора; ознака TEST не змінюється.');
    if(!canCreateProducts || !creationPhotosAvailable || isCreationSaveUncertain || saveFlight.current || previewFlight.current
      || creationPhotos.hasPendingUploads || !Object.hasOwn(config?.categories || {},product.categoryCode))return false;
    if(!creationPhotos.restoreStaged(photos,product.enableWhenPhotosVerified))return false;
    ++previewSequence.current;nativeSaveAttempt.current=null;
    setSelectedCat(product.categoryCode);setAnswers(product.answers);setWeight(String(product.weight ?? ''));
    setIsTestProduct(product.isTestProduct === true);
    setNameSubjects({magento_name_subject_ua:product.magentoNames?.all || product.magento_name_subject_ua || '',magento_name_subject_en:product.magentoNames?.en || product.magento_name_subject_en || ''});
    setCreationPricingMode(product.pricingDecision?.mode || 'system_auto');
    setManualPriceUah(String(product.pricingDecision?.manualPriceUah ?? ''));
    setCreationUsdPerGram(String(product.pricingDecision?.usdPerGram ?? ''));
    setCreationMarketingRounding(product.pricingDecision?.marketingRoundingEnabled!==false);
    setSavedProduct(null);setPreviewData(null);setCreationFieldErrors({});setSaveError('');setDisplaySku('');
    setVariationData(null);setVariationError('');setIsManualPriceEditing(false);clearLivePrice();return true;
  };

  const handleAddVariation = () => {
    if (!previewData || isNativeCreation || !previewData.fullProposedSku) return;
    const ticket = previewSequence.current;
    setIsVariationLoading(true);
    setVariationError('');
    setSaveError('');

    productsApi.getVariation(previewData.fullProposedSku)
      .then((res) => {
        if (ticket !== previewSequence.current) return;
        setDisplaySku(res.data.fullSku);
        setVariationData(res.data);
      })
      .catch((err) => {
        if (ticket !== previewSequence.current) return;
        setVariationError(getApiError(err));
      })
      .finally(() => {
        if (ticket === previewSequence.current) setIsVariationLoading(false);
      });
  };

  const handleManualPriceChange = (value) => {
    if (isCreationSaveUncertain || saveFlight.current) return;
    if (creationPricingAvailable && !invalidateProductPreview()) return;
    setCreationPricingMode('manual_uah');
    setManualPriceUah(String(value));
  };
  const handleCreationPricingMode = (mode) => {
    const modes = creationPricingAvailable ? config.productCreation.pricingDecision.modes : ['system_auto', 'manual_uah'];
    if (!modes.includes(mode)) return;
    if (!invalidateProductPreview()) return; setCreationPricingMode(mode);
  };
  const handleCreationUsdPerGram = (value) => { if (!invalidateProductPreview()) return; setCreationUsdPerGram(String(value)); };
  const handleCreationMarketingRounding = (value) => { if (!invalidateProductPreview()) return; setCreationMarketingRounding(Boolean(value)); };

  const handleStartManualPriceEdit = () => {
    if (isCreationSaveUncertain || saveFlight.current) return;
    setCreationPricingMode('manual_uah');
    setManualPriceUah(String(effectiveTotalPriceUah || previewData?.totalPriceUah || ''));
    setIsManualPriceEditing(true);
  };

  const handleStopManualPriceEdit = () => {
    if (isCreationSaveUncertain || saveFlight.current) return;
    if (hasManualPrice) setManualPriceUah(String(effectiveManualPriceNumber));
    setIsManualPriceEditing(false);
  };

  const handleResetManualPrice = () => {
    if (isCreationSaveUncertain || saveFlight.current) return;
    if (creationPricingAvailable && !invalidateProductPreview()) return;
    setCreationPricingMode('system_auto');
    setManualPriceUah('');
    setIsManualPriceEditing(false);
  };

  return {
    isTestProduct, testProductCreationAvailable,
    handleTestProductChange: (value) => { if (!testProductCreationAvailable || !invalidateProductPreview()) return; setIsTestProduct(value === true); },
    ...creationIntegrationTask,
    resumeIntegrationTask,
    isCreationSaveUncertain,
    isNativeCreation, creationPricingAvailable, creationPricingMode, creationUsdPerGram, creationMarketingRounding, creationFieldErrors, isPreviewing, creationPhotosAvailable, creationPhotos,
    handleCreationPricingMode, handleCreationUsdPerGram, handleCreationMarketingRounding,
    nameSubjects,
    handleNameSubject,
    ...copyFeedback,
    ...productExport,
    answers,
    answeredRequiredCount,
    config,
    configError,
    retryConfig: () => { setConfigError(''); setConfigAttempt((value) => value + 1); },
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
    handleCancelInformationConfirmation,
    handleCancelPriceChange,
    handleConfirmPriceChange,
    handleRequestPriceChange,
    handleConfirmRecount,
    handleConfirmInformationUpdate,
    handleDecode,
    handleDecodeInputChange,
    handlePreview,
    handleRecountAnswer,
    handleRecountTextAnswer,
    handleRecountWeightChange,
    handleRecountNameChange,
    handleResetManualPrice,
    handleSave,
    handleStartManualPriceEdit,
    handleStartRecount,
    handleStartPriceChange,
    handleStopManualPriceEdit,
    handleTextAnswer,
    hasRecountChanges,
    informationPreview,
    isInformationOnly,
    isDecodeLoading,
    hasManualPrice,
    isCalibrated,
    isLivePriceLoading,
    isManualPriceEditing,
    isRecountApplying,
    isRecountConfirmOpen,
    isInformationConfirmOpen,
    isRecountLoading,
    isRecountOpen,
    isRecountPreviewCurrent,
    isRecountPreviewUnavailable,
    isPriceChangeApplying,
    isPriceChangeLoading,
    isPriceChangeOpen,
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
    recountPricingMode,
    recountUsdPerGram,
    recountMarketingRounding,
    recountReason,
    recountSubmitMode,
    recountSuccess,
    recountValidationAttempt,
    recountWeight,
    priceChangeError,
    priceChangeManualUah,
    priceChangeManualRounding,
    priceChangeMarketingRounding,
    priceChangeMode,
    priceChangePreview,
    priceChangeUsdPerGram,
    saveError,
    savedProduct,
    resetProductFlow,
    selectedCat,
    setSelectedCat: (next) => { if (!isCreationSaveUncertain && !saveFlight.current) setSelectedCat(next); },
    setRecountReason,
    setRecountManualPriceUah,
    setRecountPricingMode,
    setRecountUsdPerGram,
    setRecountMarketingRounding,
    setPriceChangeManualUah,
    setPriceChangeManualRounding,
    setPriceChangeMarketingRounding,
    setPriceChangeMode,
    setPriceChangeUsdPerGram,
    setWeight: handleWeightChange,
    skuToDecode,
    variationData,
    variationError,
    weight,
  };
}
