import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AdminHeader } from '../components/admin/AdminHeader';
import { AdminPricingEditor } from '../components/admin/AdminPricingEditor';
import { AdminStructureEditor } from '../components/admin/AdminStructureEditor';
import { ValidationIssues } from '../components/admin/ValidationIssues';
import { Button, ConfirmDialog, LoadingState, LocalNavigation, Notice } from '../components/ui/index.js';
import { resolveCatalogEntry } from '../lib/catalog-entry.js';
import { isNativeCatalog } from '../lib/catalog-workflow.js';
import { useAdminPanel } from '../hooks/useAdminPanel';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation.jsx';
import '../components/admin/admin.css';

function CategoryPicker({ categories, selectedCode, onSelect }) {
  return <section className="catalog-category-context admin-category-picker" aria-label="Категорія для цін">
    <div className="catalog-category-heading">
      <div><h2>Категорія</h2><p>Оберіть категорію, щоб відкрити її сценарії та модифікатори.</p></div>
    </div>
    <div className="catalog-category-tabs" role="group" aria-label="Категорії цін">
      {Object.values(categories).map((category) => <button key={category.code} type="button"
        aria-pressed={selectedCode === category.code} onClick={() => onSelect(category)}
        className={`catalog-category-tab ${selectedCode === category.code ? 'is-active' : ''}`}>
        <span>{category.name}</span><small>{category.code}</small>
      </button>)}
    </div>
  </section>;
}

