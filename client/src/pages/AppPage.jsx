import { HomeDashboard } from '../components/app/HomeDashboard';
import { PageHeader, Toast } from '../components/app/PageHeader';
import { ProductArchiveDialog } from '../components/app/ProductArchiveDialog';
import { ProductBuilder } from '../components/app/ProductBuilder';
import { ProductRegister } from '../components/app/ProductRegister';
import { ProductPriceChangeDialog } from '../components/app/ProductPriceChangeDialog';
import { RecountConfirmDialog } from '../components/app/RecountConfirmDialog';
import { LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { ConfirmDialog, OperationReceipt } from '../components/ui';
import { useAuth } from '../auth/auth-context.js';
import { isActualAdministrator } from '../auth/auth-model.js';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation.jsx';
import { useSkuManager } from '../hooks/useSkuManager';
import { getPermissionUiState, getRecountUiMode } from '../lib/permission-ui.js';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import { TestProductDeletion } from '../components/app/TestProductDeletion';
import { ExportWorkflowContext } from '../hooks/product/useExportWorkflow';
import '../components/app/product.css';

function AppPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [testDeletion, setTestDeletion] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveReceipt, setArchiveReceipt] = useState('');
  const [deletionReceipt, setDeletionReceipt] = useState(null);
  const [registerRefresh, setRegisterRefresh] = useState(0);
  const [searchParams] = useSearchParams();
  const exportSku = searchParams.get('exportSku')?.slice(0, 160);
  const isLandingRoute = location.pathname === '/products';
  const isOpenRoute = location.pathname === '/products/open';
  const isCreateRoute = location.pathname === '/products/create';
  const selectedArticle = isOpenRoute
    ? exportSku || searchParams.get('article')?.slice(0, 160)
    : null;
  const selectedCreateCategory = isCreateRoute
    ? searchParams.get('category')?.slice(0, 32)
    : null;
  const { exportHandoff, endExportHandoff } = useContext(ExportWorkflowContext) || {};
  const permissionUi = getPermissionUiState(auth.permissions);
  const recountMode = getRecountUiMode(permissionUi);
  const canViewConfig = auth.permissions.includes('products.view');
  const canViewRegister = auth.permissions.includes('history.view');
  const canDecodeProducts = auth.permissions.includes('products.decode');
  const canViewAttention = auth.permissions.includes('products.view')
    || auth.permissions.includes('corrections.view');
  const canDeleteTestProduct = isActualAdministrator(auth)
    && auth.permissions.includes('products.delete_test');
  const sku = useSkuManager({
    canViewConfig,
    canChangeProductPrice: permissionUi.canApplyDirectPriceChange
      || permissionUi.canCreateCorrectionRequest,
    canApplyDirectPriceChange: permissionUi.canApplyDirectPriceChange,
    canCreatePriceChangeRequest: permissionUi.canCreateCorrectionRequest,
    canPriceOverride: permissionUi.canPriceOverrideCorrections,
    submitMode: recountMode || 'apply',
  });
  const {
    canArchiveProducts,
    canCreateProducts: permittedToCreateProducts,
  } = permissionUi;
  const canCreateProducts = canViewConfig && permittedToCreateProducts;
  const savedArticle = sku.savedProduct?.publicSku;
  const isBuilderDirty = Boolean(sku.selectedCat && (
    Object.keys(sku.answers || {}).length > 0
    || Object.values(sku.nameSubjects || {}).some((value) => String(value || '').trim())
    || String(sku.weight || '').trim()
    || String(sku.manualPriceUah || '').trim()
    || sku.previewData
  ));
  const isProductDirty = isBuilderDirty
    || Boolean(sku.isRecountOpen && sku.hasRecountChanges)
    || Boolean(sku.isPriceChangeOpen);
  const discardProductChanges = () => {
    if (sku.isRecountOpen) sku.handleCancelRecount();
    if (sku.isPriceChangeOpen) sku.handleCancelPriceChange();
    if (sku.selectedCat) sku.resetProductFlow(null);
  };
  const dirtyNavigation = useDirtyNavigation({
    dirty: isProductDirty,
    discard: discardProductChanges,
    busy: sku.isSaving || sku.isRecountApplying || sku.isPriceChangeApplying,
  });
  const openedSku = useRef(null);
  const handoffCleanup = useRef(null);
  const viewOnlyHandoff = useEffectEvent(() => {
    if (!selectedArticle || (canViewConfig && !sku.config) || openedSku.current === selectedArticle || sku.selectedCat || sku.isRecountOpen || sku.isPriceChangeOpen
      || !canDecodeProducts) return;
    openedSku.current = selectedArticle;
    sku.handleDecode(selectedArticle);
  });
  useEffect(() => { viewOnlyHandoff(); }, [selectedArticle, sku.config, sku.selectedCat]);
  const synchronizeRoute = useEffectEvent(() => {
    if (isLandingRoute) {
      openedSku.current = null;
      if (sku.decodeData || sku.skuToDecode) sku.handleDecodeInputChange('');
      if (sku.selectedCat) sku.resetProductFlow(null);
      return;
    }
    if (isCreateRoute && sku.config) {
      const validCategory = selectedCreateCategory
        && Object.hasOwn(sku.config.categories || {}, selectedCreateCategory);
      if (validCategory && sku.selectedCat !== selectedCreateCategory) {
        sku.resetProductFlow(selectedCreateCategory);
      } else if (!validCategory && sku.selectedCat) {
        sku.resetProductFlow(null);
      }
      return;
    }
    if (isOpenRoute && sku.selectedCat) {
      sku.resetProductFlow(null);
    }
  });
  useEffect(() => {
    const timer = window.setTimeout(() => synchronizeRoute(), 0);
    return () => window.clearTimeout(timer);
  }, [location.pathname, selectedCreateCategory, sku.config]);
  useEffect(() => {
    // StrictMode replays setup/cleanup on mount. Clear context only after a
    // genuine departure, not during that replay while the product opens.
    window.clearTimeout(handoffCleanup.current);
    return () => { handoffCleanup.current = window.setTimeout(() => endExportHandoff?.(), 0); };
  }, [endExportHandoff]);
  useEffect(() => {
    if (!isProductDirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isProductDirty]);

  const openProduct = (article = sku.skuToDecode) => {
    const normalized = String(article || '').trim().toUpperCase();
    if (!normalized) {
      sku.handleDecode(article);
      return;
    }
    if (isOpenRoute && normalized === selectedArticle) {
      sku.handleDecode(normalized);
      return;
    }
    navigate(`/products/open?article=${encodeURIComponent(normalized)}`);
  };
  const startProduct = (categoryCode) => {
    if (isCreateRoute && selectedCreateCategory === categoryCode) {
      sku.resetProductFlow(categoryCode);
      return;
    }
    navigate(`/products/create?category=${encodeURIComponent(categoryCode)}`);
  };

  if (canViewConfig && !sku.config) {
    return (
      <div className="app-page p-6">{sku.configError ? <Notice tone="error"><p>{sku.configError}</p><button className="btn btn-outline" onClick={sku.retryConfig}>Спробувати ще раз</button></Notice>
        : <LoadingState label="Підтягуємо конфігурацію та історію…" />}</div>
    );
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-4 sm:px-6 sm:py-6">
        <PageHeader />
        <Toast message={sku.copyMessage} />
        {sku.savedProduct && !deletionReceipt && (
          <OperationReceipt title="Товар збережено" identity={savedArticle}
            actions={savedArticle && <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-amber"
                  onClick={() => sku.handleCopyText(savedArticle, 'Артикул')}>Копіювати артикул</button>
                <Link className="btn btn-outline" to={`/products/open?article=${encodeURIComponent(savedArticle)}`}>Відкрити товар</Link>
              </div>}>
            {!savedArticle && <p>Артикул недоступний у відповіді сервера.</p>}
          </OperationReceipt>
        )}
        {archiveReceipt && <Notice tone="success" actions={<button type="button" className="btn btn-ghost" onClick={() => setArchiveReceipt('')}>Закрити</button>}>{archiveReceipt}</Notice>}
        {deletionReceipt && <OperationReceipt title="Видалення тестового товару підтверджено"
          identity={deletionReceipt.publicSku} description={`Стан операції: ${deletionReceipt.state}.`}
          actions={<button type="button" className="btn btn-ghost" onClick={() => setDeletionReceipt(null)}>Закрити</button>}
          details={<p className="break-all font-mono text-xs">Внутрішній SKU: {deletionReceipt.internalSku || 'недоступний'}</p>} />}
        {exportSku && auth.permissions.includes('products.view') && auth.permissions.includes('products.decode') && <section className="card p-4 space-y-2">
          <p>Відкрито з перевірки експорту · <strong>{exportSku}</strong></p>
          {exportHandoff?.sku === exportSku && <p>{exportHandoff.reason}</p>}
          <Link className="btn btn-primary px-3" to={exportHandoff?.sku === exportSku ? exportHandoff.returnTo : '/exports'}>Повернутися до перевірки</Link>
          {sku.decodeData?.sku !== exportSku && <>
          <button className="btn btn-outline px-3" disabled={Boolean(sku.selectedCat || sku.hasRecountChanges || sku.isRecountApplying || sku.isPriceChangeOpen)}
            onClick={() => sku.handleDecode(exportSku)}>Відкрити товар із експорту</button>
          {(sku.selectedCat || sku.hasRecountChanges || sku.isPriceChangeOpen) && <p>Спочатку завершіть або скасуйте поточні зміни товару.</p>}</>}
          <p className="text-sm">{sku.hasRecountChanges ? 'Є незбережені зміни товару.' : exportHandoff?.sku === exportSku && exportHandoff.saved ? 'Зміни товару збережено. У перевірці експорту буде показано актуальні дані сервера.' : 'Перегляд товару. Зміни не внесено.'}</p>
        </section>}

        {!sku.selectedCat && sku.isDecodeLoading && <LoadingState label="Відкриваємо товар…" />}

        {!sku.selectedCat && !sku.isDecodeLoading && (
          <HomeDashboard
            canArchiveProducts={canArchiveProducts}
            canDecodeProducts={canDecodeProducts}
            canDeleteTestProduct={canDeleteTestProduct}
            config={sku.config}
            exportStatus={sku.exportStatus}
            priceExportStatus={sku.priceExportStatus}
            skuToDecode={sku.skuToDecode}
            decodeData={sku.decodeData}
            decodeError={sku.decodeError}
            decodeErrorDetails={sku.decodeErrorDetails}
            hasRecountChanges={sku.hasRecountChanges}
            isInformationOnly={sku.isInformationOnly}
            isRecountApplying={sku.isRecountApplying}
            isRecountLoading={sku.isRecountLoading}
            isRecountOpen={sku.isRecountOpen}
            isRecountPreviewCurrent={sku.isRecountPreviewCurrent}
            isRecountPreviewUnavailable={sku.isRecountPreviewUnavailable}
            recountAnswers={sku.recountAnswers}
            recountBlockers={sku.recountBlockers}
            recountError={sku.recountError}
            recountPreview={sku.recountPreview}
            recountReason={sku.recountReason}
            recountSuccess={sku.recountSuccess}
            recountValidationAttempt={sku.recountValidationAttempt}
            recountWeight={sku.recountWeight}
            canCreateProducts={canCreateProducts}
            canViewAttention={canViewAttention}
            canViewHistory={canViewRegister}
            showCreate={isLandingRoute || isCreateRoute}
            showLookup={!isCreateRoute}
            canStartRecount={Boolean(sku.config && recountMode)}
            canChangeProductPrice={permissionUi.canApplyDirectPriceChange
              || permissionUi.canCreateCorrectionRequest}
            recountMode={recountMode || 'apply'}
            onApplyRecount={sku.handleApplyRecount}
            onCancelRecount={() => dirtyNavigation.request(sku.handleCancelRecount)}
            onRecountAnswer={sku.handleRecountAnswer}
            onRecountReasonChange={sku.setRecountReason}
            onRecountTextAnswer={sku.handleRecountTextAnswer}
            onRecountWeightChange={sku.handleRecountWeightChange}
            onRecountNameChange={sku.handleRecountNameChange}
            onStart={startProduct}
            onStartRecount={sku.handleStartRecount}
            onStartPriceChange={sku.handleStartPriceChange}
            onDecode={openProduct}
            onDecodeInputChange={sku.handleDecodeInputChange}
            onArchive={() => setArchiveTarget({
              article: sku.decodeData?.publicSku,
              internalSku: sku.decodeData?.internalSku || sku.decodeData?.sku,
            })}
            onDeleteTest={() => setTestDeletion({ ...sku.decodeData.product,
              public_sku: sku.decodeData.publicSku, full_sku: sku.decodeData.sku })}
          />
        )}

        {canCreateProducts && sku.selectedCat && (
          <ProductBuilder
            config={sku.config}
            selectedCat={sku.selectedCat}
            answers={sku.answers}
            nameSubjects={sku.nameSubjects}
            onNameSubject={sku.handleNameSubject}
            weight={sku.weight}
            setWeight={sku.setWeight}
            isWeightRequired={sku.isWeightRequired}
            answeredRequiredCount={sku.answeredRequiredCount}
            requiredCount={sku.requiredCount}
            previewData={sku.previewData}
            livePriceData={sku.livePriceData}
            isLivePriceLoading={sku.isLivePriceLoading}
            finalSku={sku.finalSku}
            effectiveTotalPriceUah={sku.effectiveTotalPriceUah}
            hasManualPrice={sku.hasManualPrice}
            isVariationActive={sku.isVariationActive}
            variationData={sku.variationData}
            variationError={sku.variationError}
            isVariationLoading={sku.isVariationLoading}
            isManualPriceEditing={sku.isManualPriceEditing}
            isSaving={sku.isSaving}
            requiresManualPrice={sku.requiresManualPrice}
            manualPriceUah={sku.manualPriceUah}
            saveError={sku.saveError}
            getVisibleOptionsForQuestion={sku.getVisibleOptions}
            isQuestionVisible={sku.getQuestionVisibility}
            isTextQuestion={sku.isTextQuestion}
            onAnswer={sku.handleAnswer}
            onTextAnswer={sku.handleTextAnswer}
            onPreview={sku.handlePreview}
            onCopyText={sku.handleCopyText}
            onAddVariation={sku.handleAddVariation}
            onManualPriceChange={sku.handleManualPriceChange}
            onResetManualPrice={sku.handleResetManualPrice}
            onSave={sku.handleSave}
            onStartManualPriceEdit={sku.handleStartManualPriceEdit}
            onStopManualPriceEdit={sku.handleStopManualPriceEdit}
            onCancel={() => dirtyNavigation.request(() => {
              sku.resetProductFlow(null);
              navigate('/products/create');
            })}
          />
        )}

        {canViewRegister && isLandingRoute && !sku.selectedCat && !sku.decodeData && !sku.isDecodeLoading && (
          <ProductRegister canDecode={canDecodeProducts} refreshKey={registerRefresh} />
        )}
      </div>
      {archiveTarget && <ProductArchiveDialog article={archiveTarget.article} internalSku={archiveTarget.internalSku} onClose={() => setArchiveTarget(null)}
        onArchived={({ message }) => {
          setArchiveTarget(null);
          setArchiveReceipt(message);
          setRegisterRefresh((value) => value + 1);
          sku.handleDecodeInputChange('');
          navigate('/products');
        }} />}
      {testDeletion && canDeleteTestProduct && <TestProductDeletion
        key={testDeletion.id} product={testDeletion} onClose={() => setTestDeletion(null)}
        onDeleted={(receipt) => {
          setDeletionReceipt(receipt);
          setTestDeletion(null);
          setRegisterRefresh((value) => value + 1);
          sku.handleDecodeInputChange('');
          navigate('/products');
        }} />}
      <RecountConfirmDialog
        config={sku.config}
        canPriceOverride={permissionUi.canPriceOverrideCorrections}
        error={sku.recountError}
        isApplying={sku.isRecountApplying}
        isOpen={sku.isRecountConfirmOpen}
        preview={sku.recountPreview}
        reason={sku.recountReason}
        manualPriceUah={sku.recountManualPriceUah}
        pricingMode={sku.recountPricingMode}
        usdPerGram={sku.recountUsdPerGram}
        marketingRoundingEnabled={sku.recountMarketingRounding}
        previewCurrent={sku.isRecountPreviewCurrent}
        onManualPriceChange={sku.setRecountManualPriceUah}
        onPricingModeChange={sku.setRecountPricingMode}
        onUsdPerGramChange={sku.setRecountUsdPerGram}
        onMarketingRoundingChange={sku.setRecountMarketingRounding}
        mode={recountMode || 'apply'}
        submittingMode={sku.recountSubmitMode}
        onCancel={sku.handleCancelRecountConfirmation}
        onConfirm={sku.handleConfirmRecount}
      />
      <ConfirmDialog
        open={sku.isInformationConfirmOpen}
        title="Оновити інформаційні характеристики?"
        description={sku.informationPreview?.publicSku
          ? `Артикул ${sku.informationPreview.publicSku}. SKU, ціна та стан товару не зміняться.`
          : 'Артикул недоступний. SKU, ціна та стан товару не зміняться.'}
        confirmLabel="Оновити характеристики"
        busy={sku.isRecountApplying}
        confirmDisabled={!sku.informationPreview}
        onClose={sku.handleCancelInformationConfirmation}
        onConfirm={sku.handleConfirmInformationUpdate}
      >
        {sku.recountError && <Notice tone="error">{sku.recountError}</Notice>}
      </ConfirmDialog>
      <ProductPriceChangeDialog
        canApplyDirect={permissionUi.canApplyDirectPriceChange}
        canCreateRequest={permissionUi.canCreateCorrectionRequest}
        canRequestOverride={permissionUi.canPriceOverrideCorrections}
        canUseOverrides={permissionUi.canApplyDirectPriceChange
          || permissionUi.canPriceOverrideCorrections}
        currentPriceUah={sku.decodeData?.pricing?.totalPriceUah}
        error={sku.priceChangeError}
        isApplying={sku.isPriceChangeApplying}
        isLoading={sku.isPriceChangeLoading}
        isOpen={sku.isPriceChangeOpen}
        manualPriceUah={sku.priceChangeManualUah}
        manualMarketingRoundingEnabled={sku.priceChangeManualRounding}
        marketingRoundingEnabled={sku.priceChangeMarketingRounding}
        mode={sku.priceChangeMode}
        preview={sku.priceChangePreview}
        sku={sku.decodeData?.publicSku || 'Артикул недоступний'}
        usdPerGram={sku.priceChangeUsdPerGram}
        onCancel={sku.handleCancelPriceChange}
        onConfirm={sku.handleConfirmPriceChange}
        onRequest={sku.handleRequestPriceChange}
        onManualPriceChange={sku.setPriceChangeManualUah}
        onManualMarketingRoundingChange={sku.setPriceChangeManualRounding}
        onMarketingRoundingChange={sku.setPriceChangeMarketingRounding}
        onModeChange={sku.setPriceChangeMode}
        onUsdPerGramChange={sku.setPriceChangeUsdPerGram}
      />
      {dirtyNavigation.prompt}
    </div>
  );
}

export default AppPage;
