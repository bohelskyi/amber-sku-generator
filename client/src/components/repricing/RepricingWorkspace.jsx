import { CheckCircle2 } from 'lucide-react';
import { Button, EmptyState, Notice, Pagination } from '../ui/index.js';
import { RepricingDraftPanel } from './RepricingDraftPanel';
import { RepricingFilters } from './RepricingFilters';
import { RepricingScopePanel } from './RepricingScopePanel';
import { RepricingSummary } from './RepricingSummary';
import { RepricingTable } from './RepricingTable';

export function RepricingWorkspace({
  canApplyDirectRecount,
  canCreateCorrectionRequest,
  canPrepareRepricing,
  controller,
  mayApplyRepricing,
  onBuildPreview,
  onOpenPrepare,
  onOpenReview,
  view = 'prepare',
}) {
  const {
    activeDraft,
    canApply,
    draftSaveState,
    filteredItems,
    itemPageInfo,
    manualOverrides,
    preview,
    reviewedProductIds,
    setConfirmOpen,
    setItemPage,
    visibleItems,
  } = controller;

  return (
    <section className="card repricing-workspace min-w-0">
      {view === 'prepare' && <>
        <RepricingScopePanel canPrepareRepricing={canPrepareRepricing}
          controller={{ ...controller, openSelectedRepricing: onBuildPreview }} />
        {preview && <>
          <RepricingDraftPanel canPrepareRepricing={canPrepareRepricing} controller={controller} />
          <div className="p-5 sm:p-6">
            <Notice tone="success" title="Результат підготовлено" actions={<Button variant="primary" onClick={onOpenReview}>Перейти до перевірки</Button>}>
              Перевірте весь набір змін перед застосуванням. Чернетка й повний серверний результат залишаються активними між розділами.
            </Notice>
          </div>
        </>}
      </>}
      {view === 'review' && !preview && <EmptyState title="Спочатку підготуйте переоцінку">
        Оберіть матрицю або загальну переоцінку в розділі «Підготовка».
        <Button variant="primary" onClick={onOpenPrepare}>Перейти до підготовки</Button>
      </EmptyState>}
      {view === 'review' && preview && (
        <>
          <RepricingDraftPanel canPrepareRepricing={canPrepareRepricing} controller={controller} />
          <RepricingSummary config={controller.config} controller={controller} />
          <RepricingFilters controller={controller} />
          <RepricingTable
            canApplyDirectRecount={canApplyDirectRecount}
            canCreateCorrectionRequest={canCreateCorrectionRequest}
            canPrepareRepricing={canPrepareRepricing}
            controller={controller}
          />
          <Pagination
            hasPrevious={itemPageInfo.hasPrevious}
            hasNext={itemPageInfo.hasNext}
            onPrevious={() => setItemPage(itemPageInfo.page - 1)}
            onNext={() => setItemPage(itemPageInfo.page + 1)}
            summary={filteredItems.length > 0
              ? `${itemPageInfo.page * itemPageInfo.pageSize + 1}–${Math.min((itemPageInfo.page + 1) * itemPageInfo.pageSize, itemPageInfo.total)} із ${itemPageInfo.total}`
              : '0 рядків'}
          />
          <div className="action-summary-bar flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
              <span>Рядків на цій сторінці: {visibleItems.length} із {filteredItems.length}</span>
              <span>Застосування охопить усі {controller.effectiveSummary.changedCount} підготовлені зміни.</span>
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