export default function AdminPage({ mode = 'auto' }) {
  const admin = useAdminPanel({ mode });
  const location = useLocation();
  const entryHandled = useRef(null);
  const navigate = useNavigate();
  const entry = resolveCatalogEntry(admin.config, location.search, location.key);
  const { requestedCategory, returnTo } = entry;
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const dirtyNavigation = useDirtyNavigation({
    dirty: workspaceDirty,
    discard: () => {
      admin.discardLocalChanges();
      setWorkspaceDirty(false);
      setEditorKey((current) => current + 1);
    },
  });
  const isCatalog = admin.effectiveMode === 'catalog';
  const hasAccess = isCatalog ? admin.canViewCatalog : admin.canViewPricing;
  const localNavItems = [
    admin.canViewCatalog && { to: '/admin/catalog', label: 'Каталог' },
    admin.canViewPricing && { to: '/admin/pricing', label: 'Ціноутворення' },
  ].filter(Boolean);

  // A navigation handoff selects context only. No catalog command runs on entry.
  const enterCatalogContext = useEffectEvent(() => {
    if (!admin.config || entryHandled.current === location.key) return;
    entryHandled.current = location.key;
    const { category, question, option } = entry;
    if (!category) return;
    admin.handleSelectCategory(category);
    if (isCatalog && question) {
      admin.handleSelectQuestion(question);
      if (entry.action?.action === 'edit-option' && option && admin.canManageCatalog) admin.beginOptionEdit(option);
    }
  });
  useEffect(() => { enterCatalogContext(); }, [isCatalog, admin.config, location.key]);
  const entryAction = isCatalog ? entry.action : null;
  const completeCatalogAction = (command) => async (...args) => {
    const saved = await command(...args);
    if (saved === true && returnTo) {
      setWorkspaceDirty(false);
      dirtyNavigation.commit(() => navigate(returnTo));
    }
    return saved;
  };

  useEffect(() => {
    if (!workspaceDirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [workspaceDirty]);

  const selectCategory = (category) => dirtyNavigation.request(() => admin.handleSelectCategory(category));
  const selectQuestion = (question) => dirtyNavigation.request(() => admin.handleSelectQuestion(question));

  if (!hasAccess) {
    return <main className="app-page admin-page"><div className="admin-page-inner">
      <Notice tone="warning" title="Немає доступу до розділу">
        Цей робочий простір недоступний за вашими чинними дозволами.
      </Notice>
    </div></main>;
  }

  if (!admin.config) {
    return <main className="app-page admin-page"><div className="admin-page-inner">
      {admin.configError
        ? <Notice tone="error" title="Не вдалося завантажити налаштування" actions={<Button onClick={admin.retryConfig}>Спробувати ще раз</Button>}>{admin.configError}</Notice>
        : <LoadingState label={isCatalog ? 'Завантажуємо каталог…' : 'Завантажуємо налаштування цін…'} />}
    </div></main>;
  }

  return <main className="app-page admin-page">
    <div className="admin-page-inner">
      <AdminHeader mode={admin.effectiveMode} nativeCatalog={isNativeCatalog(admin.config)} />
      {returnTo && <Link className="et-link" to={returnTo}>← {returnTo.startsWith('/attention') ? 'Повернутися до задач' : 'Повернутися до інтеграції Magento'}</Link>}
      {requestedCategory && !admin.config.categories?.[requestedCategory] && <Notice tone="warning" title="Категорію не знайдено">
        Оберіть наявну категорію або створіть нову, якщо маєте відповідний дозвіл.
      </Notice>}
      {isCatalog && entry.invalidTarget && <Notice tone="warning" title="Елемент каталогу не знайдено">
        Оберіть наявне питання або точний варіант. Жодної зміни не виконано.
      </Notice>}
      {localNavItems.length > 1 && <LocalNavigation label="Розділи конфігурації" items={localNavItems} />}

      {admin.feedback && <Notice tone={admin.feedback.tone} title={admin.feedback.title}
        actions={<Button variant="ghost" size="compact" onClick={admin.clearFeedback}>Закрити</Button>}>
        {admin.feedback.message}
      </Notice>}

      {isCatalog && <>
        <ValidationIssues issues={admin.validationIssues} />
        <AdminStructureEditor
          key={`catalog-${location.key}-${editorKey}`}
          canManage={admin.canManageCatalog}
          canPublish={admin.canPublishSchema}
          canPrepareMagento={admin.canPrepareMagento}
          entryAction={entryAction}
          config={admin.config}
          selectedCat={admin.selectedCat}
          selectedQuestion={admin.selectedQuestion}
          currentCatQuestions={admin.currentCatQuestions}
          currentOptions={admin.currentOptions}
          selectedQuestionInputType={admin.selectedQuestionInputType}
          schemaStatus={admin.schemaStatus}
          schemaStatusError={admin.schemaStatusError}
          retrySchemaStatus={admin.retrySchemaStatus}
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
          onSelectCategory={selectCategory}
          onSelectQuestion={selectQuestion}
          onDirtyChange={setWorkspaceDirty}
          addCategory={completeCatalogAction(admin.addCategory)}
          updateCategory={completeCatalogAction(admin.updateCategory)}
          addQuestion={completeCatalogAction(admin.addQuestion)}
          updateQuestion={completeCatalogAction(admin.updateQuestion)}
          reorderQuestions={admin.reorderQuestions}
          autoAssignSkuIndexes={admin.autoAssignSkuIndexes}
          fillNextNewQuestionSkuIndex={admin.fillNextNewQuestionSkuIndex}
          addOption={completeCatalogAction(admin.addOption)}
          archiveOption={completeCatalogAction(admin.archiveOption)}
          archiveQuestion={completeCatalogAction(admin.archiveQuestion)}
          beginOptionEdit={admin.beginOptionEdit}
          updateOption={completeCatalogAction(admin.updateOption)}
          publishSkuSchema={admin.publishSkuSchema}
          deleteItem={admin.deleteItem}
          formatMatchJson={admin.formatMatchJson}
        />
      </>}

      {!isCatalog && <>
        <CategoryPicker categories={admin.config.categories} selectedCode={admin.selectedCat?.code} onSelect={selectCategory} />
        {admin.selectedCat && admin.pricesError && !admin.pricesData && <Notice tone="error" title={`Не вдалося завантажити ціни для «${admin.selectedCat.name}»`}
          actions={<Button onClick={admin.retryPrices}>Спробувати ще раз</Button>}>
          {admin.pricesError}
        </Notice>}
        {admin.selectedCat && !admin.pricesData && !admin.pricesError && <LoadingState label={`Завантажуємо ціни для «${admin.selectedCat.name}»…`} compact />}
        <AdminPricingEditor
          key={`pricing-${editorKey}`}
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
          handlePriceChange={admin.handlePriceChange}
          matrixCellSaveStates={admin.matrixCellSaveStates}
          addScenario={admin.addScenario}
          saveModifierEdit={admin.saveModifierEdit}
          addModifier={admin.addModifier}
          readOnly={!admin.canManagePricing}
          onDirtyChange={setWorkspaceDirty}
          requestTransition={dirtyNavigation.request}
        />
      </>}
    </div>

    {dirtyNavigation.prompt}

    <ConfirmDialog open={Boolean(admin.deleteConfirmation)} title={`Видалити «${admin.deleteConfirmation?.label || 'елемент'}»?`}
      description={admin.deleteConfirmation?.description} confirmLabel="Видалити" tone="danger"
      busy={admin.deleteBusy} onConfirm={admin.confirmDelete} onClose={admin.cancelDelete}>
      <p>{admin.deleteConfirmation?.consequence}</p>
      {admin.deleteError && <Notice tone="error" title="Не вдалося видалити">{admin.deleteError}</Notice>}
    </ConfirmDialog>
  </main>;
}
