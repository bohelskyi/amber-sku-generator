import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from 'lucide-react';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { getAnswerValueLabel, getQuestionLabel } from '../../lib/answer-labels';
import { copyPlainText } from '../../lib/clipboard';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

const PRICING_MODES = [
  { value: 'system_auto', label: 'Автоматична' },
  { value: 'manual_uah', label: 'Ручна UAH' },
  { value: 'usd_per_gram', label: 'USD/г' },
];

function hasValidDecisionPrice(value, scale) {
  const text = String(value ?? '').trim().replace(',', '.');
  const amount = Number(text);
  return /^\d+(?:\.\d+)?$/.test(text) && Number.isFinite(amount)
    && amount > 0 && Number(amount.toFixed(scale)) === amount;
}

export function RecountConfirmDialog({
  config,
  canPriceOverride = false,
  error = '',
  isApplying,
  isOpen,
  onCancel,
  onConfirm,
  preview,
  reason,
  manualPriceUah,
  pricingMode = 'system_auto',
  usdPerGram = '',
  marketingRoundingEnabled = true,
  previewCurrent = true,
  onManualPriceChange,
  onPricingModeChange,
  onUsdPerGramChange,
  onMarketingRoundingChange,
  mode = 'apply',
  submittingMode = null,
}) {
  const dialogRef = useRef(null);
  const confirmButtonRef = useRef(null);
  const [previewBeforeDecisionEdit, setPreviewBeforeDecisionEdit] = useState(null);
  const dialogOpen = Boolean(isOpen && preview);

  useDialogAccessibility({
    closeDisabled: isApplying,
    containerRef: dialogRef,
    initialFocusRef: confirmButtonRef,
    isOpen: dialogOpen,
    onClose: onCancel,
  });

  if (!dialogOpen) return null;

  const oldPrice = preview.source.totalPriceUah;
  const newPrice = preview.corrected.totalPriceUah;
  const sourceArticle = preview.source.publicSku || preview.source.sku;
  const correctedArticle = preview.corrected.publicSku || preview.corrected.fullSku || sourceArticle;
  const priceDelta = Number(preview.priceDeltaUah || 0);
  const isRequestMode = mode === 'request';
  const showDecision = !isRequestMode || canPriceOverride;
  const isCustomDecision = showDecision && pricingMode !== 'system_auto';
  const hasValidCustomInput = pricingMode === 'usd_per_gram'
    ? hasValidDecisionPrice(usdPerGram, 4)
    : pricingMode === 'manual_uah'
      ? hasValidDecisionPrice(manualPriceUah, 2)
      : true;
  const showTargetPrice = !isCustomDecision || (
    previewCurrent && hasValidCustomInput && previewBeforeDecisionEdit !== preview
  );
  const plainNewPrice = showTargetPrice && Number.isFinite(Number(newPrice))
    ? formatDecimal(newPrice)
    : '';
  const requiresManualPrice = !(Number(newPrice) > 0)
    && !showDecision;
  const hasManualPrice = Number(manualPriceUah) > 0;

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isApplying) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recount-confirm-title"
        tabIndex={-1}
        className="dialog-surface max-w-xl"
      >
        <div className="dialog-header">
          <p className="eyebrow">
            {isRequestMode
                ? 'Запит на виправлення'
                : 'Підтвердження переобліку'}
          </p>
          <h2 id="recount-confirm-title" className="mt-1 text-xl font-semibold text-slate-900 sm:text-2xl">
            {isRequestMode
                ? 'Передати товар на виправлення?'
                : 'Застосувати переоблік?'}
          </h2>
        </div>

        <div className="dialog-body space-y-5 px-5 py-5 sm:px-6">
          {showDecision && (
            <fieldset className="rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-semibold">Спосіб ціноутворення</legend>
              <div className="text-sm">Режим ціни</div>
              <div role="radiogroup" aria-label="Режим ціни"
                className="mt-2 flex flex-wrap gap-1 rounded-md bg-slate-100 p-1">
                {PRICING_MODES.map(({ value, label }) => (
                  <label key={value} className="relative min-w-20 flex-1 cursor-pointer">
                    <input type="radio" name="correction-pricing-mode" value={value}
                      checked={pricingMode === value}
                      onChange={() => {
                        setPreviewBeforeDecisionEdit(preview);
                        onPricingModeChange(value);
                      }}
                      className="peer sr-only" />
                    <span className="flex min-h-9 items-center justify-center rounded-md border border-transparent px-1.5 py-2 text-center text-xs font-semibold text-slate-600 transition hover:bg-white hover:text-slate-900 peer-checked:border-amber-300 peer-checked:bg-amber-50 peer-checked:text-amber-950 peer-checked:shadow-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-amber-500">
                      {label}
                    </span>
                  </label>
                ))}
              </div>
              {pricingMode === 'usd_per_gram' && (
                <div className="mt-3 space-y-3">
                  <label className="block text-sm">USD за грам
                    <input className="input mt-2" type="number" min="0.0001" step="0.0001"
                      value={usdPerGram} onChange={(event) => {
                        setPreviewBeforeDecisionEdit(preview);
                        onUsdPerGramChange(event.target.value);
                      }} />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={marketingRoundingEnabled}
                      onChange={(event) => {
                        setPreviewBeforeDecisionEdit(preview);
                        onMarketingRoundingChange(event.target.checked);
                      }} />
                    Маркетингове округлення
                  </label>
                </div>
              )}
              {pricingMode === 'manual_uah' && (
                <label className="mt-3 block text-sm">Точна ціна UAH
                  <input className="input mt-2" type="number" min="0.01" step="0.01"
                    value={manualPriceUah}
                    onChange={(event) => {
                      setPreviewBeforeDecisionEdit(preview);
                      onManualPriceChange(event.target.value);
                    }} />
                </label>
              )}
              {!previewCurrent && <p className="mt-2 text-sm text-amber-800">Оновлюємо розрахунок…</p>}
              {previewCurrent && pricingMode === 'system_auto' && !(Number(newPrice) > 0)
                && <p className="mt-2 text-sm text-amber-800">Автоматична ціна відсутня. Оберіть ручну ціну або USD/г.</p>}
            </fieldset>
          )}
          <div className="space-y-2 text-sm"><p className="font-semibold">Артикул: {sourceArticle}</p>
            {preview.nameChanges && <div className="space-y-1 break-words">
              {preview.nameChanges.from?.all !== preview.nameChanges.to.all && <p>Назва українською: {preview.nameChanges.from?.all || '—'} → {preview.nameChanges.to.all}</p>}
              {preview.nameChanges.from?.en !== preview.nameChanges.to.en && <p>Назва англійською: {preview.nameChanges.from?.en || '—'} → {preview.nameChanges.to.en}</p>}
            </div>}
            {(preview.changes || []).map((change) => <p key={change.key}>{change.key === 'weight' ? 'Вага' : getQuestionLabel(config, preview.corrected.categoryCode, change.key)}: {getAnswerValueLabel(config, preview.corrected.categoryCode, change.key, change.from)} → {getAnswerValueLabel(config, preview.corrected.categoryCode, change.key, change.to)}</p>)}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Було</div>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">
                  {sourceArticle}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(sourceArticle)}
                  className="btn btn-outline btn-icon"
                  aria-label="Скопіювати поточний артикул"
                  title="Скопіювати артикул"
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="mt-1 text-sm text-slate-600">{formatUah(oldPrice)}</div>
            </div>
            <div className="rounded-lg border border-[rgba(221,151,74,0.55)] bg-[rgba(221,151,74,0.12)] p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#8a5f2b]">Стане</div>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">
                  {correctedArticle}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(correctedArticle)}
                  className="btn btn-outline btn-icon"
                  aria-label="Скопіювати артикул після переобліку"
                  title="Скопіювати артикул"
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="min-w-0 flex-1 text-sm font-semibold text-slate-900">
                  {showTargetPrice ? formatUah(newPrice) : '—'}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(plainNewPrice)}
                  className="btn btn-outline btn-icon"
                  aria-label="Скопіювати нову ціну"
                  title="Скопіювати ціну"
                  disabled={!showTargetPrice}
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-600">Різниця в ціні</span>
            <span className="font-semibold text-slate-900">
              {showTargetPrice ? formatUah(priceDelta.toFixed(2)) : '—'}
            </span>
          </div>

          {requiresManualPrice && (
            <div className="danger-panel p-4 text-sm">
              <p>Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.</p>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="input mt-3"
                value={manualPriceUah}
                onChange={(event) => onManualPriceChange(event.target.value)}
                placeholder="Ручна ціна, грн"
                aria-label="Ручна ціна виправленого товару у гривнях"
              />
            </div>
          )}

          {error && (
            <div role="alert" className="danger-panel p-4 text-sm">
              {error}
            </div>
          )}

          {reason && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Причина</div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{reason}</p>
            </div>
          )}


        </div>

        <div className="dialog-footer grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-outline order-2 sm:order-1"
            disabled={isApplying}
          >
            Повернутися до параметрів
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => onConfirm(isRequestMode ? 'request' : 'apply')}
            className="btn btn-primary order-1 sm:order-2"
            disabled={isApplying || !previewCurrent || (isCustomDecision && !showTargetPrice)
              || (showDecision && !(Number(newPrice) > 0))
              || (requiresManualPrice && !hasManualPrice)}
          >
            {isApplying && submittingMode === (isRequestMode ? 'request' : 'apply')
              ? isRequestMode ? 'Створюємо запит…' : 'Застосовуємо…'
              : isRequestMode
                ? 'Створити запит'
                : 'Застосувати переоблік'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
