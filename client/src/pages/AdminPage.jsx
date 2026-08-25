import { AdminHeader } from '../components/admin/AdminHeader';
import { AdminPricingEditor } from '../components/admin/AdminPricingEditor';
import { AdminStructureEditor } from '../components/admin/AdminStructureEditor';
import { ValidationIssues } from '../components/admin/ValidationIssues';
import { useAdminPanel } from '../hooks/useAdminPanel';

export default function AdminPage() {
  const admin = useAdminPanel();

  if (!admin.config) {
    return (
      <div className="min-h-screen app-bg flex items-center justify-center">
        <div className="card p-8 text-center">
          <div className="text-lg font-semibold text-slate-700">Завантаження...</div>
          <div className="mt-2 text-sm text-slate-500">Збираємо конфігурацію та цінові сценарії.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen app-bg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-28 space-y-8">
        <AdminHeader />
        <ValidationIssues issues={admin.validationIssues} />
        <AdminStructureEditor
          config={admin.config}
          selectedCat={admin.selectedCat}
          selectedQuestion={admin.selectedQuestion}
          currentCatQuestions={admin.currentCatQuestions}
          currentOptions={admin.currentOptions}
          selectedQuestionInputType={admin.selectedQuestionInputType}
          schemaStatus={admin.schemaStatus}
          schemaPublishState={admin.schemaPublishState}
          editCat={admin.editCat}
          setEditCat={admin.setEditCat}
          editQuestion={admin.editQuestion}
          setEditQuestion={admin.setEditQuestion}
          newCat={admin.newCat}
          setNewCat={admin.setNewCat}
          newQuest={admin.newQuest}
          setNewQuest={admin.setNewQuest}
          newOpt={admin.newOpt}
          setNewOpt={admin.setNewOpt}
          editOpt={admin.editOpt}
          setEditOpt={admin.setEditOpt}
          onSelectCategory={admin.handleSelectCategory}
          onSelectQuestion={admin.handleSelectQuestion}
          addCategory={admin.addCategory}
          updateCategory={admin.updateCategory}
          addQuestion={admin.addQuestion}
          updateQuestion={admin.updateQuestion}
          reorderQuestions={admin.reorderQuestions}
          autoAssignSkuIndexes={admin.autoAssignSkuIndexes}
          fillNextNewQuestionSkuIndex={admin.fillNextNewQuestionSkuIndex}
          addOption={admin.addOption}
          archiveOption={admin.archiveOption}
          beginOptionEdit={admin.beginOptionEdit}
          updateOption={admin.updateOption}
          publishSkuSchema={admin.publishSkuSchema}
          deleteItem={admin.deleteItem}
          formatMatchJson={admin.formatMatchJson}
        />
        <AdminPricingEditor
          config={admin.config}
          selectedCat={admin.selectedCat}
          pricesData={admin.pricesData}
          currentCatQuestions={admin.currentCatQuestions}
          editScenario={admin.editScenario}
          setEditScenario={admin.setEditScenario}
          newScenario={admin.newScenario}
          setNewScenario={admin.setNewScenario}
          newModifier={admin.newModifier}
          setNewModifier={admin.setNewModifier}
          editModifier={admin.editModifier}
          setEditModifier={admin.setEditModifier}
          beginScenarioEdit={admin.beginScenarioEdit}
          beginModifierEdit={admin.beginModifierEdit}
          updateScenario={admin.updateScenario}
          duplicateScenario={admin.duplicateScenario}
          deleteItem={admin.deleteItem}
          formatMatchJson={admin.formatMatchJson}
          handlePriceChange={admin.handlePriceChange}
          addScenario={admin.addScenario}
          updateModifier={admin.updateModifier}
          saveModifierEdit={admin.saveModifierEdit}
          addModifier={admin.addModifier}
        />
      </div>
    </div>
  );
}
