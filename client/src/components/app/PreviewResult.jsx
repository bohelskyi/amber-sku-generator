import { formatUah, formatUsd } from '../../lib/formatters';

export function PreviewResult({
  previewData,
  finalSku,
  effectivePricePerGram,
  effectivePricePerGramUah,
  effectiveTotalPrice,
  effectiveTotalPriceUah,
  hasManualPrice,
  isVariationActive,
  variationData,
  variationError,
  isVariationLoading,
  isManualPriceEditing,
  manualPriceUah,
  onCopyText,
  onBackToParameters,
  onAddVariation,
  onManualPriceChange,
  onResetManualPrice,
  onSave,
  onStartManualPriceEdit,
  onStopManualPriceEdit,
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

  return (
    <section className="card p-6 sm:p-8 border-t-4 border-[rgba(221,151,74,0.7)] fade-up">
      <div className="section-title mb-6">
        <div>
          <p className="eyebrow">Крок 2</p>
          <h2 className="section-title-text">Перевірка артикула</h2>
          <p className="section-subtitle">Порівняння з базою та розрахунок ціни.</p>
        </div>
      </div>

      {previewData.mode === 'sequence' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="stat-card opacity-80">
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500 font-semibold">Останній в базі</p>
            <div className="text-2xl font-mono text-slate-600 my-3">{previewData.prevFullSku}</div>
          </div>
          <div className="stat-card stat-card-hero">
            <p className="text-xs uppercase tracking-[0.28em] text-slate-800 font-semibold">Буде створено</p>
            <div className="text-3xl font-mono font-bold text-slate-900 my-3">{finalSku}</div>
            {isVariationActive && (
              <p className="text-sm text-slate-600">Варіація #{String(variationData.variationNumber).padStart(3, '0')} для {previewData.fullProposedSku}</p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => onCopyText(finalSku, 'SKU')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати SKU</button>
              {priceActions}
            </div>
            <p className="mt-4 text-2xl font-semibold text-slate-800">{formatUah(effectiveTotalPriceUah)}</p>
            {hasManualPrice && <p className="text-xs font-semibold text-[#8a5f2b]">Ціну змінено вручну</p>}
            <p className="text-sm text-slate-600">{formatUsd(effectiveTotalPrice)}</p>
            {previewData.uahRate && <p className="text-xs text-slate-500">1 USD = {previewData.uahRate} ₴</p>}
          </div>
        </div>
      ) : (
        <div className="mb-8">
          <div className={`stat-card ${isVariationActive ? 'border-[rgba(20,32,59,0.35)] bg-[rgba(20,32,59,0.06)]' : previewData.existsInDb ? 'border-[rgba(221,151,74,0.7)] bg-[rgba(221,151,74,0.16)]' : 'border-[rgba(20,32,59,0.35)] bg-[rgba(20,32,59,0.06)]'}`}>
            <p className={`text-xs uppercase tracking-[0.28em] font-semibold ${isVariationActive ? 'text-slate-800' : previewData.existsInDb ? 'text-[#8a5f2b]' : 'text-slate-800'}`}>
              {isVariationActive ? 'НОВА ВАРІАЦІЯ ДО АРТИКУЛУ' : previewData.existsInDb ? 'УВАГА: ТАКИЙ АРТИКУЛ ВЖЕ ІСНУЄ' : 'НОВИЙ УНІКАЛЬНИЙ АРТИКУЛ'}
            </p>
            <div className="text-4xl font-mono font-bold text-slate-800 my-4">{finalSku}</div>
            {isVariationActive && (
              <p className="text-sm text-slate-600">Базовий артикул: {previewData.fullProposedSku}</p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => onCopyText(finalSku, 'SKU')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати SKU</button>
              {priceActions}
            </div>
            <p className="mt-4 text-2xl font-semibold text-slate-800">{formatUah(effectiveTotalPriceUah)}</p>
            {hasManualPrice && <p className="text-xs font-semibold text-[#8a5f2b]">Ціну змінено вручну</p>}
            <p className="text-sm text-slate-600">{formatUsd(effectiveTotalPrice)}</p>
            {previewData.uahRate && <p className="text-xs text-slate-500">1 USD = {previewData.uahRate} ₴</p>}
          </div>
        </div>
      )}

      {parseFloat(effectivePricePerGram) > 0 && (
        <div className="text-center mb-8 text-slate-600">
          <p>Ціна за грам: <strong>{formatUah(effectivePricePerGramUah)}</strong> <span className="text-sm">({formatUsd(effectivePricePerGram)})</span></p>
        </div>
      )}

      {variationError && (
        <div className="danger-panel p-4 mb-6 text-sm">
          {variationError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button onClick={onBackToParameters} className="btn btn-outline py-3">Назад до параметрів</button>
        <button onClick={onAddVariation} className="btn btn-primary py-3" disabled={isVariationLoading}>
          {isVariationLoading ? 'Підбираємо...' : 'Додати варіацію'}
        </button>
        <button onClick={onSave} className="btn btn-amber py-3">Зберегти</button>
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
        onClick={() => effectiveTotalPriceUah && onCopyText(`${effectiveTotalPriceUah} ₴`, 'Ціну')}
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
            min="0"
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
