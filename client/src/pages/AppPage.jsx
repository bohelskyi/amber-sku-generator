import { ExportTools } from '../components/app/ExportTools';
import { HistoryTable } from '../components/app/HistoryTable';
import { HomeDashboard } from '../components/app/HomeDashboard';
import { PageHeader, Toast } from '../components/app/PageHeader';
import { PreviewResult } from '../components/app/PreviewResult';
import { ProductBuilder } from '../components/app/ProductBuilder';
import { RecountConfirmDialog } from '../components/app/RecountConfirmDialog';
import { useSkuManager } from '../hooks/useSkuManager';

function AppPage() {
  const sku = useSkuManager();

  if (!sku.config) {
    return (
      <div className="min-h-screen app-bg flex items-center justify-center">
        <div className="card p-8 text-center">
          <div className="text-lg font-semibold text-slate-700">Завантаження...</div>
          <div className="mt-2 text-sm text-slate-500">Підтягуємо конфігурацію та історію.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen app-bg">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <PageHeader config={sku.config} selectedCat={sku.selectedCat} historyCount={sku.history.length} />
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
            recountAnswers={sku.recountAnswers}
            recountError={sku.recountError}
            recountPreview={sku.recountPreview}
            recountReason={sku.recountReason}
            recountSuccess={sku.recountSuccess}
            onApplyRecount={sku.handleApplyRecount}
            onCancelRecount={sku.handleCancelRecount}
            onRecountAnswer={sku.handleRecountAnswer}
            onRecountPreview={sku.handleRecountPreview}
            onRecountReasonChange={sku.setRecountReason}
            onRecountTextAnswer={sku.handleRecountTextAnswer}
            onStart={sku.resetProductFlow}
            onStartRecount={sku.handleStartRecount}
            onDecode={sku.handleDecode}
            onDecodeInputChange={sku.handleDecodeInputChange}
          />
        )}

        {sku.selectedCat && !sku.previewData && (
          <ProductBuilder
            config={sku.config}
            selectedCat={sku.selectedCat}
            answers={sku.answers}
            weight={sku.weight}
            setWeight={sku.setWeight}
            isWeightRequired={sku.isWeightRequired}
            answeredRequiredCount={sku.answeredRequiredCount}
            requiredCount={sku.requiredCount}
            progressPercent={sku.progressPercent}
            livePriceData={sku.livePriceData}
            livePriceError={sku.livePriceError}
            isLivePriceLoading={sku.isLivePriceLoading}
            getVisibleOptionsForQuestion={sku.getVisibleOptions}
            isQuestionVisible={sku.getQuestionVisibility}
            isTextQuestion={sku.isTextQuestion}
            onAnswer={sku.handleAnswer}
            onTextAnswer={sku.handleTextAnswer}
            onPreview={sku.handlePreview}
            onCancel={() => sku.setSelectedCat(null)}
          />
        )}

        {sku.previewData && (
          <PreviewResult
            previewData={sku.previewData}
            finalSku={sku.finalSku}
            effectivePricePerGram={sku.effectivePricePerGram}
            effectivePricePerGramUah={sku.effectivePricePerGramUah}
            effectiveTotalPrice={sku.effectiveTotalPrice}
            effectiveTotalPriceUah={sku.effectiveTotalPriceUah}
            hasManualPrice={sku.hasManualPrice}
            isWeightRequired={sku.isWeightRequired}
            isVariationActive={sku.isVariationActive}
            variationData={sku.variationData}
            variationError={sku.variationError}
            isVariationLoading={sku.isVariationLoading}
            isManualPriceEditing={sku.isManualPriceEditing}
            isSaving={sku.isSaving}
            manualPriceUah={sku.manualPriceUah}
            onCopyText={sku.handleCopyText}
            onBackToParameters={sku.handleBackToParameters}
            onAddVariation={sku.handleAddVariation}
            onManualPriceChange={sku.handleManualPriceChange}
            onResetManualPrice={sku.handleResetManualPrice}
            onSave={sku.handleSave}
            onStartManualPriceEdit={sku.handleStartManualPriceEdit}
            onStopManualPriceEdit={sku.handleStopManualPriceEdit}
            saveError={sku.saveError}
          />
        )}

        <HistoryTable
          history={sku.history}
          config={sku.config}
          selectedCat={sku.selectedCat}
          onCopyText={sku.handleCopyText}
          onDecode={sku.handleDecode}
          onDelete={sku.handleDelete}
        />

        {!sku.selectedCat && (
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
          />
        )}
      </div>
      <RecountConfirmDialog
        isApplying={sku.isRecountApplying}
        isOpen={sku.isRecountConfirmOpen}
        preview={sku.recountPreview}
        reason={sku.recountReason}
        onCancel={sku.handleCancelRecountConfirmation}
        onConfirm={sku.handleConfirmRecount}
      />
    </div>
  );
}

export default AppPage;
