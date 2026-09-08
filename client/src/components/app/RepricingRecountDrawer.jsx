import { useEffect, useRef, useState } from 'react';
import { ClipboardList, RefreshCw, ScanSearch, X } from 'lucide-react';
import { DecodeErrorPanel, DecodeWorkspace } from './HomeDashboard';
import { RecountConfirmDialog } from './RecountConfirmDialog';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';
import { useProductRecount } from '../../hooks/useProductRecount';

export function RepricingRecountDrawer({
  config,
  initialMode = 'apply',
  initialSku = '',
  onApplied,
  onClose,
  onRequestCreated,
}) {
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);
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

  useDialogAccessibility({
    closeDisabled: recount.isRecountApplying,
    containerRef: drawerRef,
    initialFocusRef: closeButtonRef,
    isInteractionEnabled: !recount.isRecountConfirmOpen,
    isOpen: true,
    onClose,
  });

  return (
    <div
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="repricing-recount-drawer-title"
      tabIndex={-1}
      className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f5f7]/95 backdrop-blur-sm"
    >
      <div className="drawer-header sticky top-0 z-10 border-b border-white/10 bg-[#14203b] text-white shadow-md">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <ScanSearch size={19} className="shrink-0 text-[#dd974a]" />
          <div className="min-w-0 flex-1">
            <div id="repricing-recount-drawer-title" className="text-sm font-semibold text-slate-900">Декодер і переоблік</div>
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
            ref={closeButtonRef}
            type="button"
            className="btn btn-outline btn-icon-md"
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
            aria-label="Артикул для розшифрування або переобліку"
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
            isRecountPreviewCurrent={recount.isRecountPreviewCurrent}
            isRecountPreviewUnavailable={recount.isRecountPreviewUnavailable}
            recountAnswers={recount.recountAnswers}
            recountBlockers={recount.recountBlockers}
            recountError={recount.recountError}
            recountPreview={recount.recountPreview}
            recountReason={recount.recountReason}
            recountSuccess={recount.recountSuccess}
            recountValidationAttempt={recount.recountValidationAttempt}
            recountWeight={recount.recountWeight}
            onApplyRecount={recount.handleApplyRecount}
            onCancelRecount={recount.handleCancelRecount}
            onRecountAnswer={recount.handleRecountAnswer}
            onRecountReasonChange={recount.setRecountReason}
            onRecountTextAnswer={recount.handleRecountTextAnswer}
            onRecountWeightChange={recount.handleRecountWeightChange}
            onStartRecount={recount.handleStartRecount}
            recountMode={mode}
          />
        )}
      </main>

      <RecountConfirmDialog
        error={recount.recountError}
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
