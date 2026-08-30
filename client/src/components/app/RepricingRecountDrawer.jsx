import { useEffect, useRef, useState } from 'react';
import { ClipboardList, RefreshCw, ScanSearch, X } from 'lucide-react';
import { DecodeErrorPanel, DecodeWorkspace } from './HomeDashboard';
import { RecountConfirmDialog } from './RecountConfirmDialog';
import { useProductRecount } from '../../hooks/useProductRecount';

export function RepricingRecountDrawer({
  config,
  initialMode = 'apply',
  initialSku = '',
  onApplied,
  onClose,
  onRequestCreated,
}) {
  const initializedSkuRef = useRef('');
  const [mode, setMode] = useState(initialMode);
  const recount = useProductRecount({
    config,
    onApplied,
    onRequestCreated,
    submitMode: mode,
  });

  useEffect(() => {
    const normalizedSku = String(initialSku || '').trim().toUpperCase();
    if (!normalizedSku || initializedSkuRef.current === normalizedSku) return;
    initializedSkuRef.current = normalizedSku;
    recount.handleDecode(normalizedSku);
  }, [initialSku, recount]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !recount.isRecountApplying) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, recount.isRecountApplying]);

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-100/95 backdrop-blur-sm">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <ScanSearch size={19} className="shrink-0 text-slate-600" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900">Декодер і переоблік</div>
            <div className="truncate text-xs text-slate-500">{recount.skuToDecode || 'Артикул не обрано'}</div>
          </div>
          <div className="hidden rounded-md bg-slate-100 p-1 sm:flex">
            <button
              type="button"
              className={`flex h-8 items-center gap-1.5 rounded px-3 text-xs font-semibold ${mode === 'request' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
              onClick={() => setMode('request')}
              disabled={recount.isRecountApplying}
            >
              <ClipboardList size={14} />
              Створити запит
            </button>
            <button
              type="button"
              className={`flex h-8 items-center gap-1.5 rounded px-3 text-xs font-semibold ${mode === 'apply' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
              onClick={() => setMode('apply')}
              disabled={recount.isRecountApplying}
            >
              <RefreshCw size={14} />
              Переоблік зараз
            </button>
          </div>
          <button
            type="button"
            className="btn btn-outline flex h-9 w-9 shrink-0 items-center justify-center p-0"
            onClick={onClose}
            disabled={recount.isRecountApplying}
            title="Закрити"
            aria-label="Закрити декодер"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6 sm:py-7">
        <div className="grid grid-cols-2 rounded-md bg-slate-200/70 p-1 sm:hidden">
          <button
            type="button"
            className={`rounded px-2 py-2 text-xs font-semibold ${mode === 'request' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
            onClick={() => setMode('request')}
            disabled={recount.isRecountApplying}
          >
            Створити запит
          </button>
          <button
            type="button"
            className={`rounded px-2 py-2 text-xs font-semibold ${mode === 'apply' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
            onClick={() => setMode('apply')}
            disabled={recount.isRecountApplying}
          >
            Переоблік зараз
          </button>
        </div>
        <section className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row">
          <input
            type="text"
            value={recount.skuToDecode}
            onChange={(event) => recount.handleDecodeInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') recount.handleDecode();
            }}
            className="input min-w-0 flex-1"
            placeholder="Введіть артикул"
          />
          <button
            type="button"
            className="btn btn-primary gap-2 sm:min-w-48"
            onClick={() => recount.handleDecode()}
          >
            <ScanSearch size={16} />
            Розшифрувати
          </button>
        </section>

        {recount.decodeError && (
          <DecodeErrorPanel
            details={recount.decodeErrorDetails}
            message={recount.decodeError}
          />
        )}

        {recount.decodeData && (
          <DecodeWorkspace
            config={config}
            decodeData={recount.decodeData}
            hasRecountChanges={recount.hasRecountChanges}
            isRecountApplying={recount.isRecountApplying}
            isRecountLoading={recount.isRecountLoading}
            isRecountOpen={recount.isRecountOpen}
            recountAnswers={recount.recountAnswers}
            recountError={recount.recountError}
            recountPreview={recount.recountPreview}
            recountReason={recount.recountReason}
            recountSuccess={recount.recountSuccess}
            onApplyRecount={recount.handleApplyRecount}
            onCancelRecount={recount.handleCancelRecount}
            onRecountAnswer={recount.handleRecountAnswer}
            onRecountPreview={recount.handleRecountPreview}
            onRecountReasonChange={recount.setRecountReason}
            onRecountTextAnswer={recount.handleRecountTextAnswer}
            onStartRecount={recount.handleStartRecount}
            recountMode={mode}
          />
        )}
      </main>

      <RecountConfirmDialog
        isApplying={recount.isRecountApplying}
        isOpen={recount.isRecountConfirmOpen}
        preview={recount.recountPreview}
        reason={recount.recountReason}
        manualPriceUah={recount.recountManualPriceUah}
        onManualPriceChange={recount.setRecountManualPriceUah}
        mode={mode}
        submittingMode={recount.recountSubmitMode}
        onCancel={recount.handleCancelRecountConfirmation}
        onConfirm={recount.handleConfirmRecount}
      />
    </div>
  );
}
