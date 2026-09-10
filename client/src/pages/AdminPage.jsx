import { AdminHeader } from '../components/admin/AdminHeader';
import { AdminPricingEditor } from '../components/admin/AdminPricingEditor';
import { AdminStructureEditor } from '../components/admin/AdminStructureEditor';
import { ValidationIssues } from '../components/admin/ValidationIssues';
import { LoadingState } from '../components/app/UiPrimitives.jsx';
import { useAdminPanel } from '../hooks/useAdminPanel';

export default function AdminPage() {
  const admin = useAdminPanel();

  if (!admin.config) {
    return (
      <div className="app-page"><LoadingState label="Збираємо конфігурацію та цінові сценарії…" /></div>
    );
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-4 pb-20 sm:px-6 sm:py-6">
        <AdminHeader />
        {admin.canViewCatalog && <ValidationIssues issues={admin.validationIssues} />}
        <nav className="admin-section-nav" aria-label="Розділи налаштувань">
          {admin.canViewCatalog && <a href="#catalog-structure">Структура каталогу</a>}
          {admin.canViewPricing && <a href="#catalog-pricing">Матриці та модифікатори</a>}
        </nav>
        {!admin.canViewCatalog && admin.canViewPricing && (
          <section className="catalog-category-context" aria-label="Категорія для перегляду цін">
            <div className="catalog-category-heading">
              <div><h2>Категорія</h2><p>Оберіть матриці та модифікатори для перегляду</p></div>
            </div>
            <div className="catalog-category-tabs" role="tablist" aria-label="Категорії цін">
              {Object.values(admin.config.categories).map((category) => (
                <button
                  key={category.code}
                  type="button"
                  role="tab"
                  aria-selected={admin.selectedCat?.code === category.code}
                  onClick={() => admin.handleSelectCategory(category)}
                  className={`catalog-category-tab ${admin.selectedCat?.code === category.code ? 'is-active' : ''}`}
                >
                  <span>{category.name}</span><small>{category.code}</small>
                </button>
              ))}
            </div>
          </section>
        )}
        {admin.canViewCatalog && <section id="catalog-structure" className="admin-anchor-section">
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
        </section>}
        {admin.canViewPricing && <section id="catalog-pricing" className="admin-anchor-section">
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
            readOnly={!admin.canManagePricing}
          />
        </section>}
      </div>
    </div>
  );
}
