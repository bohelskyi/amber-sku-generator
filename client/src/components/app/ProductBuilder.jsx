import { useEffect, useId, useRef, useState } from 'react';
import {
  formatDecimal,
  formatUah,
  formatUahPerGram,
  formatUsd,
  formatWholeUah,
} from '../../lib/formatters';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import CreationDeliveryNotice from './CreationDeliveryNotice.jsx';
import { creationDeliveryState } from '../../lib/creation-delivery-readiness.js';
import { ProductPhotos } from './ProductPhotos.jsx';
import { TestProductNotice } from './TestProductNotice.jsx';
import { numericQuestionPolicy, physicalWeightPolicy, validateNumericInput } from '../../lib/product-numeric-input.js';
import { createRequirements, isCreateQuestionRequired } from '../../lib/product-create-readiness';

const hasAnswer = (value) =>
  value !== undefined && value !== null && String(value).trim() !== '';

const getFinalPriceUsd = (finalPriceUah, uahRate) => {
  const normalizedPrice = Number(finalPriceUah);
  const normalizedRate = Number(uahRate);
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0
    || !Number.isFinite(normalizedRate) || normalizedRate <= 0) {
    return null;
  }
  return (normalizedPrice / normalizedRate).toFixed(2);
};

const formatPositivePrice = (value, formatter) => (
  value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0
    ? formatter(value)
    : '—'
);

