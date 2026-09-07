import { useEffect, useRef } from 'react';
import {
  formatDateTime,
  formatDecimal,
  formatDecodedSuffix,
  formatUah,
  formatUahPerGram,
  formatWholeUah,
  formatUsd,
} from '../../lib/formatters';
import { getAnswerValueLabel, getQuestionLabel } from '../../lib/answer-labels';
import {
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
} from '../../lib/sku-visibility';
import {
  focusFirstRecountBlocker,
  formatRecountBlockerSummary,
} from '../../lib/recount-blockers';
import { getDecodedAnswerMap } from '../../lib/product-recount';

function getPricingSourceLabel(source) {
  return source === 'stored' ? 'Збережена в базі' : 'Перерахована зараз';
}

export function DecodeErrorPanel({ details, message }) {
  const issue = details?.issue;

  return (
    <div className="danger-panel mt-4 p-4 text-sm">
      <div className="font-semibold">{message}</div>

      {details?.type === 'unknown_category' && (
        <div className="mt-3 space-y-3">
          <div className="text-slate-700">
            Отриманий код: <span className="font-mono font-semibold">{details.received}</span>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Доступні категорії
            </div>
            <div className="flex flex-wrap gap-2">
              {(details.categories || []).map((category) => (
                <span key={category.code} className="chip normal-case tracking-normal">
                  <span className="font-mono">{category.code}</span> {category.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {details?.type === 'sku_config_mismatch' && (
        <div className="mt-3 space-y-3 text-slate-700">
          <div>
            Категорія: <span className="font-semibold">{details.category?.name}</span>{' '}
            <span className="font-mono text-slate-500">({details.category?.code})</span>
          </div>
          {issue?.questionLabel && (
            <div>
              Питання №{issue.position}: <span className="font-semibold">{issue.questionLabel}</span>
            </div>
          )}
          {issue?.remaining && (
            <div>
              Нерозібраний фрагмент:{' '}
              <span className="break-all font-mono font-semibold">{issue.remaining}</span>
            </div>
          )}
          {issue?.expected?.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Допустимі значення
              </div>
              <div className="flex flex-wrap gap-2">
                {issue.expected.map((option) => (
                  <span key={`${option.code}-${option.label}`} className="chip normal-case tracking-normal">
                    <span className="font-mono">{option.code}</span> {option.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HomeDashboard({
  config,
  exportStatus,
  skuToDecode,
  decodeData,
  decodeError,
  decodeErrorDetails,
  hasRecountChanges,
  isRecountApplying,
  isRecountLoading,
  isRecountOpen,
  recountAnswers,
  recountBlockers,
  recountError,
  recountPreview,
  recountReason,
  recountSuccess,
  recountValidationAttempt,
  recountMode = 'apply',
  onApplyRecount,
  onCancelRecount,
  onRecountAnswer,
  onRecountPreview,
  onRecountReasonChange,
  onRecountTextAnswer,
  onStart,
  onStartRecount,
  onDecode,
  onDecodeInputChange,
}) {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
        <section className="card p-4 sm:p-5 fade-up stagger-1">
          <div className="section-title mb-4">
            <div>
              <p className="eyebrow">Створити SKU</p>
              <h2 className="section-title-text">Оберіть категорію</h2>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Object.values(config.categories).map((category) => (
              <button
                key={category.code}
                onClick={() => onStart(category.code)}
                className="category-card"
              >
                <div className="flex items-center gap-3">
                  <span className="category-code">{category.code}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-900">{category.name}</div>
                    <div className="category-meta">
                      {category.requires_weight === 1 ? 'Вага обов’язкова' : 'Без ваги'}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <div className="space-y-4 fade-up stagger-2">
          <div className="card p-5">
            <p className="eyebrow">Розшифрувати SKU</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">Знайти та перевірити товар</h2>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row lg:flex-col">
              <input
                type="text"
                value={skuToDecode}
                onChange={(event) => onDecodeInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onDecode();
                }}
                placeholder="Наприклад, BN123456001"
                aria-label="Артикул для розшифрування"
                className="input min-w-0"
              />
              <button onClick={() => onDecode()} className="btn btn-primary shrink-0">
                Розшифрувати
              </button>
            </div>

            {decodeError && (
              <DecodeErrorPanel details={decodeErrorDetails} message={decodeError} />
            )}
          </div>

          <div className="utility-strip">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-700">Експорт</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {exportStatus
                    ? (exportStatus.hasExport
                      ? `Останній: ${formatDateTime(exportStatus.lastExport?.createdAt)}`
                      : 'Експортів ще не було')
                    : 'Завантаження статусу...'}
                </p>
              </div>
              <span className="status-badge is-neutral">
                {exportStatus ? `${exportStatus.countSinceLastExport} нових` : '...'}
              </span>
            </div>
            {exportStatus && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>У базі: {exportStatus.totalProducts}</span>
                {exportStatus.exportableProducts !== undefined && <span>До експорту: {exportStatus.exportableProducts}</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {decodeData && (
        <DecodeWorkspace
          config={config}
          decodeData={decodeData}
          hasRecountChanges={hasRecountChanges}
          isRecountApplying={isRecountApplying}
          isRecountLoading={isRecountLoading}
          isRecountOpen={isRecountOpen}
          recountAnswers={recountAnswers}
          recountBlockers={recountBlockers}
          recountError={recountError}
          recountPreview={recountPreview}
          recountReason={recountReason}
          recountValidationAttempt={recountValidationAttempt}
          recountSuccess={recountSuccess}
          recountMode={recountMode}
          onApplyRecount={onApplyRecount}
          onCancelRecount={onCancelRecount}
          onRecountAnswer={onRecountAnswer}
          onRecountPreview={onRecountPreview}
          onRecountReasonChange={onRecountReasonChange}
          onRecountTextAnswer={onRecountTextAnswer}
          onStartRecount={onStartRecount}
        />
      )}
    </div>
  );
}

export function DecodeWorkspace({
  config,
  decodeData,
  hasRecountChanges,
  isRecountApplying,
  isRecountLoading,
  isRecountOpen,
  recountAnswers,
  recountBlockers,
  recountError,
  recountPreview,
  recountReason,
  recountSuccess,
  recountValidationAttempt,
  onApplyRecount,
  onCancelRecount,
  onRecountAnswer,
  onRecountPreview,
  onRecountReasonChange,
  onRecountTextAnswer,
  onStartRecount,
  recountMode = 'apply',
}) {
  const isCalibrationUnknown = decodeData.calibration?.status === 'unknown';
  const isCalibrationBlockingPrice = isCalibrationUnknown && !decodeData.pricing;
  const pricingConditions = decodeData.pricing?.conditions?.filter(
    (condition) => !condition.isInSku
  ) || [];
  const pricing = decodeData.pricing;
  const productStatus = getDecodedProductStatus(decodeData);
  const summaryStateClass = productStatus === 'Активний'
    ? 'is-success'
    : 'is-neutral';
  const decodedWeight = pricing?.weight
    ?? decodeData.product?.weight
    ?? (decodeData.suffix.type === 'weight' ? decodeData.suffix.value : null);
  const calculatedPriceUah = pricing?.calculatedPriceUah;
  const automaticPriceUah = pricing?.automaticPriceUah;
  const finalStoredPriceUah = decodeData.existsInDb ? pricing?.totalPriceUah : null;
  const hasRoundingDifference = calculatedPriceUah !== null
    && calculatedPriceUah !== undefined
    && automaticPriceUah !== null
    && automaticPriceUah !== undefined
    && Number(calculatedPriceUah) !== Number(automaticPriceUah);
  const storedPriceSource = getRecountPriceSource({
    manualPriceUah: decodeData.product?.details?.manualPriceUah,
    totalPriceUah: finalStoredPriceUah,
  });

  if (isRecountOpen) {
    return (
      <section className="fade-up stagger-3">
        <RecountPanel
          config={config}
          decodeData={decodeData}
          hasRecountChanges={hasRecountChanges}
          isRecountApplying={isRecountApplying}
          isRecountLoading={isRecountLoading}
          recountAnswers={recountAnswers}
          recountBlockers={recountBlockers}
          recountError={recountError}
          recountPreview={recountPreview}
          recountReason={recountReason}
          recountValidationAttempt={recountValidationAttempt}
          onApplyRecount={onApplyRecount}
          onCancelRecount={onCancelRecount}
          onRecountAnswer={onRecountAnswer}
          onRecountPreview={onRecountPreview}
          onRecountReasonChange={onRecountReasonChange}
          onRecountTextAnswer={onRecountTextAnswer}
          recountMode={recountMode}
        />
      </section>
    );
  }

  return (
    <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px] fade-up stagger-3">
      <div className="decode-workspace builder-workspace card overflow-hidden">
        <header className="builder-header">
          <div className="min-w-0">
            <h2 className="section-title-text">{decodeData.category.name}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Результат декодування
              {decodeData.decodeSource === 'stored_history' ? ' · історична схема' : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {pricing?.dependentKeys?.length > 0 && (
              <span className="decode-price-key">
                <span aria-hidden="true" />
                Впливає на ціну
              </span>
            )}
            <span className="font-mono text-xs font-semibold text-slate-500">
              {decodeData.category.code}
            </span>
          </div>
        </header>

        <div className="builder-field-list">
          {decodeData.decodedAnswers.map((item) => {
            const isPriceDriver = decodeData.pricing?.dependentKeys?.includes(item.key);

            return (
              <div
                key={item.key}
                className={`decode-field-row builder-field-row ${isPriceDriver ? 'is-price-driver' : ''}`}
              >
                <div className="builder-field-label">
                  <label>{item.label}</label>
                </div>
                <div className="decode-readonly-value">{item.value_label}</div>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="sticky-summary-container">
        <div className="sticky-summary builder-summary card overflow-hidden">
          <div className="builder-summary-header">
            <h3>Підсумок</h3>
            <span className={`builder-state ${summaryStateClass}`}>
              <span aria-hidden="true" />
              {productStatus}
            </span>
          </div>

          <div className="builder-summary-body">
            <div className="builder-summary-group first">
              <DecodeSummaryRow label="SKU" value={decodeData.sku} mono strong />
              <DecodeSummaryRow label="Стан у базі" value={productStatus} />
            </div>

            {isCalibrationBlockingPrice && (
              <div className="decode-warning">
                <p>Ціну не визначено</p>
                <span>Калібрування відсутнє у збережених параметрах товару.</span>
              </div>
            )}

            <div className="builder-summary-group">
              <p className="builder-summary-section-title">Ціна виробу</p>
              <DecodeSummaryRow
                label="Розраховано до округлення"
                value={formatOptionalValue(calculatedPriceUah, formatWholeUah)}
              />
              {hasRoundingDifference && (
                <p className="decode-rounding-note">
                  Округлення: {formatWholeUah(calculatedPriceUah)} → {formatUah(automaticPriceUah)}
                  {' '}({formatSignedRoundedUah(Number(automaticPriceUah) - Number(calculatedPriceUah))})
                </p>
              )}
              <DecodeSummaryRow
                label="Фінальна збережена"
                value={formatOptionalValue(finalStoredPriceUah, formatUah)}
                strong
              />
            </div>

            <div className="builder-price-section">
              <p className="builder-summary-section-title">Розрахункова ціна за грам</p>
              <div className="builder-price-row is-strong">
                <span />
                <span>{formatOptionalValue(pricing?.pricePerGramUah, formatUahPerGram)}</span>
                <span>{formatOptionalValue(pricing?.pricePerGram, formatUsd)}</span>
              </div>
            </div>

            <div className="builder-summary-group">
              <DecodeSummaryRow label="Матриця" value={pricing?.matrixName || '—'} />
              <DecodeSummaryRow
                label="Вага"
                value={decodedWeight !== null && decodedWeight !== undefined
                  ? `${formatDecimal(decodedWeight)} г`
                  : '—'}
              />
            </div>

            <details className="decode-details">
              <summary>Деталі розрахунку</summary>
              <div className="decode-details-body">
                <DecodeSummaryRow label="Базовий SKU" value={decodeData.baseSku} mono />
                <DecodeSummaryRow
                  label={decodeData.variation
                    ? 'Варіація'
                    : decodeData.suffix.type === 'weight'
                      ? 'Суфікс ваги'
                      : decodeData.suffix.type === 'sequence'
                        ? 'Порядковий номер'
                        : 'Суфікс'}
                  value={decodeData.variation
                    ? decodeData.variation.suffix
                    : formatDecodedSuffix(decodeData.suffix)}
                />
                {decodeData.variation && (
                  <DecodeSummaryRow
                    label="Основний артикул"
                    value={`${decodeData.baseSku}${decodeData.suffix.raw || ''}`}
                    mono
                  />
                )}
                <DecodeSummaryRow
                  label="Схема SKU"
                  value={`V${decodeData.skuSchema.version}${decodeData.skuSchema.marker ? ` · ${decodeData.skuSchema.marker}` : ''}`}
                />
                <DecodeSummaryRow
                  label="Джерело розрахунку"
                  value={pricing ? getPricingSourceLabel(pricing.source) : '—'}
                />
                <DecodeSummaryRow
                  label="Тип фінальної ціни"
                  value={finalStoredPriceUah !== null && finalStoredPriceUah !== undefined
                    ? storedPriceSource
                    : '—'}
                />

                {pricingConditions.length > 0 && (
                  <div className="decode-details-section">
                    <p>Цінові умови</p>
                    {pricingConditions.map((condition) => (
                      <DecodeSummaryRow
                        key={condition.key}
                        label={getQuestionLabel(config, decodeData.category.code, condition.key)}
                        value={getAnswerValueLabel(
                          config,
                          decodeData.category.code,
                          condition.key,
                          condition.value
                        )}
                      />
                    ))}
                  </div>
                )}

                {decodeData.decodedAnswers.some((item) => item.value_id !== null) && (
                  <div className="decode-details-section">
                    <p>Внутрішні значення</p>
                    {decodeData.decodedAnswers
                      .filter((item) => item.value_id !== null)
                      .map((item) => (
                        <DecodeSummaryRow
                          key={item.key}
                          label={item.label}
                          value={item.value_id}
                          mono
                        />
                      ))}
                  </div>
                )}

                {pricing?.logMessage && (
                  <div className="decode-details-section">
                    <p>Діагностика ціни</p>
                    <div className="text-xs leading-5 text-slate-600">{pricing.logMessage}</div>
                  </div>
                )}
              </div>
            </details>

            {recountSuccess && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {recountSuccess}
              </div>
            )}
          </div>

          {decodeData.existsInDb && (
            <div className="builder-summary-actions">
              <button onClick={onStartRecount} className="btn btn-primary w-full">
                {recountMode === 'request' ? 'Підготувати запит' : 'Переоблікувати'}
              </button>
            </div>
          )}
        </div>
      </aside>
    </section>
  );
}

function DecodeSummaryRow({ label, mono = false, strong = false, value }) {
  return (
    <div className="builder-summary-row">
      <span>{label}</span>
      <span className={`${mono ? 'font-mono break-all' : ''} ${strong ? 'is-strong' : ''}`.trim()}>
        {value}
      </span>
    </div>
  );
}

function getDecodedProductStatus(decodeData) {
  if (!decodeData.existsInDb) return 'Не в базі';
  if (decodeData.product?.status === 'archived') return 'Архівний';
  if (decodeData.product?.status === 'corrected') return 'Переоблікований';
  return 'Активний';
}

function RecountPanel({
  config,
  decodeData,
  hasRecountChanges,
  isRecountApplying,
  isRecountLoading,
  recountAnswers,
  recountBlockers = [],
  recountError,
  recountPreview,
  recountReason,
  recountValidationAttempt = 0,
  onApplyRecount,
  onCancelRecount,
  onRecountAnswer,
  onRecountPreview,
  onRecountReasonChange,
  onRecountTextAnswer,
  recountMode = 'apply',
}) {
  const panelRef = useRef(null);
  const categoryCode = decodeData.category.code;
  const categoryQuestions = config.questions?.[categoryCode] || [];
  const originalAnswers = getDecodedAnswerMap(decodeData);
  const visibleQuestions = categoryQuestions.filter((question) =>
    isQuestionVisible(question, recountAnswers, recountAnswers.is_calibrated ?? null)
  );
  const blockerByQuestionId = new Map(
    recountBlockers.map((blocker) => [blocker.questionId, blocker])
  );
  const localChanges = visibleQuestions
    .filter((question) => isRecountAnswerChanged(
      originalAnswers[question.id],
      recountAnswers[question.id]
    ))
    .map((question) => ({
      key: question.id,
      from: originalAnswers[question.id],
      to: recountAnswers[question.id],
    }));
  const displayedChanges = recountPreview?.changes || localChanges;
  const currentPricing = decodeData.pricing;
  const correctedPricing = recountPreview?.corrected;
  const currentMatrix = currentPricing?.matrixName || null;
  const correctedMatrix = correctedPricing?.pricingDetails?.scenario?.name || null;
  const currentPriceSource = getRecountPriceSource({
    manualPriceUah: decodeData.product?.details?.manualPriceUah,
    totalPriceUah: currentPricing?.totalPriceUah,
  });
  const correctedPriceSource = correctedPricing
    ? getRecountPriceSource({
      manualPriceUah: correctedPricing.manualPriceUah,
      totalPriceUah: correctedPricing.totalPriceUah,
    })
    : null;
  const needsAttention = recountBlockers.length > 0 || Boolean(recountError);
  const summaryStateClass = needsAttention
    ? 'is-error'
    : recountPreview
      ? 'is-success'
      : 'is-neutral';
  const summaryStateLabel = needsAttention
    ? 'Потрібна увага'
    : isRecountLoading
      ? 'Перераховуємо…'
      : recountPreview
        ? 'Перераховано'
        : hasRecountChanges
          ? 'Потрібен перерахунок'
          : 'Без змін';

  useEffect(() => {
    if (recountValidationAttempt > 0) focusFirstRecountBlocker(panelRef.current);
  }, [recountValidationAttempt]);

  return (
    <div ref={panelRef} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="recount-workspace builder-workspace card overflow-hidden">
        <header className="builder-header">
          <div className="min-w-0">
            <h2 className="section-title-text">{decodeData.category.name}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {recountMode === 'request' ? 'Запит на виправлення' : 'Переоблік товару'}
            </p>
          </div>
          <button onClick={onCancelRecount} className="btn btn-ghost">
            Скасувати
          </button>
        </header>

        <div className="builder-field-list">
          {visibleQuestions.map((question) => {
            const textQuestion = isTextQuestion(question);
            const visibleOptions = getVisibleOptionsForQuestion(
              question,
              recountAnswers,
              recountAnswers.is_calibrated ?? null
            );
            const isRequired = question.required === 1
              && (textQuestion || visibleOptions.length > 0);
            const isChanged = isRecountAnswerChanged(
              originalAnswers[question.id],
              recountAnswers[question.id]
            );
            const blocker = blockerByQuestionId.get(question.id);
            const blockerMessageId = `recount-blocker-${question.id}`;

            return (
              <div
                key={question.id}
                data-recount-blocker={blocker ? 'true' : undefined}
                tabIndex={blocker ? -1 : undefined}
                className={`recount-field-row builder-field-row ${isChanged ? 'is-changed' : ''} ${blocker ? 'is-invalid' : ''}`}
              >
                <div className="builder-field-label">
                  <label htmlFor={textQuestion ? `recount-${question.id}` : undefined}>
                    {question.label}
                    {isRequired && (
                      <span className="required-marker" aria-label="обов’язкове поле">*</span>
                    )}
                  </label>
                </div>
                <div className="min-w-0">
                  {textQuestion ? (
                    <input
                      id={`recount-${question.id}`}
                      type="text"
                      className="input builder-text-input"
                      value={recountAnswers[question.id] || ''}
                      onChange={(event) => onRecountTextAnswer(question.id, event.target.value)}
                      disabled={isRecountLoading || isRecountApplying}
                      aria-invalid={blocker ? 'true' : undefined}
                      aria-describedby={blocker ? blockerMessageId : undefined}
                    />
                  ) : (
                    <div
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label={question.label}
                      aria-invalid={blocker ? 'true' : undefined}
                      aria-describedby={blocker ? blockerMessageId : undefined}
                    >
                    {question.required !== 1
                      && !visibleOptions.some((option) => Number(option.id) === 0) && (
                      <button
                        onClick={() => onRecountAnswer(question.id, null)}
                        disabled={isRecountLoading || isRecountApplying}
                        className={`option-pill builder-option ${
                          Number(recountAnswers[question.id] || 0) === 0
                            ? 'option-pill-active'
                            : 'option-pill-idle'
                        }`}
                        aria-pressed={Number(recountAnswers[question.id] || 0) === 0}
                      >
                        Не обрано
                      </button>
                    )}
                      {visibleOptions.map((option) => {
                        const isSelected = Number(recountAnswers[question.id]) === Number(option.id);
                        return (
                          <button
                            key={option.id}
                            onClick={() => onRecountAnswer(question.id, option.id)}
                            disabled={isRecountLoading || isRecountApplying}
                            className={`option-pill builder-option ${isSelected ? 'option-pill-active' : 'option-pill-idle'}`}
                            aria-pressed={isSelected}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {isChanged && (
                    <div className="recount-inline-change">
                      <span>{getAnswerValueLabel(config, categoryCode, question.id, originalAnswers[question.id])}</span>
                      <span aria-hidden="true">→</span>
                      <span>{getAnswerValueLabel(config, categoryCode, question.id, recountAnswers[question.id])}</span>
                    </div>
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
        </div>

        <div className="border-t border-slate-200 px-5 py-4 sm:px-6">
          <div className="grid gap-1.5 md:grid-cols-[180px_minmax(0,1fr)] md:gap-4">
            <label htmlFor="recount-reason" className="pt-1.5 text-[13px] font-medium text-slate-700">
              {recountMode === 'request' ? 'Коментар до запиту' : 'Причина переобліку'}
            </label>
            <textarea
              id="recount-reason"
              className="input min-h-20 resize-y"
              value={recountReason}
              onChange={(event) => onRecountReasonChange(event.target.value)}
              placeholder="Наприклад: виправлено сорт після перевірки"
            />
          </div>
        </div>
      </section>

      <aside className="sticky-summary-container">
        <div className="sticky-summary builder-summary card overflow-hidden">
          <div className="builder-summary-header">
            <h3>Порівняння</h3>
            <span className={`builder-state ${summaryStateClass}`}>
              <span aria-hidden="true" />
              {summaryStateLabel}
            </span>
          </div>

          <div className="builder-summary-body">
            <div className="recount-comparison">
              <div className="recount-comparison-header" aria-hidden="true">
                <span />
                <span>Зараз</span>
                <span>Після</span>
              </div>
              <RecountComparisonRow
                label="SKU"
                current={decodeData.sku}
                next={correctedPricing?.fullSku}
                mono
              />
              <RecountComparisonRow
                label="Ціна виробу"
                current={formatOptionalValue(currentPricing?.totalPriceUah, formatUah)}
                next={formatOptionalValue(correctedPricing?.totalPriceUah, formatUah)}
              />
              <RecountComparisonRow
                label="Ціна за грам"
                current={formatOptionalValue(currentPricing?.pricePerGramUah, formatUahPerGram)}
                next={formatOptionalValue(correctedPricing?.pricePerGramUah, formatUahPerGram)}
              />
              <RecountComparisonRow
                label="Матриця"
                current={currentMatrix}
                next={correctedMatrix}
              />
              <RecountComparisonRow
                label="Джерело"
                current={currentPriceSource}
                next={correctedPriceSource}
              />
            </div>

            <div className="builder-summary-group">
              <div className="builder-summary-row">
                <span>Різниця в ціні</span>
                <span className="is-strong">
                  {recountPreview ? formatSignedUah(recountPreview.priceDeltaUah) : '—'}
                </span>
              </div>
            </div>

            <div className="builder-summary-group">
              <p className="builder-summary-section-title">Змінені атрибути</p>
              {displayedChanges.length > 0 ? (
                <div className="divide-y divide-slate-100">
                  {displayedChanges.map((change) => (
                    <div key={change.key} className="recount-change-row">
                      <span>{getQuestionLabel(config, categoryCode, change.key)}</span>
                      <span>
                        <span>{getAnswerValueLabel(config, categoryCode, change.key, change.from)}</span>
                        <span aria-hidden="true"> → </span>
                        <strong>{getAnswerValueLabel(config, categoryCode, change.key, change.to)}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Змін немає.</p>
              )}
            </div>

            {recountPreview?.corrected.variation && (
              <p className="builder-summary-note is-warning">
                Новий SKU буде варіацією наявного артикула.
              </p>
            )}

            {recountBlockers.length > 0 && (
              <div className="builder-blockers" role="alert">
                <p>{formatRecountBlockerSummary(recountBlockers.length)}</p>
                <ul>
                  {recountBlockers.map((blocker) => (
                    <li key={blocker.questionId}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {recountError && recountBlockers.length === 0 && (
              <div className="builder-operation-error" role="alert">
                {recountError}
              </div>
            )}
          </div>

          <div className="builder-summary-actions">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
              <button
                onClick={onRecountPreview}
                className="btn btn-outline"
                disabled={!hasRecountChanges || isRecountLoading}
              >
                {isRecountLoading ? 'Рахуємо...' : 'Перерахувати'}
              </button>
              <button
                onClick={onApplyRecount}
                className="btn btn-primary"
                disabled={!hasRecountChanges || isRecountLoading || isRecountApplying}
              >
                {isRecountApplying
                  ? 'Застосовуємо...'
                  : isRecountLoading
                    ? 'Готуємо...'
                    : recountMode === 'request'
                      ? 'Створити запит'
                      : recountMode === 'choice'
                        ? 'Продовжити'
                        : 'Застосувати переоблік'}
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function RecountComparisonRow({ current, label, mono = false, next }) {
  return (
    <div className="recount-comparison-row">
      <span>{label}</span>
      <span className={mono ? 'font-mono' : ''}>{current ?? '—'}</span>
      <span className={mono ? 'font-mono' : ''}>{next ?? '—'}</span>
    </div>
  );
}

function isRecountAnswerChanged(previousValue, nextValue) {
  return String(previousValue ?? '') !== String(nextValue ?? '');
}

function getRecountPriceSource({ manualPriceUah, totalPriceUah }) {
  if (Number(manualPriceUah) > 0) return 'Вручну';
  if (Number(totalPriceUah) > 0) return 'Автоматично';
  return 'Не визначено';
}

function formatOptionalValue(value, formatter) {
  if (value === null || value === undefined || String(value).trim() === '') return '—';
  return formatter(value);
}

function formatSignedUah(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount > 0 ? '+' : ''}${formatUah(value)}`;
}

function formatSignedRoundedUah(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount > 0 ? '+' : ''}${formatUah(amount.toFixed(2))}`;
}
