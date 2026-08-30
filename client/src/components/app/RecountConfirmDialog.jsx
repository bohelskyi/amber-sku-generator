import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from 'lucide-react';
import { formatUah } from '../../lib/formatters';
import { copyPlainText } from '../../lib/clipboard';

export function RecountConfirmDialog({
  isApplying,
  isOpen,
  onCancel,
  onConfirm,
  preview,
  reason,
  manualPriceUah,
  onManualPriceChange,
  mode = 'apply',
  submittingMode = null,
}) {
  const confirmButtonRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    confirmButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isApplying) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isApplying, isOpen, onCancel]);

  if (!isOpen || !preview) return null;

  const oldPrice = preview.source.totalPriceUah;
  const newPrice = preview.corrected.totalPriceUah;
  const plainNewPrice = Number.isFinite(Number(newPrice))
    ? String(Math.round(Number(newPrice)))
    : '';
  const priceDelta = Number(preview.priceDeltaUah || 0);
  const isChoiceMode = mode === 'choice';
  const isRequestMode = mode === 'request';
  const requiresManualPrice = !(Number(newPrice) > 0);
  const hasManualPrice = Number(manualPriceUah) > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isApplying) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recount-confirm-title"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.3)]"
      >
        <div className="border-b border-slate-200 px-5 py-5 sm:px-6">
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

        <div className="space-y-5 px-5 py-5 sm:px-6">
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
                  className="btn btn-outline h-8 w-8 shrink-0 p-0"
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
                  className="btn btn-outline h-8 w-8 shrink-0 p-0"
                  aria-label="Скопіювати новий артикул"
                  title="Скопіювати артикул"
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="min-w-0 flex-1 text-sm font-semibold text-slate-900">
                  {formatUah(newPrice)}
                </div>
                <button
                  type="button"
                  onClick={() => copyPlainText(plainNewPrice)}
                  className="btn btn-outline h-8 w-8 shrink-0 p-0"
                  aria-label="Скопіювати нову ціну"
                  title="Скопіювати ціну"
                >
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-600">Різниця в ціні</span>
            <span className="font-semibold text-slate-900">{formatUah(priceDelta)}</span>
          </div>

          {requiresManualPrice && (
            <div className="danger-panel p-4 text-sm">
              <p>Автоматична ціна для цієї конфігурації відсутня. Вкажіть ціну вручну.</p>
              <input
                type="number"
                min="1"
                step="1"
                className="input mt-3"
                value={manualPriceUah}
                onChange={(event) => onManualPriceChange(event.target.value)}
                placeholder="Ручна ціна, грн"
              />
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
        </div>

        <div className={`grid gap-3 border-t border-slate-200 bg-slate-50/80 px-5 py-4 sm:px-6 ${isChoiceMode ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
              disabled={isApplying || (requiresManualPrice && !hasManualPrice)}
            >
              {isApplying && submittingMode === 'request' ? 'Створюємо...' : 'Створити запит'}
            </button>
          )}
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => onConfirm(isRequestMode ? 'request' : 'apply')}
            className={`btn btn-primary order-1 ${isChoiceMode ? 'sm:order-3' : 'sm:order-2'}`}
            disabled={isApplying || (requiresManualPrice && !hasManualPrice)}
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
