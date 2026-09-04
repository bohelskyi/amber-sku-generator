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

  if (isRecountOpen) {
    return (
      <section className="card p-6 sm:p-8 fade-up stagger-3">
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
    <section className="card p-6 sm:p-8 fade-up stagger-3">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <p className="eyebrow">Результат декодування</p>
          <h2 className="mt-1 break-all font-mono text-2xl font-semibold text-slate-900 sm:text-3xl">
            {decodeData.sku}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="chip">{decodeData.category.code}</span>
          <span className="chip">{decodeData.category.name}</span>
          <span className="chip">
            {decodeData.existsInDb ? 'Є в базі' : 'Не знайдено в базі'}
          </span>
          {decodeData.decodeSource === 'stored_history' && (
            <span className="chip">Історичний формат</span>
          )}
          {isCalibrationUnknown && (
            <span className="chip border-amber-300 bg-amber-50 text-amber-800">
              Калібрування не визначено
            </span>
          )}
        </div>
      </div>

      {decodeData.decodeSource === 'stored_history' && (
        <div className="mt-4 border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-slate-700">
          Артикул створено за попередньою конфігурацією. Параметри відновлено зі
          збереженого товару.
        </div>
      )}

      <div className="grid gap-6 py-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Параметри виробу</h3>
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white/80">
            {decodeData.decodedAnswers.map((item) => {
              const isPriceDriver = decodeData.pricing?.dependentKeys?.includes(item.key);

              return (
                <div
                  key={item.key}
                  className={`grid grid-cols-[minmax(0,1fr)_minmax(120px,0.8fr)] gap-4 border-b px-4 py-3 last:border-b-0 sm:px-5 ${
                    isPriceDriver
                      ? 'border-[rgba(221,151,74,0.45)] bg-[rgba(221,151,74,0.12)]'
                      : 'border-slate-200'
                  }`}
                >
                  <div className="text-sm font-medium text-slate-700">{item.label}</div>
                  <div className="min-w-0 text-right text-sm text-slate-900">
                    <span className="break-words">{item.value_label}</span>
                    {item.value_id !== null && (
                      <span className="block font-mono text-xs text-slate-500">{item.value_id}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Розрахунок</h3>
            {isCalibrationBlockingPrice && (
              <div className="mt-4 border-l-4 border-amber-500 bg-amber-50 px-4 py-3">
                <div className="text-sm font-semibold text-slate-900">Ціну не визначено</div>
                <div className="mt-1 text-sm leading-5 text-slate-600">
                  Калібрування не закодоване в артикулі та відсутнє у збережених
                  параметрах товару.
                </div>
              </div>
            )}
            {decodeData.pricing && (
              <div className="mt-4 rounded-xl border border-[rgba(221,151,74,0.5)] bg-[rgba(221,151,74,0.12)] p-5">
                <div className="text-xs uppercase tracking-[0.2em] text-[#8a5f2b]">
                  Ціна виробу
                </div>
                <div className="mt-1 text-xl font-semibold text-slate-900">
                  {formatUah(decodeData.pricing.totalPriceUah)}
                </div>
                {decodeData.pricing.calculatedPriceUah !== null
                  && decodeData.pricing.calculatedPriceUah !== undefined
                  && decodeData.pricing.automaticPriceUah !== null
                  && decodeData.pricing.automaticPriceUah !== undefined && (
                  <div className="mt-2 text-xs text-slate-600">
                    Розраховано до округлення: {formatWholeUah(decodeData.pricing.calculatedPriceUah)}
                    {' → '}автоматична ціна: {formatUah(decodeData.pricing.automaticPriceUah)}
                  </div>
                )}
                <div className="mt-3">
                  <span className="chip">{getPricingSourceLabel(decodeData.pricing.source)}</span>
                </div>
                {(decodeData.pricing.isWeightBased || decodeData.pricing.usesWeight) && (
                  <div className="mt-4 grid gap-3 border-t border-[rgba(221,151,74,0.35)] pt-4 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                    {decodeData.pricing.isWeightBased && (
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ціна за грам</div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatUahPerGram(decodeData.pricing.pricePerGramUah)} ({formatUsd(decodeData.pricing.pricePerGram)})
                        </div>
                      </div>
                    )}
                    {decodeData.pricing.usesWeight
                      && decodeData.pricing.weight !== null
                      && decodeData.pricing.weight !== undefined && (
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Вага</div>
                        <div className="mt-1 text-sm font-semibold text-slate-900">
                          {formatDecimal(decodeData.pricing.weight)} г
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {decodeData.pricing.matrixName && (
                  <div className="mt-3 text-sm text-slate-700">
                    Матриця:{' '}
                    <span className="font-bold text-slate-900">{decodeData.pricing.matrixName}</span>
                  </div>
                )}
                {decodeData.pricing.logMessage && (
                  <div className="mt-3 text-xs leading-5 text-slate-600">{decodeData.pricing.logMessage}</div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Базовий SKU</div>
                <div className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">
                  {decodeData.baseSku}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
                  {decodeData.variation
                    ? 'Варіація'
                    : decodeData.suffix.type === 'weight'
                      ? 'Вага'
                      : decodeData.suffix.type === 'sequence'
                        ? 'Порядковий номер'
                        : 'Суфікс'}
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {decodeData.variation
                    ? decodeData.variation.suffix
                    : formatDecodedSuffix(decodeData.suffix)}
                </div>
              </div>
            </div>
            {decodeData.variation && (
              <div className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-600">
                Основний артикул:{' '}
                <span className="break-all font-mono font-semibold text-slate-900">
                  {decodeData.baseSku}{decodeData.suffix.raw || ''}
                </span>
              </div>
            )}
          </div>

          {pricingConditions.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Цінові умови
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {pricingConditions.map((condition) => (
                  <span key={condition.key} className="chip">
                    {getQuestionLabel(config, decodeData.category.code, condition.key)}:{' '}
                    {getAnswerValueLabel(
                      config,
                      decodeData.category.code,
                      condition.key,
                      condition.value
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {recountSuccess && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              {recountSuccess}
            </div>
          )}

          {decodeData.existsInDb && (
            <button onClick={onStartRecount} className="btn btn-outline w-full">
              {recountMode === 'request' ? 'Підготувати запит' : 'Переоблікувати'}
            </button>
          )}
        </aside>
      </div>
    </section>
  );
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
  const visibleQuestions = categoryQuestions.filter((question) =>
    isQuestionVisible(question, recountAnswers, recountAnswers.is_calibrated ?? null)
  );
  const priceDependentKeys = decodeData.pricing?.dependentKeys || [];
  const blockerByQuestionId = new Map(
    recountBlockers.map((blocker) => [blocker.questionId, blocker])
  );

  useEffect(() => {
    if (recountValidationAttempt > 0) focusFirstRecountBlocker(panelRef.current);
  }, [recountValidationAttempt]);

  return (
    <div ref={panelRef}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">
            {recountMode === 'request' ? 'Запит на виправлення' : 'Переоблік товару'}
          </p>
          <h3 className="mt-1 text-xl font-semibold text-slate-900">Виправлення параметрів</h3>
          <div className="mt-1 break-all font-mono text-sm text-slate-500">{decodeData.sku}</div>
        </div>
        <button onClick={onCancelRecount} className="btn btn-outline">
          Скасувати
        </button>
      </div>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <div className="grid gap-3 md:grid-cols-2">
          {visibleQuestions.map((question) => {
            const textQuestion = isTextQuestion(question);
            const isPriceDriver = priceDependentKeys.includes(question.id);
            const visibleOptions = getVisibleOptionsForQuestion(
              question,
              recountAnswers,
              recountAnswers.is_calibrated ?? null
            );
            const blocker = blockerByQuestionId.get(question.id);
            const blockerMessageId = `recount-blocker-${question.id}`;

            return (
              <div
                key={question.id}
                data-recount-blocker={blocker ? 'true' : undefined}
                tabIndex={blocker ? -1 : undefined}
                className={`rounded-xl border p-4 ${
                  blocker
                    ? 'border-rose-400 bg-rose-50 ring-1 ring-rose-200'
                    : isPriceDriver
                      ? 'border-[rgba(221,151,74,0.5)] bg-[rgba(221,151,74,0.12)]'
                      : 'border-slate-200 bg-slate-50/70'
                }`}
              >
                <div className={`text-sm font-semibold ${blocker ? 'text-rose-800' : 'text-slate-700'}`}>
                  {question.label}
                </div>
                {textQuestion ? (
                  <input
                    type="text"
                    className={`input mt-3 ${blocker ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200' : ''}`}
                    value={recountAnswers[question.id] || ''}
                    onChange={(event) => onRecountTextAnswer(question.id, event.target.value)}
                    disabled={isRecountLoading || isRecountApplying}
                    aria-invalid={blocker ? 'true' : undefined}
                    aria-describedby={blocker ? blockerMessageId : undefined}
                  />
                ) : (
                  <div
                    className="mt-3 flex flex-wrap gap-2"
                    role="group"
                    aria-invalid={blocker ? 'true' : undefined}
                    aria-describedby={blocker ? blockerMessageId : undefined}
                  >
                    {question.required !== 1
                      && !visibleOptions.some((option) => Number(option.id) === 0) && (
                      <button
                        onClick={() => onRecountAnswer(question.id, null)}
                        disabled={isRecountLoading || isRecountApplying}
                        className={`option-pill ${
                          Number(recountAnswers[question.id] || 0) === 0
                            ? 'option-pill-active'
                            : 'option-pill-idle'
                        }`}
                      >
                        Не обрано
                      </button>
                    )}
                    {visibleOptions.map((option) => (
                      <button
                        key={option.id}
                        onClick={() => onRecountAnswer(question.id, option.id)}
                        disabled={isRecountLoading || isRecountApplying}
                        className={`option-pill ${
                          Number(recountAnswers[question.id]) === Number(option.id)
                            ? 'option-pill-active'
                            : 'option-pill-idle'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                {blocker && (
                  <p id={blockerMessageId} className="mt-2 text-xs font-medium text-rose-700" role="alert">
                    {blocker.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20">
          <PreviousPricingSnapshot config={config} decodeData={decodeData} />

          <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              {recountMode === 'request' ? 'Коментар до запиту' : 'Причина переобліку'}
            </label>
            <textarea
              className="input min-h-24 resize-y"
              value={recountReason}
              onChange={(event) => onRecountReasonChange(event.target.value)}
              placeholder="Наприклад: виправлено сорт після перевірки"
            />
          </div>

          {recountError && recountBlockers.length === 0 && (
            <div className="danger-panel p-4 text-sm">
              {recountError}
            </div>
          )}

          {!hasRecountChanges && !recountError && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Змініть хоча б один параметр виробу.
            </div>
          )}

          {recountPreview && (
            <div className="space-y-4 rounded-xl border border-[rgba(221,151,74,0.5)] bg-[rgba(221,151,74,0.1)] p-4">
              <div className="text-sm font-semibold text-slate-900">Новий розрахунок</div>
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-[#8a5f2b]">Новий SKU</div>
                <div className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">
                  {recountPreview.corrected.fullSku}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                {recountPreview.corrected.priceMode === 'per_gram_usd' && (
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ціна за грам</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      {formatUahPerGram(recountPreview.corrected.pricePerGramUah)} ({formatUsd(recountPreview.corrected.pricePerGram)})
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ціна виробу</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {formatUah(recountPreview.corrected.totalPriceUah)}
                  </div>
                  {recountPreview.corrected.calculatedPriceUah !== null
                    && recountPreview.corrected.calculatedPriceUah !== undefined
                    && recountPreview.corrected.autoPriceUah !== null
                    && recountPreview.corrected.autoPriceUah !== undefined && (
                    <div className="mt-1 text-xs text-slate-500">
                      До округлення: {formatWholeUah(recountPreview.corrected.calculatedPriceUah)}
                      {' → '}автоматично: {formatUah(recountPreview.corrected.autoPriceUah)}
                    </div>
                  )}
                </div>
              </div>
              <div className="border-t border-[rgba(221,151,74,0.35)] pt-3 text-sm text-slate-600">
                Різниця:{' '}
                <span className="font-semibold text-slate-900">
                  {formatUah(recountPreview.priceDeltaUah)}
                </span>
                {recountPreview.corrected.variation && (
                  <span className="mt-1 block text-xs">Створиться варіація, бо базовий SKU вже існує.</span>
                )}
              </div>
              {recountPreview.changes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {recountPreview.changes.map((change) => (
                    <span key={change.key} className="chip">
                      {getQuestionLabel(config, categoryCode, change.key)}:{' '}
                      {getAnswerValueLabel(config, categoryCode, change.key, change.from)}{' -> '}
                      {getAnswerValueLabel(config, categoryCode, change.key, change.to)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {recountBlockers.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" role="alert">
              {formatRecountBlockerSummary(recountBlockers.length)}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
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
        </aside>
      </div>
    </div>
  );
}

function PreviousPricingSnapshot({ config, decodeData }) {
  const pricing = decodeData.pricing;
  if (!pricing) return null;

  const priceAnswers = decodeData.decodedAnswers.filter((answer) =>
    pricing.dependentKeys?.includes(answer.key)
  );
  const externalConditions = (pricing.conditions || []).filter(
    (condition) => !condition.isInSku
  );

  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50/90 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">Попередній розрахунок</div>
          <div className="mt-1 break-all font-mono text-xs text-slate-500">{decodeData.sku}</div>
        </div>
        <span className="chip">Зафіксовано</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {pricing.isWeightBased && (
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ціна за грам</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">
              {formatUahPerGram(pricing.pricePerGramUah)} ({formatUsd(pricing.pricePerGram)})
            </div>
          </div>
        )}
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ціна виробу</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">
            {formatUah(pricing.totalPriceUah)}
          </div>
          {pricing.calculatedPriceUah !== null
            && pricing.calculatedPriceUah !== undefined
            && pricing.automaticPriceUah !== null
            && pricing.automaticPriceUah !== undefined && (
            <div className="mt-1 text-xs text-slate-500">
              До округлення: {formatWholeUah(pricing.calculatedPriceUah)}
              {' → '}автоматично: {formatUah(pricing.automaticPriceUah)}
            </div>
          )}
        </div>
        {pricing.usesWeight && pricing.weight !== null && pricing.weight !== undefined && (
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Вага</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{formatDecimal(pricing.weight)} г</div>
          </div>
        )}
      </div>

      {pricing.matrixName && (
        <div className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-700">
          Матриця: <span className="font-bold text-slate-900">{pricing.matrixName}</span>
        </div>
      )}

      {(priceAnswers.length > 0 || externalConditions.length > 0) && (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Початкові цінові параметри
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {priceAnswers.map((answer) => (
              <span key={answer.key} className="chip">
                {answer.label}: {answer.value_label}
              </span>
            ))}
            {externalConditions.map((condition) => (
              <span key={condition.key} className="chip">
                {getQuestionLabel(config, decodeData.category.code, condition.key)}:{' '}
                {getAnswerValueLabel(
                  config,
                  decodeData.category.code,
                  condition.key,
                  condition.value
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {pricing.logMessage && (
        <div className="mt-3 text-xs leading-5 text-slate-500">{pricing.logMessage}</div>
      )}
    </div>
  );
}