export function ProductBuilder({
  config,
  selectedCat,
  answers,
  nameSubjects = {},
  onNameSubject,
  weight,
  setWeight,
  isWeightRequired,
  answeredRequiredCount,
  requiredCount,
  previewData,
  reservedCreationSku,
  isTestProduct = false,
  canCreateTestProducts = false,
  onTestProductChange,
  livePriceData,
  isLivePriceLoading,
  finalSku,
  effectiveTotalPriceUah,
  hasManualPrice,
  isVariationActive,
  variationData,
  variationError,
  isVariationLoading,
  isManualPriceEditing,
  isSaving,
  isCreationSaveUncertain = false,
  requiresManualPrice,
  manualPriceUah,
  saveError,
  creationFieldErrors = {},
  isNativeCreation: nativeCreation,
  creationPricingMode = 'system_auto',
  creationUsdPerGram = '',
  creationMarketingRounding = true,
  creationPricingAvailable = false,
  creationPhotosAvailable = false,
  creationPhotos,
  creationIntegrationPermissions = [],
  onRequestIntegration,
  creatingRequest = false,
  requestReceipt,
  integrationTaskError,
  onCreationPricingMode,
  onCreationUsdPerGram,
  onCreationMarketingRounding,
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
  onAnswer,
  onTextAnswer,
  onPreview,
  onCopyText,
  onAddVariation,
  onManualPriceChange,
  onResetManualPrice,
  onSave,
  onStartManualPriceEdit,
  onStopManualPriceEdit,
  onCancel,
}) {
  const workspaceRef = useRef(null);
  const photosPanelRef = useRef(null);
  const mediaBlockerId = useId();
  const deliveryNoticeId = useId();
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [verificationError, setVerificationError] = useState('');
  const [verificationFieldErrors, setVerificationFieldErrors] = useState({});
  const [isVerifying, setIsVerifying] = useState(false);
  const category = config.categories[selectedCat];
  const createRules = createRequirements(config, selectedCat, answers, previewData, nameSubjects);
  const isVerified = Boolean(previewData);
  const isNativeCreation = nativeCreation ?? (config.productCreation?.identityMode === 'public_identity' || previewData?.identityMode === 'public_identity' || previewData?.mode === 'public_identity');
  const deliveryState = isNativeCreation ? creationDeliveryState(previewData?.creationDeliveryReadiness, selectedCat) : null;
  const deliveryConfigurationRequired = deliveryState?.status === 'configuration_required';
  const visibleQuestions = (config.questions[selectedCat] || []).filter((question) =>
    question.archived !== true && question.archived !== 1 && isQuestionVisible(question, answers)
  );
  const weightQuestion = visibleQuestions.find((question) => question.id === 'weight');
  const actualWeight = weightQuestion ? answers.weight : weight;
  const weightValidation = validateNumericInput(actualWeight, physicalWeightPolicy);
  const hasValidWeight = !isWeightRequired || weightValidation.valid && weightValidation.normalized !== undefined;
  const fieldBlockers = visibleQuestions.reduce((blockers, question) => {
    const value = answers[question.id];
    const textQuestion = isTextQuestion(question);
    const visibleOptions = getVisibleOptionsForQuestion(question, answers);
    const hasAvailableControl = textQuestion || visibleOptions.length > 0;

    if (isCreateQuestionRequired(question, createRules) && hasAvailableControl && !hasAnswer(value)) {
      blockers.push({
        fieldId: question.id,
        message: `Заповніть поле «${question.label}».`,
      });
      return blockers;
    }

    if (!textQuestion && hasAnswer(value)
      && !visibleOptions.some((option) => String(option.id) === String(value))) {
      blockers.push({
        fieldId: question.id,
        message: `Значення у полі «${question.label}» недоступне.`,
      });
    }
    const numeric = validateNumericInput(value, numericQuestionPolicy(question, selectedCat));
    if (textQuestion && hasAnswer(value) && !numeric.valid) blockers.push({ fieldId: question.id, message: numeric.error });
    return blockers;
  }, []);
  if (createRules.namesRequired) {
    for (const [field, label] of [['magento_name_subject_ua', 'Назва предмета українською'], ['magento_name_subject_en', 'Назва предмета англійською']]) {
      if (!hasAnswer(nameSubjects[field])) fieldBlockers.push({ fieldId: field, message: `Заповніть поле «${label}».` });
    }
  }

  if (!hasValidWeight) {
    fieldBlockers.push({
      fieldId: 'weight',
      message: weightValidation.error || 'Вага виробу має бути більшою за 0.',
    });
  }
  const displayedPricing = previewData || (fieldBlockers.length === 0 && creationPricingMode === 'system_auto' ? livePriceData : null);

  const matchingServerQuestion = verificationError
    ? visibleQuestions.find((question) => verificationError.includes(`«${question.label}»`))
    : null;
  if (matchingServerQuestion
    && !fieldBlockers.some((blocker) => blocker.fieldId === matchingServerQuestion.id)) {
    fieldBlockers.push({ fieldId: matchingServerQuestion.id, message: verificationError });
  }

  const serverErrors = { ...verificationFieldErrors, ...creationFieldErrors };
  for (const [fieldId, message] of Object.entries(serverErrors)) {
    if (!fieldBlockers.some((blocker) => blocker.fieldId === fieldId)) fieldBlockers.push({ fieldId, message });
  }
  const validationVisible = verificationAttempt > 0 && !isVerified || Object.keys(serverErrors).length > 0;
  const validationFailed = validationVisible
    && (fieldBlockers.length > 0 || Boolean(verificationError));
  const blockerByFieldId = new Map(
    (validationVisible ? fieldBlockers : []).map((blocker) => [blocker.fieldId, blocker])
  );
  const generalVerificationError = verificationError && !matchingServerQuestion
    ? verificationError
    : '';
  const requiresPriceAttention = isVerified && requiresManualPrice && !hasManualPrice;
  const verifiedHasError = isVerified && Boolean(saveError || variationError || isCreationSaveUncertain);
  const photosPending = Boolean(creationPhotos?.hasPendingUploads);
  const photosFailed = Boolean(creationPhotos?.failedUploads?.length);
  const summaryNeedsAttention = validationFailed || requiresPriceAttention || verifiedHasError || photosFailed;
  const summaryStateClass = summaryNeedsAttention
    ? 'is-error'
    : deliveryConfigurationRequired
      ? 'is-neutral'
    : isVerified && !photosPending
      ? 'is-success'
      : 'is-neutral';
  const summaryStateLabel = isCreationSaveUncertain ? 'Результат не підтверджено' : photosFailed ? 'Фото потребують уваги' : photosPending ? 'Очікуємо фото' : summaryNeedsAttention
    ? 'Потрібна увага'
    : deliveryConfigurationRequired
      ? 'Очікує підключення'
    : isVerified
      ? isNativeCreation ? 'Дані перевірено' : 'Перевірено'
      : displayedPricing || (isLivePriceLoading && fieldBlockers.length === 0)
        ? 'Потрібна перевірка'
        : 'Не перевірено';
  const summaryWeight = isVerified
    ? previewData.weightVal
    : weightValidation.valid && weightValidation.normalized !== undefined && (isWeightRequired || weightQuestion)
      ? weightValidation.normalized
      : null;
  const displayedFinalPriceUah = isVerified
    ? effectiveTotalPriceUah
    : displayedPricing?.totalPriceUah;
  const finalPriceUsd = displayedPricing
    ? getFinalPriceUsd(displayedFinalPriceUah, displayedPricing.uahRate)
    : null;

  useEffect(() => {
    if (!validationVisible || !validationFailed) return;
    const firstBlocker = workspaceRef.current?.querySelector('[data-builder-blocker="true"]');
    firstBlocker?.scrollIntoView({ behavior: 'auto', block: 'center' });
    firstBlocker?.focus({ preventScroll: true });
  }, [verificationAttempt, validationFailed, validationVisible]);

  const prepareForEdit = () => {
    setVerificationFieldErrors({});
    if (isVerified) setVerificationAttempt(0);
    setVerificationError('');
  };

  const handleVerify = async () => {
    setVerificationError('');
    setVerificationFieldErrors({});
    setVerificationAttempt((attempt) => attempt + 1);
    if (fieldBlockers.length > 0) return;

    setIsVerifying(true);
    try {
      await onPreview();
    } catch (error) {
      setVerificationError(error.response?.data?.error || error.message);
      setVerificationFieldErrors(error.response?.data?.fieldErrors || error.response?.data?.details?.fieldErrors || {});
      setVerificationAttempt((attempt) => attempt + 1);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div ref={workspaceRef} className="operational-split-layout">
      <section className="builder-workspace card overflow-hidden fade-up">
        <header className="builder-header">
          <div>
            <p className="eyebrow">Новий товар</p>
            <h2 className="section-title-text mt-1">{category.name}</h2>
            <p className="mt-1 text-sm text-slate-500">Заповніть характеристики, перевірте розрахунок і збережіть товар.</p>
          </div>
          <button onClick={onCancel} disabled={isSaving || isCreationSaveUncertain} className="btn btn-ghost">До категорій</button>
        </header>

        {canCreateTestProducts && <div className="test-product-control">
          <label><input type="checkbox" checked={isTestProduct} disabled={isVerifying || isSaving || isCreationSaveUncertain}
            onChange={(event) => { prepareForEdit(); onTestProductChange?.(event.target.checked); }} />Створити TEST товар</label>
          <p>Лише для Адміністратора. Окремий артикул TEST-…; товар залишається вимкненим для покупців у Magento.</p>
        </div>}
        {isTestProduct && <p className="test-product-selection" role="status">Обрано TEST товар. Ознака зберігається назавжди; звичайна серія AG не використовується.</p>}
        {isTestProduct && !canCreateTestProducts && <p className="test-product-selection" role="alert">Для продовження створення TEST товару потрібен чинний доступ Адміністратора. Ознака TEST збережена.</p>}
        <div className="builder-field-list">
          {visibleQuestions.map((question) => {
            const visibleOptions = getVisibleOptionsForQuestion(question, answers);
            const textQuestion = isTextQuestion(question);
            const isRequired = isCreateQuestionRequired(question, createRules)
              && (textQuestion || visibleOptions.length > 0);
            const blocker = blockerByFieldId.get(question.id);
            const blockerMessageId = `builder-blocker-${question.id}`;

            return (
              <div
                key={question.id}
                data-builder-blocker={blocker ? 'true' : undefined}
                tabIndex={blocker ? -1 : undefined}
                className={`builder-field-row ${blocker ? 'is-invalid' : ''}`}
              >
                <div className="builder-field-label">
                  <label htmlFor={textQuestion ? `builder-${question.id}` : undefined}>
                    {question.label}{numericQuestionPolicy(question, selectedCat)?.unit && ` (${numericQuestionPolicy(question, selectedCat).unit})`}
                    {isRequired && <span className="required-marker" aria-label="обов’язкове поле">*</span>}
                  </label>
                </div>

                <div className="min-w-0">
                  {textQuestion ? (
                    <input
                      id={`builder-${question.id}`}
                      type="text"
                      required={isRequired}
                      className="input builder-text-input"
                      value={answers[question.id] ?? ''}
                      inputMode={numericQuestionPolicy(question, selectedCat)?.kind === 'integer' ? 'numeric' : numericQuestionPolicy(question, selectedCat) ? 'decimal' : undefined}
                      onChange={(event) => {
                        prepareForEdit();
                        onTextAnswer(question.id, event.target.value);
                      }}
                      disabled={isVerifying || isSaving || isCreationSaveUncertain}
                      placeholder="Введіть значення..."
                      aria-invalid={blocker ? 'true' : undefined}
                      aria-describedby={blocker ? blockerMessageId : undefined}
                    />
                  ) : (
                    <>
                      <div
                        className="flex flex-wrap gap-1.5"
                        role="group"
                        aria-label={question.label}
                        aria-invalid={blocker ? 'true' : undefined}
                        aria-describedby={blocker ? blockerMessageId : undefined}
                      >
                        {visibleOptions.map((option) => (
                          <button
                            key={option.id}
                            onClick={() => {
                              prepareForEdit();
                              onAnswer(question.id, option.id);
                            }}
                            disabled={isVerifying || isSaving || isCreationSaveUncertain}
                            className={`option-pill builder-option ${answers[question.id] === option.id ? 'option-pill-active' : 'option-pill-idle'}`}
                            aria-pressed={answers[question.id] === option.id}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      {visibleOptions.length === 0 && (
                        <p className="text-xs text-slate-500">Немає доступних варіантів.</p>
                      )}
                    </>
                  )}
                  {blocker && (
                    <p id={blockerMessageId} className="builder-field-error" role="alert">
                      {blocker.message}
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {createRules.namesRequired && <>
            <p className="text-sm text-slate-600">{createRules.fullNames ? 'Шаблон не сформував повну пару UA/EN. Введіть повні назви товару.' : 'Вкажіть лише назву предмета. «З бурштину» та артикул додаються автоматично.'}</p>
            {[['magento_name_subject_ua', 'Назва предмета українською'], ['magento_name_subject_en', 'Назва предмета англійською']].map(([field, label]) => (
              <div key={field} className={`builder-field-row ${blockerByFieldId.has(field) ? 'is-invalid' : ''}`}
                data-builder-blocker={blockerByFieldId.has(field) ? 'true' : undefined} tabIndex={blockerByFieldId.has(field) ? -1 : undefined}>
                <div className="builder-field-label">
                  <label htmlFor={`builder-${field}`}>{createRules.fullNames ? label.replace('Назва предмета', 'Повна назва товару') : label}<span className="required-marker" aria-label="обов’язкове поле">*</span></label>
                </div>
                <div className="min-w-0">
                  <input id={`builder-${field}`} className="input builder-text-input" required maxLength={createRules.fullNames ? 1024 : 200}
                    value={nameSubjects[field] || ''} disabled={isVerifying || isSaving || isCreationSaveUncertain}
                    aria-invalid={blockerByFieldId.has(field) ? 'true' : undefined}
                    aria-describedby={blockerByFieldId.has(field) ? `builder-blocker-${field}` : undefined}
                    onChange={event => { prepareForEdit(); onNameSubject(field, event.target.value); }} />
                  {blockerByFieldId.has(field) && <p id={`builder-blocker-${field}`} className="builder-field-error" role="alert">{blockerByFieldId.get(field).message}</p>}
                </div>
              </div>
            ))}
          </>}

          {isWeightRequired && !weightQuestion && (
            <WeightField
              blocker={blockerByFieldId.get('weight')}
              disabled={isVerifying || isSaving || isCreationSaveUncertain}
              prepareForEdit={prepareForEdit}
              setWeight={setWeight}
              weight={weight}
            />
          )}
          {creationPhotosAvailable && <div ref={photosPanelRef} tabIndex={-1}><ProductPhotos controller={creationPhotos} activationDisabledReason={isTestProduct ? 'TEST товар не вмикається для покупців після перевірки фото.' : null} canEdit={creationPhotos?.canEdit !== false && !isVerifying && !isSaving && !isCreationSaveUncertain} /></div>}
        </div>
      </section>

      <aside className="sticky-summary-container fade-up stagger-1">
        <div className="sticky-summary builder-summary card overflow-hidden">
          <div className="builder-summary-header">
            <h3>Підсумок</h3>
            <span className={`builder-state ${summaryStateClass}`}>
              <span aria-hidden="true" />
              {summaryStateLabel}
            </span>
          </div>

          <div className="builder-summary-body">
            <div className="builder-summary-group first">
              <SummaryRow label="Обов’язкові поля" value={`${answeredRequiredCount}/${requiredCount}`} />
              <SummaryRow
                label="Вага"
                value={isWeightRequired || weightQuestion
                  ? (summaryWeight !== null ? `${formatDecimal(summaryWeight)} г` : '—')
                  : 'Не потрібна'}
                danger={validationFailed && isWeightRequired && !hasValidWeight}
              />
              {!isNativeCreation && <details className="mt-2 text-xs"><summary className="cursor-pointer text-slate-500">Технічні деталі</summary>
                <SummaryRow label="Внутрішній SKU" value={isVerified ? finalSku : '—'} mono />
              </details>}
              {reservedCreationSku?.publicSku ? <div role="status">
                <SummaryRow label="Артикул товару" value={reservedCreationSku.publicSku} mono />
                <button type="button" className="text-xs underline" onClick={() => onCopyText?.(reservedCreationSku.publicSku)}>Копіювати артикул</button>
                <p className="text-xs text-slate-500">Зарезервовано для цього товару. Після збереження артикул залишиться таким самим.</p>
              </div> : <p className="text-xs text-slate-500">Артикул буде призначено сервером після збереження товару.</p>}
              {isVerified && !isNativeCreation && isVariationActive && (
                <p className="builder-summary-note">
                  Варіація #{String(variationData.variationNumber).padStart(3, '0')}
                </p>
              )}
              {isVerified && !isNativeCreation && !isVariationActive && previewData.existsInDb && (
                <p className="builder-summary-note is-warning">SKU вже існує</p>
              )}
            </div>

            {validationFailed && (
              <div className="builder-blockers" role="alert">
                <p>Перевірте дані</p>
                <ul>
                  {fieldBlockers.map((blocker) => (
                    <li key={blocker.fieldId}>{blocker.message}</li>
                  ))}
                  {generalVerificationError && <li>{generalVerificationError}</li>}
                </ul>
              </div>
            )}

            {onCreationPricingMode && <div className="builder-price-section"><label htmlFor="builder-price-mode" className="builder-summary-section-title">Як визначити ціну</label><select id="builder-price-mode" className="input" value={creationPricingMode} disabled={isVerifying || isSaving || isCreationSaveUncertain} onChange={(event) => { prepareForEdit(); onCreationPricingMode(event.target.value); }}><option value="system_auto">Автоматично</option><option value="manual_uah">Вручну, грн</option>{creationPricingAvailable && config.productCreation?.pricingDecision?.modes?.includes('usd_per_gram') && <option value="usd_per_gram">USD за грам</option>}</select>{creationPricingMode === 'manual_uah' && <label className="mc-label">Ручна ціна, грн<input id="builder-manual-price" className="input" type="text" inputMode="decimal" value={manualPriceUah} disabled={isVerifying || isSaving || isCreationSaveUncertain} onChange={(event) => { prepareForEdit(); onManualPriceChange(event.target.value); }} /></label>}{creationPricingMode === 'usd_per_gram' && <><label className="mc-label">USD за грам<input className="input" type="text" inputMode="decimal" value={creationUsdPerGram} disabled={isVerifying || isSaving || isCreationSaveUncertain} onChange={(event) => { prepareForEdit(); onCreationUsdPerGram(event.target.value); }} /></label><label><input type="checkbox" checked={creationMarketingRounding} disabled={isVerifying || isSaving || isCreationSaveUncertain} onChange={(event) => { prepareForEdit(); onCreationMarketingRounding(event.target.checked); }} /> Маркетингове округлення</label></>}</div>}
            <PriceSummary
              calculatedPriceUah={displayedPricing?.calculatedPriceUah}
              calculatedPriceUsd={isNativeCreation
                ? getFinalPriceUsd(displayedPricing?.calculatedPriceUah, displayedPricing?.uahRate)
                : displayedPricing?.totalPrice}
              finalPriceUah={displayedFinalPriceUah}
              finalPriceUsd={finalPriceUsd}
              pricePerGramUah={displayedPricing?.pricePerGramUah}
              pricePerGramUsd={displayedPricing?.pricePerGram}
              showPerGram={displayedPricing?.priceMode === 'per_gram_usd'}
            />

            {requiresPriceAttention && (
              <div className="builder-blockers" role="alert">
                <p>Автоматична ціна відсутня</p>
                <div className="mt-1">Вкажіть фінальну ціну вручну.</div>
              </div>
            )}
            {variationError && <div className="builder-operation-error" role="alert">{variationError}</div>}
            {saveError && <div className="builder-operation-error" role="alert">{saveError}</div>}
            {isCreationSaveUncertain && <p className="text-xs text-slate-600">Перевірка використовує точний запит попередньої спроби: повертає її збережений результат або завершує те саме збереження. До підтвердження результату введення збережено й заблоковано.</p>}

            {isVerified && onCreationPricingMode && <button type="button" className="btn btn-outline btn-compact"
              onClick={() => effectiveTotalPriceUah && onCopyText(`${formatDecimal(effectiveTotalPriceUah)} ₴`, 'Ціну')}>
              Копіювати ціну
            </button>}

            {isVerified && !onCreationPricingMode && !isCreationSaveUncertain && (
              <VerifiedPriceActions
                effectiveTotalPriceUah={effectiveTotalPriceUah}
                hasManualPrice={hasManualPrice}
                isManualPriceEditing={isManualPriceEditing}
                manualPriceUah={manualPriceUah}
                onCopyText={onCopyText}
                onManualPriceChange={onManualPriceChange}
                onResetManualPrice={onResetManualPrice}
                onStartManualPriceEdit={onStartManualPriceEdit}
                onStopManualPriceEdit={onStopManualPriceEdit}
              />
            )}
          </div>

          <div className="builder-summary-actions">
            {isVerified && previewData.creationNames?.ready && <div className="space-y-1 text-sm"><strong>Повні назви товару</strong><p>UA: {previewData.creationNames.names.all?.replaceAll('AG-PREVIEW', 'артикул після збереження')}</p><p>EN: {previewData.creationNames.names.en?.replaceAll('AG-PREVIEW', 'SKU after saving')}</p></div>}
            {isVerified && <TestProductNotice product={previewData} preview />}
            {isVerified && isNativeCreation && <CreationDeliveryNotice id={deliveryNoticeId}
                readiness={previewData.creationDeliveryReadiness} categoryCode={selectedCat}
                categoryLabel={category.name}
                onRequestIntegration={isCreationSaveUncertain ? undefined : onRequestIntegration}
                creatingRequest={creatingRequest} requestReceipt={requestReceipt}
              questionLabel={(config.questions[selectedCat] || []).find((question) => question.id === deliveryState?.questionKey)?.label}
              valueLabel={(config.questions[selectedCat] || []).find((question) => question.id === deliveryState?.questionKey)?.options?.find((option) => String(option.id) === previewData.creationDeliveryReadiness?.valueId)?.label}
              permissions={creationIntegrationPermissions} onRecheck={isCreationSaveUncertain ? undefined : handleVerify}
                busy={isVerifying || isSaving || photosPending} />}
              {integrationTaskError && <p role="alert" className="text-sm text-amber-900">{integrationTaskError}</p>}

            {photosPending && !isCreationSaveUncertain && <div id={mediaBlockerId} className="builder-media-blocker" role={photosFailed ? 'alert' : 'status'}>
              {isVerified && <p>Дані товару перевірено.</p>}
              <p>{photosFailed ? 'Фото не збережені. Повторіть збереження цих фото або приберіть їх зі спроби.' : 'Зачекайте завершення збереження фото. Товар поки не можна зберегти.'}</p>
              <button type="button" className="btn btn-outline" onClick={() => {
                photosPanelRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
                photosPanelRef.current?.focus({ preventScroll: true });
              }}>Перейти до фото</button>
            </div>}

            {isVerified ? (
              <div className="grid gap-2">
                <button
                  onClick={onSave}
                  className="btn btn-amber"
                  aria-describedby={[photosPending && !isCreationSaveUncertain ? mediaBlockerId : null, deliveryState ? deliveryNoticeId : null].filter(Boolean).join(' ') || undefined}
                  disabled={isVerifying || isSaving || !isCreationSaveUncertain && (isTestProduct && !canCreateTestProducts || previewData.creationNames?.ready === false || requiresPriceAttention || creationPhotos?.hasPendingUploads || Object.keys(serverErrors).length > 0)}
                >
                  {isSaving ? isCreationSaveUncertain ? 'Перевіряємо результат…' : 'Зберігаємо...' : isCreationSaveUncertain ? 'Перевірити результат збереження' : 'Зберегти товар'}
                </button>
                {!isNativeCreation && <button onClick={onAddVariation} className="btn btn-primary" disabled={isVariationLoading}>
                  {isVariationLoading ? 'Підбираємо...' : 'Додати варіацію'}
                </button>}
              </div>
            ) : (
              <button
                onClick={handleVerify}
                className="btn btn-amber w-full"
                aria-describedby={photosPending ? mediaBlockerId : undefined}
                disabled={isVerifying || creationPhotos?.hasPendingUploads || isTestProduct && !canCreateTestProducts}
              >
                {isVerifying ? 'Перевіряємо…' : 'Перевірити дані'}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function WeightField({ blocker, disabled, prepareForEdit, setWeight, weight }) {
  const blockerMessageId = 'builder-blocker-weight';

  return (
    <div
      data-builder-blocker={blocker ? 'true' : undefined}
      tabIndex={blocker ? -1 : undefined}
      className={`builder-field-row is-accounting ${blocker ? 'is-invalid' : ''}`}
    >
      <div className="builder-field-label">
        <label htmlFor="builder-weight">
          Вага виробу (г)
          <span className="required-marker" aria-label="обов’язкове поле">*</span>
        </label>
      </div>
      <div>
        <input
          id="builder-weight"
          type="text"
          inputMode="decimal"
          onKeyDown={(event) => {
            if (event.key === '-') event.preventDefault();
            handleNumberKeyDown(event);
          }}
          onWheel={handleNumberWheel}
          value={weight}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            prepareForEdit();
            setWeight(value);
          }}
          className="input builder-weight-input"
          placeholder="0.00"
          aria-invalid={blocker ? 'true' : undefined}
          aria-describedby={blocker ? blockerMessageId : undefined}
        />
        {blocker && (
          <p id={blockerMessageId} className="builder-field-error" role="alert">
            {blocker.message}
          </p>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, danger = false, strong = false, mono = false }) {
  return (
    <div className="builder-summary-row">
      <span>{label}</span>
      <span className={`${strong ? 'is-strong' : ''} ${danger ? 'is-danger' : ''} ${mono ? 'font-mono' : ''}`.trim()}>
        {value}
      </span>
    </div>
  );
}

function PriceSummary({
  calculatedPriceUah,
  calculatedPriceUsd,
  finalPriceUah,
  finalPriceUsd,
  pricePerGramUah,
  pricePerGramUsd,
  showPerGram,
}) {
  return (
    <>
      <div className="builder-price-section">
        <p className="builder-summary-section-title">Ціна</p>
        <PriceRow
          label="Розрахункова"
          uah={formatPositivePrice(calculatedPriceUah, formatWholeUah)}
          usd={formatPositivePrice(calculatedPriceUsd, formatUsd)}
        />
        <PriceRow
          label="Фінальна"
          uah={formatPositivePrice(finalPriceUah, formatUah)}
          usd={formatPositivePrice(finalPriceUsd, formatUsd)}
          strong
        />
      </div>
      <div className="builder-price-section">
        <p className="builder-summary-section-title">За грам · ₴ / USD</p>
        <PriceRow
          label="Розрахункова"
          uah={showPerGram ? formatPositivePrice(pricePerGramUah, formatUahPerGram) : '—'}
          usd={showPerGram ? formatPositivePrice(pricePerGramUsd, formatUsd) : '—'}
        />
      </div>
    </>
  );
}

function PriceRow({ label, uah, usd, strong = false }) {
  return (
    <div className={`builder-price-row ${strong ? 'is-strong' : ''}`}>
      <span>{label}</span>
      <span>{uah}</span>
      <span>{usd}</span>
    </div>
  );
}

function VerifiedPriceActions({
  effectiveTotalPriceUah,
  hasManualPrice,
  isManualPriceEditing,
  manualPriceUah,
  onCopyText,
  onManualPriceChange,
  onResetManualPrice,
  onStartManualPriceEdit,
  onStopManualPriceEdit,
}) {
  return (
    <div className="border-t border-slate-200 pt-3">
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => effectiveTotalPriceUah
            && onCopyText(`${formatDecimal(effectiveTotalPriceUah)} ₴`, 'Ціну')}
          className="btn btn-outline btn-compact"
        >
          Копіювати ціну
        </button>
        <button
          onClick={isManualPriceEditing ? onStopManualPriceEdit : onStartManualPriceEdit}
          className="btn btn-outline btn-compact"
        >
          {isManualPriceEditing ? 'Готово' : 'Змінити ціну'}
        </button>
        {hasManualPrice && (
          <button onClick={onResetManualPrice} className="btn btn-outline btn-compact">
            Скинути ручну
          </button>
        )}
      </div>
      {isManualPriceEditing && (
        <div className="mt-3">
          <label htmlFor="builder-manual-price" className="mb-1 block text-xs font-medium text-slate-600">
            Ручна ціна, грн
          </label>
          <input
            id="builder-manual-price"
            type="number"
            min="0.01"
            step="0.01"
            value={manualPriceUah}
            onChange={(event) => onManualPriceChange(event.target.value)}
            className="input w-full"
            placeholder="Введіть ціну"
          />
        </div>
      )}
    </div>
  );
}
