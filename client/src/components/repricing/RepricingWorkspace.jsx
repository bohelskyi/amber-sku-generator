import { CheckCircle2 } from 'lucide-react';
import { RepricingDraftPanel } from './RepricingDraftPanel';
import { RepricingFilters } from './RepricingFilters';
import { RepricingScopePanel } from './RepricingScopePanel';
import { RepricingSummary } from './RepricingSummary';
import { RepricingTable } from './RepricingTable';

export function RepricingWorkspace({
  canApplyDirectRecount,
  canCreateCorrectionRequest,
  controller,
  mayApplyRepricing,
}) {
  const {
    activeDraft,
    canApply,
    draftSaveState,
    manualOverrides,
    preview,
    reviewedProductIds,
    setConfirmOpen,
    visibleItems,
  } = controller;

  return (
    <section className="card repricing-workspace min-w-0">
      <RepricingScopePanel controller={controller} />
      {preview && (
        <>
          <RepricingDraftPanel controller={controller} />
          <RepricingSummary controller={controller} />
          <RepricingFilters controller={controller} />
          <RepricingTable
            canApplyDirectRecount={canApplyDirectRecount}
            canCreateCorrectionRequest={canCreateCorrectionRequest}
            controller={controller}
          />
          <div className="action-summary-bar flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
              <span>Рядків у перегляді: {visibleItems.length}</span>
              {manualOverrides.length > 0 && (
                <span className="font-medium text-amber-700">
                  Ручних цін: {manualOverrides.length}
                </span>
              )}
              {reviewedProductIds.length > 0 && (
                <span className="font-medium text-emerald-700">
                  Переглянуто: {reviewedProductIds.length}
                </span>
              )}
              {activeDraft && draftSaveState === 'saving' && (
                <span className="font-medium text-slate-600">Зберігаємо чернетку...</span>
              )}
            </div>
            {mayApplyRepricing && (
              <button
                type="button"
                className="btn btn-amber gap-2"
                disabled={!canApply}
                onClick={() => setConfirmOpen(true)}
              >
                <CheckCircle2 size={16} />
                Застосувати переоцінку
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
