import { useRef } from 'react';
import { formatUah } from '../../lib/formatters';
import { Dialog } from '../ui';
import { ExchangeRateNotice } from '../ExchangeRateNotice';

const MODES = [
  { value: 'system_auto', label: 'За правилами' },
  { value: 'manual_uah', label: 'Вказати суму' },
  { value: 'usd_per_gram', label: 'За грам' },
];

function validPositiveDecimal(value, scale) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  const amount = Number(normalized);
  return /^\d+(?:\.\d+)?$/.test(normalized)
    && Number.isFinite(amount) && amount > 0
    && Number(amount.toFixed(scale)) === amount;
}

function optionalUah(value) {
  return value === null || value === undefined ? '—' : formatUah(value);
}

export function ProductPriceChangeDialog({
  canApplyDirect = true,
  canCreateRequest = false,
  canRequestOverride = false,
  canUseOverrides = true,
  currentPriceUah,
  error = '',
  isApplying = false,
  isLoading = false,
  isOpen = false,
  manualPriceUah = '',
  manualMarketingRoundingEnabled = false,
  marketingRoundingEnabled = true,
  mode = 'manual_uah',
  onCancel,
  onConfirm,
  onRequest,
  onManualPriceChange,
  onManualMarketingRoundingChange,
  onMarketingRoundingChange,
  onModeChange,
  onUsdPerGramChange,
  preview,
  sku,
  usdPerGram = '',
}) {
  const confirmButtonRef = useRef(null);
  if (!isOpen) return null;

  const validInput = mode === 'system_auto'
    || (mode === 'usd_per_gram'
      ? validPositiveDecimal(usdPerGram, 4)
      : validPositiveDecimal(manualPriceUah, 2));
  const resultingPrice = preview?.resultingPriceUah ?? null;
  const difference = preview?.priceDifferenceUah ?? null;
  const visibleModes = canUseOverrides
    ? MODES : MODES.filter((item) => item.value === 'system_auto');
  const requestAllowedForMode = mode === 'system_auto' || canRequestOverride;
  const actionDisabled = !validInput || !preview || preview.unchanged || isLoading || isApplying;

  return <Dialog open title="Змінити ціну"
    description={sku}
    busy={isApplying} onClose={onCancel} initialFocusRef={confirmButtonRef} size="md"
    footer={<div className={`grid w-full gap-3 ${canApplyDirect && canCreateRequest ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <button type="button" className="btn btn-outline" onClick={onCancel} disabled={isApplying}>Скасувати</button>
      {canCreateRequest && <button ref={!canApplyDirect ? confirmButtonRef : undefined} type="button"
        className={`btn ${canApplyDirect ? 'btn-outline' : 'btn-primary'}`} onClick={onRequest}
        disabled={actionDisabled || !requestAllowedForMode}
        title={!requestAllowedForMode ? 'Для цього режиму потрібен дозвіл керування ціною запиту.' : undefined}>
        {isApplying ? 'Виконуємо…' : 'Створити запит на зміну ціни'}
      </button>}
      {canApplyDirect && <button ref={confirmButtonRef} type="button" className="btn btn-primary" onClick={onConfirm}
        disabled={actionDisabled}>{isApplying ? 'Змінюємо…' : 'Змінити ціну'}</button>}
    </div>}>
        <div className="space-y-5">
          <dl className="product-price-comparison">
            <div>
              <dt>Зараз</dt>
              <dd>{optionalUah(currentPriceUah)}</dd>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <dt>Буде</dt>
              <dd>{isLoading ? 'Розраховуємо…' : optionalUah(resultingPrice)}</dd>
            </div>
          </dl>

          <fieldset>
            <legend className="text-sm font-semibold">Як визначити ціну</legend>
            <div role="radiogroup" aria-label="Режим зміни ціни" className="mt-2 flex gap-1 rounded-md bg-slate-100 p-1">
              {visibleModes.map((item) => (
                <label key={item.value} className="relative flex-1 cursor-pointer">
                  <input
                    type="radio"
                    name="product-price-change-mode"
                    value={item.value}
                    checked={mode === item.value}
                    onChange={() => onModeChange(item.value)}
                    className="peer sr-only"
                  />
                  <span className="flex min-h-9 items-center justify-center rounded-md border border-transparent px-2 py-2 text-center text-sm font-semibold text-slate-600 peer-checked:border-amber-300 peer-checked:bg-amber-50 peer-checked:text-amber-950 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-amber-500">
                    {item.label}
                  </span>
                </label>
              ))}
            </div>

            {mode === 'system_auto' ? (
              <p className="mt-4 text-sm text-slate-600">
                Ціну буде перераховано за поточною автоматичною конфігурацією.
              </p>
            ) : mode === 'manual_uah' ? (
              <div className="mt-4 space-y-3">
                <label className="block text-sm">Нова ціна UAH
                  <input
                    className="input mt-2"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={manualPriceUah}
                    onChange={(event) => onManualPriceChange(event.target.value)}
                    autoFocus
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={manualMarketingRoundingEnabled}
                    onChange={(event) => onManualMarketingRoundingChange(event.target.checked)}
                  />
                  Маркетингове округлення
                </label>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block text-sm">USD за грам
                  <input
                    className="input mt-2"
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={usdPerGram}
                    onChange={(event) => onUsdPerGramChange(event.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={marketingRoundingEnabled}
                    onChange={(event) => onMarketingRoundingChange(event.target.checked)}
                  />
                  Маркетингове округлення
                </label>
              </div>
            )}
          </fieldset>

          {!isLoading && difference !== null && <p className="text-sm text-slate-600">Різниця: {Number(difference) > 0 ? '+' : ''}{formatUah(difference)}</p>}

          {!isLoading && <ExchangeRateNotice rate={preview?.resultingPricing?.uahRate}
            rateDate={preview?.resultingPricing?.rateMetadata?.date}
            fetchedAt={preview?.resultingPricing?.rateMetadata?.fetchedAt}
            stale={preview?.resultingPricing?.rateMetadata?.stale} />}

          {preview?.unchanged && (
            <div className="text-sm text-slate-600" role="status">
              Ціна залишається без змін.
            </div>
          )}
          {error && <div className="danger-panel p-4 text-sm" role="alert">{error}</div>}
        </div>
  </Dialog>;
}
