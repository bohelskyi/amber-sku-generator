import { ExportTools } from '../components/app/ExportTools';
import { HistoryTable } from '../components/app/HistoryTable';
import { HomeDashboard } from '../components/app/HomeDashboard';
import { PageHeader, Toast } from '../components/app/PageHeader';
import { ProductBuilder } from '../components/app/ProductBuilder';
import { RecountConfirmDialog } from '../components/app/RecountConfirmDialog';
import { LoadingState } from '../components/app/UiPrimitives.jsx';
import { useAuth } from '../auth/auth-context.js';
import { useSkuManager } from '../hooks/useSkuManager';
import { getPermissionUiState, getRecountUiMode } from '../lib/permission-ui.js';

function AppPage() {
  const auth = useAuth();
  const sku = useSkuManager();
  const permissionUi = getPermissionUiState(auth.permissions);
  const recountMode = getRecountUiMode(permissionUi);
  const {
    canArchiveProducts,
    canCreateExports,
    canCreateProducts,
  } = permissionUi;

  if (!sku.config) {
    return (
      <div className="app-page"><LoadingState label="Підтягуємо конфігурацію та історію…" /></div>
    );
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-4 sm:px-6 sm:py-6">
        <PageHeader />
        <Toast message={sku.copyMessage} />

        {!sku.selectedCat && (
          <HomeDashboard
            config={sku.config}
            exportStatus={sku.exportStatus}
            skuToDecode={sku.skuToDecode}
            decodeData={sku.decodeData}
            decodeError={sku.decodeError}
            decodeErrorDetails={sku.decodeErrorDetails}
            hasRecountChanges={sku.hasRecountChanges}
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
            canStartRecount={Boolean(recountMode)}
            recountMode={recountMode || 'apply'}
            onApplyRecount={sku.handleApplyRecount}
            onCancelRecount={sku.handleCancelRecount}
            onRecountAnswer={sku.handleRecountAnswer}
            onRecountReasonChange={sku.setRecountReason}
            onRecountTextAnswer={sku.handleRecountTextAnswer}
            onRecountWeightChange={sku.handleRecountWeightChange}
            onStart={sku.resetProductFlow}
            onStartRecount={sku.handleStartRecount}
            onDecode={sku.handleDecode}
            onDecodeInputChange={sku.handleDecodeInputChange}
          />
        )}

        {canCreateProducts && sku.selectedCat && (
          <ProductBuilder
            config={sku.config}
            selectedCat={sku.selectedCat}
            answers={sku.answers}
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
            onCancel={() => sku.setSelectedCat(null)}
          />
        )}

        <HistoryTable
          history={sku.history}
          config={sku.config}
          selectedCat={sku.selectedCat}
          onCopyText={sku.handleCopyText}
          onDecode={sku.handleDecode}
          onDelete={sku.handleDelete}
          canArchive={canArchiveProducts}
        />

        {!sku.selectedCat && (canCreateExports || canArchiveProducts) && (
          <ExportTools
            exportFromSku={sku.exportFromSku}
            setExportFromSku={sku.setExportFromSku}
            exportToSku={sku.exportToSku}
            setExportToSku={sku.setExportToSku}
            exportError={sku.exportError}
            setExportError={sku.setExportError}
            isExportLoading={sku.isExportLoading}
            skuToDelete={sku.skuToDelete}
            setSkuToDelete={sku.setSkuToDelete}
            onExportCsv={sku.handleExportCsv}
            onDelete={sku.handleDelete}
            canArchive={canArchiveProducts}
            canCreateExport={canCreateExports}
          />
        )}
      </div>
      <RecountConfirmDialog
        error={sku.recountError}
        isApplying={sku.isRecountApplying}
        isOpen={sku.isRecountConfirmOpen}
        preview={sku.recountPreview}
        reason={sku.recountReason}
        manualPriceUah={sku.recountManualPriceUah}
        onManualPriceChange={sku.setRecountManualPriceUah}
        mode={recountMode || 'apply'}
        submittingMode={sku.recountSubmitMode}
        onCancel={sku.handleCancelRecountConfirmation}
        onConfirm={sku.handleConfirmRecount}
      />
    </div>
  );
}

export default AppPage;
