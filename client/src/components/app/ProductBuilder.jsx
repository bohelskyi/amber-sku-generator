import { formatUah, formatUahPerGram, formatUsd } from '../../lib/formatters';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';

export function ProductBuilder({
  config,
  selectedCat,
  answers,
  weight,
  setWeight,
  isWeightRequired,
  answeredRequiredCount,
  requiredCount,
  progressPercent,
  livePriceData,
  livePriceError,
  isLivePriceLoading,
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
  onAnswer,
  onTextAnswer,
  onPreview,
  onCancel,
}) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="card p-5 sm:p-6 fade-up">
        <div className="section-title mb-4">
          <div>
            <p className="eyebrow">Крок 1</p>
            <h2 className="section-title-text">{config.categories[selectedCat].name}</h2>
            <p className="section-subtitle">Заповніть параметри виробу для генерації артикула.</p>
          </div>
          <button onClick={onCancel} className="btn btn-ghost">Скасувати</button>
        </div>

        <div className="space-y-4">
          {config.questions[selectedCat]?.map((question) => {
            if (!isQuestionVisible(question, answers)) return null;

            const visibleOptions = getVisibleOptionsForQuestion(question, answers);
            const textQuestion = isTextQuestion(question);

            return (
              <div key={question.id} className="field-group">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="text-sm font-semibold text-slate-700">{question.label}</label>
                  {question.required === 1 && (textQuestion || visibleOptions.length > 0) && (
                    <span className="chip">Обов'язкове</span>
                  )}
                </div>

                {textQuestion ? (
                  <div className="mt-3">
                    <input
                      type="text"
                      className="input"
                      value={answers[question.id] || ''}
                      onChange={(event) => onTextAnswer(question.id, event.target.value)}
                      placeholder="Введіть значення..."
                    />
                  </div>
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {visibleOptions.map((option) => (
                        <button
                          key={option.id}
                          onClick={() => onAnswer(question.id, option.id)}
                          className={`option-pill ${answers[question.id] === option.id ? 'option-pill-active' : 'option-pill-idle'}`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    {visibleOptions.length === 0 && (
                      <p className="mt-3 text-xs text-slate-500">Немає доступних варіантів для поточних умов.</p>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {isWeightRequired && (
            <div className="field-group">
              <label className="block text-sm font-semibold text-slate-700">Вага виробу (г)</label>
              <input
                type="number"
                min="0"
                onKeyDown={(event) => {
                  if (event.key === '-') event.preventDefault();
                  handleNumberKeyDown(event);
                }}
                onWheel={handleNumberWheel}
                value={weight}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value < 0) return;
                  setWeight(value);
                }}
                className="input mt-3"
                placeholder="0.00"
              />
              <p className="mt-2 text-xs text-slate-500">Введіть фактичну вагу виробу в грамах.</p>
            </div>
          )}

        </div>
      </section>

      <aside className="fade-up stagger-1 lg:sticky lg:top-20">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <p className="eyebrow">Підсумок</p>
          <h3 className="text-base font-semibold text-slate-900">{config.categories[selectedCat].name}</h3>
          </div>
          <div className="space-y-3 p-4 text-sm text-slate-600">
            <div className="flex items-center justify-between">
              <span>Обов'язкові</span>
              <span className="font-semibold text-slate-800">{answeredRequiredCount}/{requiredCount}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="flex items-center justify-between">
              <span>Готовність</span>
              <span className="font-semibold text-slate-800">{progressPercent}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Вага</span>
              <span className="font-semibold text-slate-800">
                {isWeightRequired ? (weight ? `${weight} г` : 'Потрібна') : 'Не потрібна'}
              </span>
            </div>
            <div className="h-px bg-slate-200" />
            <div className="flex items-center justify-between">
              <span>Попередня ціна</span>
              <span className="font-semibold text-slate-800">
                {isLivePriceLoading ? 'Розрахунок...' : livePriceData?.totalPriceUah ? formatUah(livePriceData.totalPriceUah) : '---'}
              </span>
            </div>
            {livePriceData && (
              <div className="text-xs text-slate-500">
                USD: {formatUsd(livePriceData.totalPrice)}
                {livePriceData.priceMode === 'per_gram_usd' && (
                  <> | За грам: {formatUahPerGram(livePriceData.pricePerGramUah)} | За грам (USD): {formatUsd(livePriceData.pricePerGram)}</>
                )}
              </div>
            )}
            {livePriceError && (
              <div className="price-status-line is-error">
                <span className="status-badge is-error shrink-0">Помилка</span>
                <span>{livePriceError}</span>
              </div>
            )}
          </div>
          <div className="border-t border-slate-200 bg-white p-4">
            <button onClick={onPreview} className="btn btn-amber w-full">
              Перевірити SKU та ціну
            </button>
            <p className="mt-2 text-center text-[11px] text-slate-500">Результат перевіряється сервером перед збереженням.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
