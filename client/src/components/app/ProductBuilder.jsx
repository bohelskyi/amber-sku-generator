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
    <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
      <section className="card p-6 sm:p-8 fade-up">
        <div className="section-title mb-6">
          <div>
            <p className="eyebrow">Крок 1</p>
            <h2 className="section-title-text">{config.categories[selectedCat].name}</h2>
            <p className="section-subtitle">Заповніть параметри виробу для генерації артикула.</p>
          </div>
          <button onClick={onCancel} className="btn btn-ghost">Скасувати</button>
        </div>

        <div className="space-y-6">
          {config.questions[selectedCat]?.map((question) => {
            if (!isQuestionVisible(question, answers)) return null;

            const visibleOptions = getVisibleOptionsForQuestion(question, answers);
            const textQuestion = isTextQuestion(question);

            return (
              <div key={question.id} className="rounded-2xl border border-slate-200 bg-white/80 p-5">
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
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-5">
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

          <button onClick={onPreview} className="btn btn-primary w-full py-4 text-base sm:text-lg">
            Перевірити артикул
          </button>
        </div>
      </section>

      <aside className="space-y-6 fade-up stagger-1">
        <div className="card p-6 sm:p-8 lg:sticky lg:top-6">
          <p className="eyebrow">Підсумок</p>
          <h3 className="section-title-text">{config.categories[selectedCat].name}</h3>
          <div className="mt-4 space-y-3 text-sm text-slate-600">
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
                {isWeightRequired && (
                  <> | За грам: {formatUahPerGram(livePriceData.pricePerGramUah)} | За грам (USD): {formatUsd(livePriceData.pricePerGram)}</>
                )}
              </div>
            )}
            {livePriceError && (
              <div className="text-xs text-rose-600">{livePriceError}</div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
