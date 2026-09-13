import {
  ArrowLeft,
  CircleDollarSign,
  ClipboardList,
  FilePenLine,
  ScanSearch,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { RepricingRecountDrawer } from '../components/app/RepricingRecountDrawer';
import { AppPageHeader, LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { RepricingBatchHistory } from '../components/repricing/RepricingBatchHistory';
import {
  ConfirmDialog,
  DiscardDraftDialog,
  RollbackDialog,
} from '../components/repricing/RepricingDialogs';
import { RepricingWorkflowNotices } from '../components/repricing/RepricingWorkflowNotices';
import { RepricingWorkspace } from '../components/repricing/RepricingWorkspace';
import { useRepricingController } from '../hooks/repricing/useRepricingController';
import { getPermissionUiState } from '../lib/permission-ui.js';

export default function RepricingPage() {
  const auth = useAuth();
  const permissionUi = getPermissionUiState(auth.permissions);
  const controller = useRepricingController();
  const {
    canApplyDirectRecount,
    canApplyRepricing: mayApplyRepricing,
    canCreateCorrectionRequest,
    canRollbackRepricing,
  } = permissionUi;
  const canViewCatalogOrPricing = permissionUi.canViewCatalog || permissionUi.canViewPricing;
  const defaultRecountMode = canApplyDirectRecount ? 'apply' : 'request';

  if (controller.loading) {
    return (
      <div className="app-page"><LoadingState label="Завантажуємо переоцінку…" /></div>
    );
  }

  return (
    <div className="app-page">
      <main className="mx-auto min-w-0 max-w-7xl space-y-5 overflow-hidden px-4 py-4 pb-20 sm:px-6 sm:py-6">
        <AppPageHeader
          eyebrow="Ціни"
          title="Масова переоцінка"
          description="Метрики, ручні рішення та контрольоване застосування нових цін."
          actions={<>
            <button
              type="button"
              className="btn btn-amber gap-2"
              onClick={controller.openGlobalRepricing}
              disabled={controller.previewing}
            >
              {controller.globalDraft
                ? <FilePenLine size={16} />
                : <CircleDollarSign size={16} />}
              {controller.globalDraft
                ? 'Продовжити загальну чернетку'
                : 'Переоцінити все'}
            </button>
            {(canApplyDirectRecount || canCreateCorrectionRequest) && (
              <button
                type="button"
                className="btn btn-outline gap-2"
                onClick={() => controller.setRecountTarget({
                  productId: null,
                  sku: '',
                  mode: defaultRecountMode,
                })}
              >
                <ScanSearch size={16} />
                Декодер
              </button>
            )}
            <Link to="/admin/corrections?from=admin" className="btn btn-outline gap-2">
              <ClipboardList size={16} />
              Запити{controller.correctionRequests.length > 0
                ? ` · ${controller.correctionRequests.length}`
                : ''}
            </Link>
            {canViewCatalogOrPricing && (
              <Link to="/admin" className="btn btn-outline gap-2">
                <ArrowLeft size={16} />
                До адмін-панелі
              </Link>
            )}
          </>}
        />

        {controller.error && <Notice>{controller.error}</Notice>}
        <RepricingWorkflowNotices controller={controller} />
        <RepricingWorkspace
          canApplyDirectRecount={canApplyDirectRecount}
          canCreateCorrectionRequest={canCreateCorrectionRequest}
          controller={controller}
          mayApplyRepricing={mayApplyRepricing}
        />
        <RepricingBatchHistory
          canRollbackRepricing={canRollbackRepricing}
          controller={controller}
        />
      </main>

      {mayApplyRepricing && controller.confirmOpen && controller.preview && (
        <ConfirmDialog
          changedCount={controller.effectiveSummary.changedCount}
          manualCount={controller.manualOverrides.length}
          pending={controller.applying}
          onCancel={() => controller.setConfirmOpen(false)}
          onConfirm={controller.applyPreview}
        />
      )}

      {canRollbackRepricing && controller.rollbackTarget && (
        <RollbackDialog
          batch={controller.rollbackTarget}
          pending={controller.rollingBack}
          onCancel={() => controller.setRollbackTarget(null)}
          onConfirm={controller.rollbackBatch}
        />
      )}

      {controller.discardDraftOpen && controller.activeDraft && (
        <DiscardDraftDialog
          pending={controller.discardingDraft}
          onCancel={() => controller.setDiscardDraftOpen(false)}
          onConfirm={controller.discardDraft}
        />
      )}

      {controller.recountTarget && (
        <RepricingRecountDrawer
          canApplyRecount={canApplyDirectRecount}
          canCreateRequest={canCreateCorrectionRequest}
          config={controller.config}
          initialMode={controller.recountTarget.mode || 'apply'}
          initialSku={controller.recountTarget.sku}
          onApplied={controller.handleRecountApplied}
          onRequestCreated={controller.handleCorrectionRequestCreated}
          onClose={() => controller.setRecountTarget(null)}
        />
      )}
    </div>
  );
}
