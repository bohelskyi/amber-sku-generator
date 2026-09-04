import {
  formatDecimal,
  formatUah,
  formatUahPerGram,
  formatWholeUah,
  formatUsd,
} from '../../lib/formatters';

export function PreviewResult({
  previewData,
  finalSku,
  effectivePricePerGram,
  effectivePricePerGramUah,
  effectiveTotalPrice,
  effectiveTotalPriceUah,
  hasManualPrice,
  isWeightRequired,
  isVariationActive,
  variationData,
  variationError,
  isVariationLoading,
  isManualPriceEditing,
  isSaving,
  requiresManualPrice,
  manualPriceUah,
  onCopyText,
  onBackToParameters,
  onAddVariation,
  onManualPriceChange,
  onResetManualPrice,
  onSave,
  onStartManualPriceEdit,
  onStopManualPriceEdit,
  saveError,
}) {
  const priceActions = (
    <PriceActions
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
  );
  const resultLabel = previewData.mode === 'sequence'
    ? 'Буде створено'
    : isVariationActive
      ? 'Нова варіація'
      : previewData.existsInDb
        ? 'SKU вже існує'
        : 'Новий унікальний SKU';
  const resultStateClass = previewData.mode === 'sequence'
    ? 'stat-card-hero'
    : isVariationActive
      ? 'border-slate-300 bg-slate-50'
      : previewData.existsInDb
        ? 'border-amber-300 bg-amber-50'
        : 'border-slate-300 bg-slate-50';

  return (
    <section className="card p-4 sm:p-5 border-t-4 border-[rgba(221,151,74,0.7)] fade-up">
      <div className="section-title mb-4">
        <div>
          <p className="eyebrow">Крок 2</p>
          <h2 className="section-title-text">Перевірка артикула</h2>
          <p className="section-subtitle">Порівняння з базою та розрахунок ціни.</p>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          {previewData.mode === 'sequence' && (
          <div className="stat-card opacity-80">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Останній у базі</p>
              <div className="my-2 break-all font-mono text-xl text-slate-700">{previewData.prevFullSku}</div>
          </div>
          )}

          {isWeightRequired
            && previewData.priceMode !== 'fixed_uah'
            && parseFloat(effectivePricePerGram) > 0 && (
            <div className="field-group text-sm text-slate-600">
              Ціна за грам: <strong className="text-slate-900">{formatUahPerGram(effectivePricePerGramUah)}</strong>{' '}
              <span>({formatUsd(effectivePricePerGram)})</span>
            </div>
          )}

          {variationError && <div className="danger-panel p-4 text-sm">{variationError}</div>}
          {saveError && <div className="danger-panel p-4 text-sm">{saveError}</div>}

          {requiresManualPrice && !hasManualPrice && (
            <div className="danger-panel p-4 text-sm">
              <span className="price-source-badge is-missing mt-0">Ціна відсутня</span>
              <p className="mt-2">Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.</p>
            </div>
          )}

          <div className="info-panel p-4 text-sm">
            Перевірте SKU і ціну в підсумку. Збереження повторно підтвердить актуальність розрахунку.
          </div>
        </div>

        <aside className="lg:sticky lg:top-20">
          <div className={`stat-card text-left ${resultStateClass}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">{resultLabel}</p>
            <div className="my-3 break-all font-mono text-2xl font-bold text-slate-900">{finalSku}</div>
            {isVariationActive && (
              <p className="text-xs text-slate-600">
                {previewData.mode === 'sequence'
                  ? `Варіація #${String(variationData.variationNumber).padStart(3, '0')} для ${previewData.fullProposedSku}`
                  : `Базовий SKU: ${previewData.fullProposedSku}`}
              </p>
            )}

            <div className="mt-4 border-t border-slate-200 pt-4">
              <p className="text-2xl font-semibold text-slate-900">{formatUah(effectiveTotalPriceUah)}</p>
              <span className={`price-source-badge ${hasManualPrice ? 'is-manual' : 'is-automatic'}`}>
                {hasManualPrice ? 'Ручна ціна' : 'Автоматична ціна'}
              </span>
              {previewData.calculatedPriceUah !== null
                && previewData.calculatedPriceUah !== undefined
                && previewData.totalPriceUah !== null
                && previewData.totalPriceUah !== undefined && (
                <p className="mt-2 text-xs text-slate-500">
                  До округлення: {formatWholeUah(previewData.calculatedPriceUah)}
                  {' → '}автоматично: {formatUah(previewData.totalPriceUah)}
                </p>
              )}
              <p className="mt-1 text-sm text-slate-600">{formatUsd(effectiveTotalPrice)}</p>
              {previewData.uahRate && <p className="text-xs text-slate-500">1 USD = {previewData.uahRate} ₴</p>}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => onCopyText(finalSku, 'SKU')} className="btn btn-outline h-9 min-h-9 px-3 text-xs">Копіювати SKU</button>
              {priceActions}
            </div>

            <div className="mt-4 grid gap-2 border-t border-slate-200 pt-4">
              <button
                onClick={onSave}
                className="btn btn-amber"
                disabled={isSaving || (requiresManualPrice && !hasManualPrice)}
              >
                {isSaving ? 'Зберігаємо...' : 'Зберегти товар'}
              </button>
              <button onClick={onAddVariation} className="btn btn-primary" disabled={isVariationLoading}>
                {isVariationLoading ? 'Підбираємо...' : 'Додати варіацію'}
              </button>
              <button onClick={onBackToParameters} className="btn btn-ghost">Назад до параметрів</button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function PriceActions({
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
    <>
      <button
        onClick={() => effectiveTotalPriceUah && onCopyText(`${formatDecimal(effectiveTotalPriceUah)} ₴`, 'Ціну')}
        className="btn btn-outline text-xs px-3 py-1.5"
      >
        Копіювати ціну
      </button>
      <button
        onClick={isManualPriceEditing ? onStopManualPriceEdit : onStartManualPriceEdit}
        className="btn btn-outline text-xs px-3 py-1.5"
      >
        {isManualPriceEditing ? 'Готово' : 'Змінити ціну'}
      </button>
      {hasManualPrice && (
        <button onClick={onResetManualPrice} className="btn btn-outline text-xs px-3 py-1.5">
          Скинути авто
        </button>
      )}
      {isManualPriceEditing && (
        <div className="mt-3 w-full max-w-xs mx-auto">
          <label className="block text-xs uppercase tracking-[0.2em] text-slate-500 mb-2">
            Ручна ціна, грн
          </label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={manualPriceUah}
            onChange={(event) => onManualPriceChange(event.target.value)}
            className="input text-center"
            placeholder="Введіть ціну"
          />
        </div>
      )}
    </>
  );
}
