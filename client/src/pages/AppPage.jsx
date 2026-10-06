import { HomeDashboard } from '../components/app/HomeDashboard';
import { PageHeader, Toast } from '../components/app/PageHeader';
import { ProductArchiveDialog } from '../components/app/ProductArchiveDialog';
import { HistoricalReactivationReview } from '../components/app/HistoricalReactivationReview.jsx';
import { canUseHistoricalReactivation } from '../lib/historical-reactivation.js';
import { ProductRestoreBatch } from '../components/app/ProductRestoreBatch.jsx';
import { ProductLifecycleStatus } from '../components/app/ProductLifecycleStatus.jsx';
import CreationDeliveryNotice from '../components/app/CreationDeliveryNotice.jsx';
import CreationIntegrationResume from '../components/app/CreationIntegrationResume.jsx';
import { ProductBuilder } from '../components/app/ProductBuilder';
import { ProductRegister } from '../components/app/ProductRegister';
import { ProductPriceChangeDialog } from '../components/app/ProductPriceChangeDialog';
import { RecountConfirmDialog } from '../components/app/RecountConfirmDialog';
import { LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { ConfirmDialog, CopyAction, OperationReceipt, StatusBadge } from '../components/ui';
import { useAuth } from '../auth/auth-context.js';
import { isActualAdministrator } from '../auth/auth-model.js';
import { isTestProduct } from '../lib/test-product.js';
import { TestProductNotice } from '../components/app/TestProductNotice.jsx';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation.jsx';
import { useProductPhotos } from '../hooks/useProductPhotos.js';
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
  const [archiveReceipt, setArchiveReceipt] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreDirty, setRestoreDirty] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [historicalOpen, setHistoricalOpen] = useState(false);
  const [historicalDirty, setHistoricalDirty] = useState(false);
  const [historicalBusy, setHistoricalBusy] = useState(false);
  const [historicalSession, setHistoricalSession] = useState(0);
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
  const integrationTaskId = isCreateRoute ? searchParams.get('integrationTask')?.slice(0,100) : null;
  const requestedRepair = isOpenRoute && searchParams.get('action') === 'recount';
  const requestedAttentionReturn = searchParams.get('returnTo');
  const attentionReturn = typeof requestedAttentionReturn === 'string'
    && requestedAttentionReturn.length <= 3000 && /^\/(?:attention|sync-problems)(?:\?[^#]*)?$/.test(requestedAttentionReturn)
    ? requestedAttentionReturn : requestedRepair ? '/attention' : null;
  const { exportHandoff, endExportHandoff } = useContext(ExportWorkflowContext) || {};
  const permissionUi = getPermissionUiState(auth.permissions);
  const recountMode = getRecountUiMode(permissionUi);
  const canViewConfig = auth.permissions.includes('products.view');
  const canViewRegister = auth.permissions.includes('history.view');
  const canDecodeProducts = auth.permissions.includes('products.decode');
  const canViewAttention = auth.permissions.includes('products.view');
  const canDeleteTestProduct = isActualAdministrator(auth)
    && auth.permissions.includes('products.delete_test');
  const sku = useSkuManager({
    canViewConfig,
    canCreateProducts: canViewConfig && permissionUi.canCreateProducts,
    canCreateTestProducts: isActualAdministrator(auth) && canViewConfig && permissionUi.canCreateProducts,
    canChangeProductPrice: permissionUi.canApplyDirectPriceChange,
    canApplyDirectPriceChange: permissionUi.canApplyDirectPriceChange,
    canCreatePriceChangeRequest: false,
    canPriceOverride: permissionUi.canPriceOverrideCorrections,
    submitMode: recountMode || 'apply',
  });
  const {
    canArchiveProducts,
    canCreateProducts: permittedToCreateProducts,
  } = permissionUi;
  const canCreateProducts = canViewConfig && permittedToCreateProducts;
  const savedArticle = sku.savedProduct?.publicSku;
  const photosAvailable = Boolean(sku.config?.productPhotoRequirements?.available);
  const lifecycleAvailable = Boolean(sku.config?.productLifecycle?.available);
  const canRestoreProducts = canViewConfig && canArchiveProducts && lifecycleAvailable;
  const canHistoricalReactivate = canUseHistoricalReactivation(auth, sku.config);
  const photoCanEdit = auth.permissions.includes('products.recount') && sku.decodeData?.product?.status === 'active'
    && !sku.decodeData?.product?.corrected_to_product_id;
  const productPhotos = useProductPhotos({
    allowProductActivation: !isTestProduct(sku.decodeData),
    productId: photosAvailable && canViewConfig && sku.decodeData?.existsInDb ? sku.decodeData.product?.id : null,
    canEdit: photoCanEdit,
    onSaved: () => sku.handleDecode(sku.decodeData?.publicSku || sku.decodeData?.sku),
  });
  const isBuilderDirty = Boolean(sku.selectedCat && (
    Object.keys(sku.answers || {}).length > 0
    || Object.values(sku.nameSubjects || {}).some((value) => String(value || '').trim())
    || String(sku.weight || '').trim()
    || sku.isTestProduct
    || String(sku.manualPriceUah || '').trim()
    || String(sku.creationUsdPerGram || '').trim()
    || sku.creationPhotos?.dirty
    || sku.creationPhotos?.hasPendingUploads
    || sku.previewData
  ));
  const isProductDirty = isBuilderDirty
    || Boolean(sku.isRecountOpen && sku.hasRecountChanges)
    || Boolean(sku.isPriceChangeOpen)
    || productPhotos.dirty || productPhotos.hasPendingUploads || restoreDirty || archiveBusy || restoreBusy || historicalDirty || historicalBusy;
  const discardProductChanges = () => {
    if (sku.isRecountOpen) sku.handleCancelRecount();
    if (sku.isPriceChangeOpen) sku.handleCancelPriceChange();
    if (sku.selectedCat) sku.resetProductFlow(null);
    if (productPhotos.dirty || productPhotos.hasPendingUploads) productPhotos.reset();
    if (restoreOpen) setRestoreOpen(false);
    if (historicalOpen) {
      setHistoricalOpen(false);
      if (historicalDirty && !historicalBusy) setHistoricalSession((value) => value + 1);
    }
  };
  const dirtyNavigation = useDirtyNavigation({
    dirty: isProductDirty,
    discard: discardProductChanges,
    busy: sku.isSaving || sku.isCreationSaveUncertain || sku.creationPhotos?.busy || sku.isRecountApplying || sku.isPriceChangeApplying || productPhotos.busy || restoreBusy || archiveBusy || historicalBusy,
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
  const repairEntry = useRef(null);
  const startRequestedRepair = useEffectEvent(() => {
    const key = `${location.key}:${selectedArticle}`;
    if (!requestedRepair || repairEntry.current === key || !permissionUi.canApplyDirectRecount
      || !sku.config || sku.isDecodeLoading || !sku.decodeData?.existsInDb
      || sku.decodeData.product?.status !== 'active' || sku.isRecountOpen
      || sku.decodeData.publicSku !== selectedArticle) return;
    repairEntry.current = key;
    sku.handleStartRecount();
  });
  useEffect(() => { startRequestedRepair(); }, [location.key, requestedRepair, selectedArticle, sku.config, sku.decodeData, sku.isDecodeLoading]);
  const synchronizeRoute = useEffectEvent(() => {
    if (isLandingRoute) {
      openedSku.current = null;
      if (sku.decodeData || sku.skuToDecode) sku.handleDecodeInputChange('');
      if (sku.selectedCat) sku.resetProductFlow(null);
      return;
    }
      if (isCreateRoute && sku.config) {
        if (integrationTaskId) return;
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
  }, [location.pathname, selectedCreateCategory, integrationTaskId, sku.config]);
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

  const requestedReturn = location.state?.productReturnTo;
  const registerReturn = typeof requestedReturn === 'string' && /^\/products(?:\?[^#]*)?$/.test(requestedReturn)
    ? requestedReturn : '/products';
  const openedProduct = isOpenRoute && !sku.isDecodeLoading ? sku.decodeData : null;
  const openedArticle = openedProduct?.existsInDb ? openedProduct.publicSku : null;
  const productState = ({ active: 'Активний', archived: 'Архівний', corrected: 'Переоблікований', voided: 'Анульований' })[openedProduct?.product?.status];
  const pageTitle = isCreateRoute ? 'Створення товару' : !isOpenRoute ? 'Товари'
    : !openedProduct ? 'Відкриття товару' : openedProduct.existsInDb
      ? `Товар ${openedArticle || 'без доступного артикулу'}` : 'Перевірка коду';

  if (canViewConfig && !sku.config) {
    return (
      <div className="app-page p-6">{sku.configError ? <Notice tone="error"><p>{sku.configError}</p><button className="btn btn-outline" onClick={sku.retryConfig}>Спробувати ще раз</button></Notice>
        : <LoadingState label="Завантажуємо робочий простір…" />}</div>
    );
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-4 sm:px-6 sm:py-6">
        <PageHeader title={pageTitle}
          description={isCreateRoute ? 'Заповніть характеристики, перевірте розрахунок і збережіть товар.'
            : isOpenRoute ? openedProduct?.existsInDb ? openedProduct.category?.name
              : openedProduct ? 'Код розшифровано. Збережений товар не знайдено.' : 'Читаємо актуальні дані товару.' : undefined}
          breadcrumbs={isLandingRoute ? undefined : [{ label: 'Товари', to: registerReturn }, { label: isCreateRoute ? 'Створення' : 'Картка товару' }]}
          status={productState && <StatusBadge tone={openedProduct.product.status === 'active' ? 'success' : 'neutral'}>{productState}</StatusBadge>}
          actions={isOpenRoute ? <>
            {openedArticle && <CopyAction value={openedArticle} label="Скопіювати артикул товару" buttonLabel="Копіювати артикул" compact />}
            {attentionReturn ? <Link className="btn btn-outline" to={attentionReturn}>Повернутися до проблеми</Link>
              : <Link className="btn btn-outline" to={registerReturn} state={location.state?.productReturnState}>Повернутися до реєстру</Link>}
          </> : isLandingRoute ? <div className="flex flex-wrap gap-2">
            {canRestoreProducts && <button type="button" className="btn btn-outline" onClick={() => dirtyNavigation.request(() => setRestoreOpen(true))}>Відновити за артикулами</button>}
            {canHistoricalReactivate && <button type="button" className="btn btn-outline" onClick={() => dirtyNavigation.request(() => setHistoricalOpen(true))}>Нове історичне рішення Адміністратора</button>}
          </div> : undefined} />
        {requestedRepair && !permissionUi.canApplyDirectRecount && <Notice tone="info">Для виправлення характеристик потрібен дозвіл на переоблік товару. Передайте артикул оператору з цим дозволом.</Notice>}
        <Toast message={sku.copyMessage} />
        {sku.savedProduct && !deletionReceipt && (
          <OperationReceipt title={isTestProduct(sku.savedProduct) ? 'TEST товар збережено' : 'Товар збережено'} identity={savedArticle}
            actions={savedArticle && <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-amber"
                  onClick={() => sku.handleCopyText(savedArticle, 'Артикул')}>Копіювати артикул</button>
                <Link className="btn btn-outline" to={`/products/open?article=${encodeURIComponent(savedArticle)}`}>Відкрити товар</Link>
              </div>}>
            {!savedArticle && <p>Артикул недоступний у відповіді сервера.</p>}
            <TestProductNotice product={sku.savedProduct} />
            <CreationDeliveryNotice readiness={sku.savedProduct.creationDeliveryReadiness}
              categoryCode={sku.savedProduct.creationDeliveryReadiness?.categoryCode} permissions={auth.permissions} saved />
          </OperationReceipt>
        )}
        {archiveReceipt && <OperationReceipt title="Товар архівовано в Amber" identity={archiveReceipt.article}
          description={archiveReceipt.message} actions={<button type="button" className="btn btn-ghost" onClick={() => setArchiveReceipt(null)}>Закрити</button>}>
          {lifecycleAvailable && archiveReceipt.productId && <ProductLifecycleStatus productId={archiveReceipt.productId} />}
        </OperationReceipt>}
        {deletionReceipt && <OperationReceipt title="Видалення тестового товару підтверджено"
          identity={deletionReceipt.publicSku} description="Видалення з Magento перевірено. В Amber збережено технічний запис; артикул залишається зарезервованим."
          actions={<button type="button" className="btn btn-ghost" onClick={() => setDeletionReceipt(null)}>Закрити</button>}
          details={<div className="break-all font-mono text-xs"><p>Внутрішній SKU: {deletionReceipt.internalSku || 'недоступний'}</p><p>Стан операції: {deletionReceipt.state}</p></div>} />}
        {exportSku && canDecodeProducts && <section className="card p-4 space-y-2">
          <p>Відкрито з перевірки експорту · <strong>{exportSku}</strong></p>
          {exportHandoff?.sku === exportSku && <p>{exportHandoff.reason}</p>}
          <Link className="btn btn-primary px-3" to={exportHandoff?.sku === exportSku ? exportHandoff.returnTo : '/exports'}>Повернутися до перевірки</Link>
          {(sku.decodeData?.publicSku || sku.decodeData?.sku) !== exportSku && <>
          <button className="btn btn-outline px-3" disabled={Boolean(sku.selectedCat || sku.hasRecountChanges || sku.isRecountApplying || sku.isPriceChangeOpen)}
            onClick={() => sku.handleDecode(exportSku)}>Відкрити товар із експорту</button>
          {(sku.selectedCat || sku.hasRecountChanges || sku.isPriceChangeOpen) && <p>Спочатку завершіть або скасуйте поточні зміни товару.</p>}</>}
          <p className="text-sm">{sku.hasRecountChanges ? 'Є незбережені зміни товару.' : exportHandoff?.sku === exportSku && exportHandoff.saved ? 'Зміни товару збережено. У перевірці експорту буде показано актуальні дані сервера.' : 'Перегляд товару. Зміни не внесено.'}</p>
        </section>}

        {!sku.selectedCat && sku.isDecodeLoading && <LoadingState label="Відкриваємо товар…" />}

        {!sku.selectedCat && !sku.isDecodeLoading && (
          <HomeDashboard
            productPhotos={photosAvailable && canViewConfig && sku.decodeData?.existsInDb ? productPhotos : null}
            photoCanEdit={photoCanEdit}
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
            canChangeProductPrice={permissionUi.canApplyDirectPriceChange}
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
            onArchive={() => dirtyNavigation.request(() => setArchiveTarget({
              article: sku.decodeData?.publicSku,
              productId: sku.decodeData?.product?.id,
              internalSku: sku.decodeData?.publicSku || sku.decodeData?.internalSku || sku.decodeData?.sku,
            }))}
            onDeleteTest={() => setTestDeletion({ ...sku.decodeData.product,
              public_sku: sku.decodeData.publicSku, full_sku: sku.decodeData.sku })}
          />
        )}

        {lifecycleAvailable && canViewConfig && openedProduct?.existsInDb && openedProduct.product?.status === 'archived' && <ProductLifecycleStatus productId={openedProduct.product.id} />}

          {canCreateProducts && integrationTaskId && <CreationIntegrationResume taskId={integrationTaskId}
            config={sku.config} canCreate={canCreateProducts} busy={sku.isSaving || sku.isPreviewing || sku.isCreationSaveUncertain || sku.creationPhotos?.hasPendingUploads}
            dirty={isBuilderDirty} onResume={sku.resumeIntegrationTask} />}
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
            isTestProduct={sku.isTestProduct}
            canCreateTestProducts={sku.testProductCreationAvailable}
            onTestProductChange={sku.handleTestProductChange}
            creationIntegrationPermissions={auth.permissions}
            onRequestIntegration={sku.onRequestIntegration}
            creatingRequest={sku.creatingRequest}
            requestReceipt={sku.requestReceipt}
            integrationTaskError={sku.integrationTaskError}
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
            creationFieldErrors={sku.creationFieldErrors}
            isNativeCreation={sku.isNativeCreation}
            isCreationSaveUncertain={sku.isCreationSaveUncertain}
            creationPricingMode={sku.creationPricingMode}
            creationUsdPerGram={sku.creationUsdPerGram}
            creationMarketingRounding={sku.creationMarketingRounding}
            creationPricingAvailable={sku.creationPricingAvailable}
            creationPhotosAvailable={sku.creationPhotosAvailable}
            creationPhotos={sku.creationPhotos}
            onCreationPricingMode={sku.handleCreationPricingMode}
            onCreationUsdPerGram={sku.handleCreationUsdPerGram}
            onCreationMarketingRounding={sku.handleCreationMarketingRounding}
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
          <ProductRegister canDecode={canDecodeProducts} refreshKey={registerRefresh}
            onDeleteArchivedTest={canDeleteTestProduct ? (product) => setTestDeletion({ ...product, public_sku: product.publicSku, full_sku: product.internalSku }) : undefined} />
        )}
      </div>
      <HistoricalReactivationReview key={(auth.principalLifetime?.id || auth.applicationUser?.id || 'anonymous') + ':' + historicalSession}
        open={historicalOpen} config={sku.config} onDirtyChange={setHistoricalDirty} onBusyChange={setHistoricalBusy}
        onClose={() => dirtyNavigation.request(() => setHistoricalOpen(false))}
        onReceipt={() => setRegisterRefresh((value) => value + 1)} />
      {restoreOpen && canRestoreProducts && <ProductRestoreBatch onDirtyChange={setRestoreDirty} onBusyChange={setRestoreBusy}
        onClose={() => dirtyNavigation.request(() => setRestoreOpen(false))}
        onRestored={() => setRegisterRefresh((value) => value + 1)} />}
      {archiveTarget && <ProductArchiveDialog article={archiveTarget.article} internalSku={archiveTarget.internalSku} lifecycleAvailable={lifecycleAvailable}
        onBusyChange={setArchiveBusy} onClose={() => setArchiveTarget(null)}
        onArchived={({ message }) => {
          setArchiveReceipt({ article: archiveTarget.article, productId: archiveTarget.productId, message });
          setArchiveTarget(null);
          setRegisterRefresh((value) => value + 1);
          sku.handleDecodeInputChange('');
          dirtyNavigation.commit(() => navigate('/products'));
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
        canCreateRequest={false}
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
