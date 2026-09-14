import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from 'lucide-react';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { copyPlainText } from '../../lib/clipboard';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

function hasValidDecisionPrice(value, scale) {
  const text = String(value ?? '').trim().replace(',', '.');
  const amount = Number(text);
  return /^\d+(?:\.\d+)?$/.test(text) && Number.isFinite(amount)
    && amount > 0 && Number(amount.toFixed(scale)) === amount;
}

export function RecountConfirmDialog({
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
  const priceDelta = Number(preview.priceDeltaUah || 0);
  const isChoiceMode = mode === 'choice';
  const isRequestMode = mode === 'request';
  const showDecision = canPriceOverride && (isRequestMode || isChoiceMode);
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
    && (!showDecision || (isChoiceMode && pricingMode === 'system_auto'));
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
            {isChoiceMode
              ? 'Завершення переобліку'
              : isRequestMode
                ? 'Запит на виправлення'
                : 'Підтвердження переобліку'}
          </p>
          <h2 id="recount-confirm-title" className="mt-1 text-xl font-semibold text-slate-900 sm:text-2xl">
            {isChoiceMode
              ? 'Що зробити з виправленням?'
              : isRequestMode
                ? 'Передати товар на виправлення?'
                : 'Створити коригувальний артикул?'}
          </h2>
        </div>

        <div className="dialog-body space-y-5 px-5 py-5 sm:px-6">
          {showDecision && (
            <fieldset className="rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-semibold">Ціна запиту на виправлення</legend>
              <label className="block text-sm">
                Режим ціни
                <select className="input mt-2" value={pricingMode}
                  onChange={(event) => {
                    setPreviewBeforeDecisionEdit(preview);
                    onPricingModeChange(event.target.value);
                  }}>
                  <option value="system_auto">Автоматична ціна системи</option>
                  <option value="usd_per_gram">Власна ціна USD/г</option>
                  <option value="manual_uah">Точна ручна ціна UAH</option>
                </select>
              </label>
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
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Було</div>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">
                  {preview.source.sku}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(preview.source.sku)}
                  className="btn btn-outline btn-icon"
                  aria-label="Скопіювати старий артикул"
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
                  {preview.corrected.fullSku}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(preview.corrected.fullSku)}
                  className="btn btn-outline btn-icon"
                  aria-label="Скопіювати новий артикул"
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

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-slate-700">
            {isChoiceMode
              ? 'Запит збереже виправлення для подальшої обробки. Коригувальний артикул застосує переоблік одразу.'
              : isRequestMode
                ? 'Запит не змінить товар у базі. Переоблік буде виконано після ручного оновлення сайту.'
                : 'Новий артикул буде активним товаром, але не потрапить у звичайний експорт.'}
          </div>
          {isChoiceMode && isCustomDecision && (
            <p className="text-sm text-slate-600">
              Індивідуальна ціна діє лише для запитів на виправлення. Прямий переоблік використовує звичайні правила ціноутворення.
            </p>
          )}
        </div>

        <div className={`dialog-footer grid gap-3 ${isChoiceMode ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-outline order-2 sm:order-1"
            disabled={isApplying}
          >
            Повернутися до параметрів
          </button>
          {isChoiceMode && (
            <button
              type="button"
              onClick={() => onConfirm('request')}
              className="btn btn-outline order-1 sm:order-2"
              disabled={isApplying || !previewCurrent || (isCustomDecision && !showTargetPrice)
                || (showDecision && pricingMode === 'system_auto'
                && !(Number(newPrice) > 0)) || (requiresManualPrice && !hasManualPrice)}
            >
              {isApplying && submittingMode === 'request' ? 'Створюємо...' : 'Створити запит'}
            </button>
          )}
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => onConfirm(isRequestMode ? 'request' : 'apply')}
            className={`btn btn-primary order-1 ${isChoiceMode ? 'sm:order-3' : 'sm:order-2'}`}
            disabled={isApplying || !previewCurrent || (isChoiceMode && isCustomDecision)
              || (requiresManualPrice && !hasManualPrice)}
          >
            {isApplying && submittingMode === (isRequestMode ? 'request' : 'apply')
              ? 'Створюємо...'
              : isRequestMode
                ? 'Створити запит'
                : 'Створити коригувальний артикул'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
