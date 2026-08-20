import { useEffect, useRef } from 'react';
import { Copy } from 'lucide-react';
import { formatUah } from '../../lib/formatters';

async function copyPlainText(value) {
  const text = String(value ?? '');
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back for internal HTTP deployments where Clipboard API may be unavailable.
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}

export function RecountConfirmDialog({
  isApplying,
  isOpen,
  onCancel,
  onConfirm,
  preview,
  reason,
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

  return (
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
          <p className="eyebrow">Підтвердження переобліку</p>
          <h2 id="recount-confirm-title" className="mt-1 text-xl font-semibold text-slate-900 sm:text-2xl">
            Створити коригувальний артикул?
          </h2>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Було</div>
              <div className="mt-2 break-all font-mono text-sm font-semibold text-slate-900">
                {preview.source.sku}
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

          {reason && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Причина</div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{reason}</p>
            </div>
          )}

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-slate-700">
            Новий артикул буде збережено як коригувальний і виключено з майбутніх експортів.
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-200 bg-slate-50/80 px-5 py-4 sm:grid-cols-2 sm:px-6">
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
            onClick={onConfirm}
            className="btn btn-primary order-1 sm:order-2"
            disabled={isApplying}
          >
            {isApplying ? 'Створюємо...' : 'Створити коригувальний артикул'}
          </button>
        </div>
      </div>
    </div>
  );
}
