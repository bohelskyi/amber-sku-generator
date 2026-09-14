import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';
import { formatUah } from '../../lib/formatters';

const MODES = [
  { value: 'manual_uah', label: 'Ручна UAH' },
  { value: 'usd_per_gram', label: 'USD/г' },
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
  currentPriceUah,
  error = '',
  isApplying = false,
  isLoading = false,
  isOpen = false,
  manualPriceUah = '',
  marketingRoundingEnabled = true,
  mode = 'manual_uah',
  onCancel,
  onConfirm,
  onManualPriceChange,
  onMarketingRoundingChange,
  onModeChange,
  onUsdPerGramChange,
  preview,
  sku,
  usdPerGram = '',
}) {
  const dialogRef = useRef(null);
  const confirmButtonRef = useRef(null);
  useDialogAccessibility({
    closeDisabled: isApplying,
    containerRef: dialogRef,
    initialFocusRef: confirmButtonRef,
    isOpen,
    onClose: onCancel,
  });
  if (!isOpen) return null;

  const validInput = mode === 'usd_per_gram'
    ? validPositiveDecimal(usdPerGram, 4)
    : validPositiveDecimal(manualPriceUah, 2);
  const resultingPrice = preview?.resultingPriceUah ?? null;
  const difference = preview?.priceDifferenceUah ?? null;

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isApplying) onCancel();
    }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-price-change-title"
        tabIndex={-1}
        className="dialog-surface max-w-lg"
      >
        <div className="dialog-header">
          <p className="eyebrow">Зміна ціни без переобліку</p>
          <h2 id="product-price-change-title" className="mt-1 text-xl font-semibold text-slate-900 sm:text-2xl">
            Змінити ціну чинного товару?
          </h2>
        </div>

        <div className="dialog-body space-y-5 px-5 py-5 sm:px-6">
          <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">SKU</dt>
              <dd className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">{sku}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Поточна ціна</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900">{optionalUah(currentPriceUah)}</dd>
            </div>
          </dl>

          <fieldset className="rounded-lg border border-slate-200 p-4">
            <legend className="px-1 text-sm font-semibold">Режим ціни</legend>
            <div role="radiogroup" aria-label="Режим зміни ціни" className="mt-2 flex gap-1 rounded-md bg-slate-100 p-1">
              {MODES.map((item) => (
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

            {mode === 'manual_uah' ? (
              <label className="mt-4 block text-sm">Нова ціна UAH
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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-800">Результуюча ціна</div>
              <div className="mt-1 text-lg font-semibold text-slate-900">
                {isLoading ? 'Розраховуємо…' : optionalUah(resultingPrice)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Різниця</div>
              <div className="mt-1 text-lg font-semibold text-slate-900">
                {difference === null ? '—' : `${Number(difference) > 0 ? '+' : ''}${formatUah(difference)}`}
              </div>
            </div>
          </div>

          {preview?.unchanged && (
            <div className="danger-panel p-4 text-sm" role="alert">
              Результуюча ціна не відрізняється від поточної.
            </div>
          )}
          {error && <div className="danger-panel p-4 text-sm" role="alert">{error}</div>}
        </div>

        <div className="dialog-footer grid gap-3 sm:grid-cols-2">
          <button type="button" className="btn btn-outline order-2 sm:order-1" onClick={onCancel} disabled={isApplying}>
            Скасувати
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            className="btn btn-primary order-1 sm:order-2"
            onClick={onConfirm}
            disabled={!validInput || !preview || preview.unchanged || isLoading || isApplying}
          >
            {isApplying ? 'Змінюємо…' : 'Змінити ціну'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
