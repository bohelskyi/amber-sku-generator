import {
  CircleDollarSign,
  FilePenLine,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { RepricingRecountDrawer } from '../components/app/RepricingRecountDrawer';
import { Button, LoadingState, Notice, PageHeader } from '../components/ui/index.js';
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
import '../components/workspace/workspace.css';

export default function RepricingPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const view = ['review', 'history'].includes(requestedView) ? requestedView : 'prepare';
  const permissionUi = getPermissionUiState(auth.permissions);
  const controller = useRepricingController({
    canPrepareRepricing: auth.permissions.includes('repricing.prepare'),
    canViewCorrections: auth.permissions.includes('corrections.view'),
    canViewProductConfig: auth.permissions.includes('products.view'),
  });
  const {
    canApplyDirectRecount,
    canApplyRepricing: mayApplyRepricing,
    canRollbackRepricing,
  } = permissionUi;
  const setView = (nextView) => setSearchParams(
    nextView === 'prepare' ? {} : { view: nextView },
    { replace: true }
  );
  const prepareSelected = async () => {
    if (await controller.openSelectedRepricing()) setView('review');
  };
  const prepareGlobal = async () => {
    if (await controller.openGlobalRepricing()) setView('review');
  };

  if (controller.loading) {
    return (
      <div className="app-page"><LoadingState label="Завантажуємо переоцінку…" /></div>
    );
  }

  return (
    <div className="app-page">
      <main className="mx-auto min-w-0 max-w-7xl space-y-5 overflow-hidden px-4 py-4 pb-20 sm:px-6 sm:py-6">
        {controller.previewing && <LoadingState label="Готуємо переоцінку… Перераховуємо актуальні ціни товарів." />}
        {controller.applying && <LoadingState label="Застосовуємо нові ціни…" />}
        <PageHeader
          breadcrumbs={[{ label: 'Ціни' }, { label: 'Переоцінка' }]}
          title="Масова переоцінка"
          description="Підготуйте й перевірте повний набір змін, збережіть чернетку та застосуйте ціни однією операцією."
          actions={<>
            {auth.permissions.includes('repricing.prepare') && <Button
              variant="amber"
              onClick={prepareGlobal}
              disabled={controller.previewing}
              title={controller.globalDraft ? 'Продовжити збережену загальну чернетку' : undefined}
            >
              {controller.globalDraft
                ? <FilePenLine size={16} />
                : <CircleDollarSign size={16} />}
              Переоцінити все
            </Button>}
          </>}
        />

        <nav className="local-workspace-nav" aria-label="Розділи переоцінки">
          <Link to="/admin/repricing" className={view === 'prepare' ? 'active' : undefined}
            aria-current={view === 'prepare' ? 'page' : undefined}>Підготовка</Link>
          <Link to="/admin/repricing?view=review" className={view === 'review' ? 'active' : undefined}
            aria-current={view === 'review' ? 'page' : undefined}>Перевірка</Link>
          <Link to="/admin/repricing?view=history" className={view === 'history' ? 'active' : undefined}
            aria-current={view === 'history' ? 'page' : undefined}>Історія</Link>
        </nav>

        {controller.error && <Notice>{controller.error}</Notice>}
        <RepricingWorkflowNotices controller={controller} />
        {view !== 'history' && <RepricingWorkspace
          canApplyDirectRecount={canApplyDirectRecount && Boolean(controller.config)}
          canCreateCorrectionRequest={false}
          controller={controller}
          canPrepareRepricing={auth.permissions.includes('repricing.prepare')}
          mayApplyRepricing={mayApplyRepricing}
          onBuildPreview={prepareSelected}
          onOpenPrepare={() => setView('prepare')}
          onOpenReview={() => setView('review')}
          view={view}
        />}
        {view === 'history' && <RepricingBatchHistory
          canRollbackRepricing={canRollbackRepricing}
          controller={controller}
        />}
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

      {canApplyDirectRecount && controller.recountTarget && controller.config && (
        <RepricingRecountDrawer
          canPriceOverride={permissionUi.canPriceOverrideCorrections}
          canApplyRecount={canApplyDirectRecount}
          canCreateRequest={false}
          config={controller.config}
          initialMode="apply"
          initialSku={controller.recountTarget.sku}
          onApplied={controller.handleRecountApplied}
          onRequestCreated={controller.handleCorrectionRequestCreated}
          onClose={() => controller.setRecountTarget(null)}
        />
      )}
    </div>
  );
}
