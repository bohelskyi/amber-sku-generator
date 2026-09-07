import { useEffect, useRef, useState } from 'react';
import {
  formatDecimal,
  formatUah,
  formatUahPerGram,
  formatUsd,
  formatWholeUah,
} from '../../lib/formatters';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';

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
  weight,
  setWeight,
  isWeightRequired,
  answeredRequiredCount,
  requiredCount,
  previewData,
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
  requiresManualPrice,
  manualPriceUah,
  saveError,
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
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [verificationError, setVerificationError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const category = config.categories[selectedCat];
  const isVerified = Boolean(previewData);
  const visibleQuestions = (config.questions[selectedCat] || []).filter((question) =>
    isQuestionVisible(question, answers)
  );
  const hasValidWeight = !isWeightRequired
    || (weight !== '' && Number.isFinite(Number(weight)) && Number(weight) > 0);
  const fieldBlockers = visibleQuestions.reduce((blockers, question) => {
    const value = answers[question.id];
    const textQuestion = isTextQuestion(question);
    const visibleOptions = getVisibleOptionsForQuestion(question, answers);
    const hasAvailableControl = textQuestion || visibleOptions.length > 0;

    if (question.required === 1 && hasAvailableControl && !hasAnswer(value)) {
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
    return blockers;
  }, []);

  if (!hasValidWeight) {
    fieldBlockers.push({
      fieldId: 'weight',
      message: 'Вага виробу має бути більшою за 0.',
    });
  }
  const displayedPricing = previewData || (fieldBlockers.length === 0 ? livePriceData : null);

  const matchingServerQuestion = verificationError
    ? visibleQuestions.find((question) => verificationError.includes(`«${question.label}»`))
    : null;
  if (matchingServerQuestion
    && !fieldBlockers.some((blocker) => blocker.fieldId === matchingServerQuestion.id)) {
    fieldBlockers.push({ fieldId: matchingServerQuestion.id, message: verificationError });
  }

  const validationVisible = verificationAttempt > 0 && !isVerified;
  const validationFailed = validationVisible
    && (fieldBlockers.length > 0 || Boolean(verificationError));
  const blockerByFieldId = new Map(
    (validationVisible ? fieldBlockers : []).map((blocker) => [blocker.fieldId, blocker])
  );
  const generalVerificationError = verificationError && !matchingServerQuestion
    ? verificationError
    : '';
  const requiresPriceAttention = isVerified && requiresManualPrice && !hasManualPrice;
  const verifiedHasError = isVerified && Boolean(saveError || variationError);
  const summaryNeedsAttention = validationFailed || requiresPriceAttention || verifiedHasError;
  const summaryStateClass = summaryNeedsAttention
    ? 'is-error'
    : isVerified
      ? 'is-success'
      : 'is-neutral';
  const summaryStateLabel = summaryNeedsAttention
    ? 'Потрібна увага'
    : isVerified
      ? 'Перевірено'
      : displayedPricing || (isLivePriceLoading && fieldBlockers.length === 0)
        ? 'Потрібна перевірка'
        : 'Не перевірено';
  const summaryWeight = isVerified
    ? previewData.weightVal
    : hasValidWeight && isWeightRequired
      ? weight
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
    firstBlocker?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstBlocker?.focus({ preventScroll: true });
  }, [verificationAttempt, validationFailed, validationVisible]);

  const prepareForEdit = () => {
    if (isVerified) setVerificationAttempt(0);
    setVerificationError('');
  };

  const handleVerify = async () => {
    setVerificationError('');
    setVerificationAttempt((attempt) => attempt + 1);
    if (fieldBlockers.length > 0) return;

    setIsVerifying(true);
    try {
      await onPreview();
    } catch (error) {
      setVerificationError(error.response?.data?.error || error.message);
      setVerificationAttempt((attempt) => attempt + 1);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div ref={workspaceRef} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="builder-workspace card overflow-hidden fade-up">
        <header className="builder-header">
          <h2 className="section-title-text">{category.name}</h2>
          <button onClick={onCancel} className="btn btn-ghost">Скасувати</button>
        </header>

        <div className="builder-field-list">
          {visibleQuestions.map((question) => {
            const visibleOptions = getVisibleOptionsForQuestion(question, answers);
            const textQuestion = isTextQuestion(question);
            const isRequired = question.required === 1
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
                    {question.label}
                    {isRequired && <span className="required-marker" aria-label="обов’язкове поле">*</span>}
                  </label>
                </div>

                <div className="min-w-0">
                  {textQuestion ? (
                    <input
                      id={`builder-${question.id}`}
                      type="text"
                      className="input builder-text-input"
                      value={answers[question.id] || ''}
                      onChange={(event) => {
                        prepareForEdit();
                        onTextAnswer(question.id, event.target.value);
                      }}
                      disabled={isVerifying}
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
                            disabled={isVerifying}
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

          {isWeightRequired && (
            <WeightField
              blocker={blockerByFieldId.get('weight')}
              disabled={isVerifying}
              prepareForEdit={prepareForEdit}
              setWeight={setWeight}
              weight={weight}
            />
          )}
        </div>
      </section>

      <aside className="fade-up stagger-1 lg:sticky lg:top-20">
        <div className="builder-summary card overflow-hidden">
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
                value={isWeightRequired
                  ? (summaryWeight !== null ? `${formatDecimal(summaryWeight)} г` : '—')
                  : 'Не потрібна'}
                danger={validationFailed && isWeightRequired && !hasValidWeight}
              />
              <SummaryRow label="SKU" value={isVerified ? finalSku : '—'} strong={isVerified} mono />
              {isVerified && isVariationActive && (
                <p className="builder-summary-note">
                  Варіація #{String(variationData.variationNumber).padStart(3, '0')}
                </p>
              )}
              {isVerified && !isVariationActive && previewData.existsInDb && (
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

            <PriceSummary
              calculatedPriceUah={displayedPricing?.calculatedPriceUah}
              calculatedPriceUsd={displayedPricing?.totalPrice}
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

            {isVerified && (
              <VerifiedPriceActions
                effectiveTotalPriceUah={effectiveTotalPriceUah}
                finalSku={finalSku}
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
            {isVerified ? (
              <div className="grid gap-2">
                <button
                  onClick={onSave}
                  className="btn btn-amber"
                  disabled={isSaving || requiresPriceAttention}
                >
                  {isSaving ? 'Зберігаємо...' : 'Зберегти товар'}
                </button>
                <button onClick={onAddVariation} className="btn btn-primary" disabled={isVariationLoading}>
                  {isVariationLoading ? 'Підбираємо...' : 'Додати варіацію'}
                </button>
              </div>
            ) : (
              <button
                onClick={handleVerify}
                className="btn btn-amber w-full"
                disabled={isVerifying}
              >
                {isVerifying ? 'Перевіряємо…' : 'Розрахувати SKU і ціну'}
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
          type="number"
          min="0"
          onKeyDown={(event) => {
            if (event.key === '-') event.preventDefault();
            handleNumberKeyDown(event);
          }}
          onWheel={handleNumberWheel}
          value={weight}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value < 0) return;
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
        <p className="builder-summary-section-title">За грам</p>
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
  finalSku,
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
        <button onClick={() => onCopyText(finalSku, 'SKU')} className="btn btn-outline min-h-8 px-2.5 py-1 text-xs">
          Копіювати SKU
        </button>
        <button
          onClick={() => effectiveTotalPriceUah
            && onCopyText(`${formatDecimal(effectiveTotalPriceUah)} ₴`, 'Ціну')}
          className="btn btn-outline min-h-8 px-2.5 py-1 text-xs"
        >
          Копіювати ціну
        </button>
        <button
          onClick={isManualPriceEditing ? onStopManualPriceEdit : onStartManualPriceEdit}
          className="btn btn-outline min-h-8 px-2.5 py-1 text-xs"
        >
          {isManualPriceEditing ? 'Готово' : 'Змінити ціну'}
        </button>
        {hasManualPrice && (
          <button onClick={onResetManualPrice} className="btn btn-outline min-h-8 px-2.5 py-1 text-xs">
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
