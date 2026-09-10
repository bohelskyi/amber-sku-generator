import { useState } from 'react';
import { Archive, ChevronDown, GripVertical, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { SkuTemplatePreview } from './SkuTemplatePreview';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { FormSection } from '../shared/FormSection';
import { CategoryForm, MetaRow, OptionForm, OptionRow, QuestionForm } from './AdminCatalogForms';

const EMPTY_EDIT_OPTION = { id: null, value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
const isEnabled = (value) => value === 1 || value === true;
export function AdminStructureEditor({
  config, selectedCat, selectedQuestion, currentCatQuestions, currentOptions,
  selectedQuestionInputType, schemaStatus, schemaPublishState, editCat, setEditCat,
  editQuestion, setEditQuestion, newCat, setNewCat, newQuest, setNewQuest, newOpt,
  setNewOpt, editOpt, setEditOpt, onSelectCategory, onSelectQuestion, addCategory,
  updateCategory, addQuestion, updateQuestion, reorderQuestions, autoAssignSkuIndexes,
  fillNextNewQuestionSkuIndex, addOption, archiveOption, beginOptionEdit, updateOption,
  publishSkuSchema, deleteItem,
}) {
  const [isCategoryEditOpen, setIsCategoryEditOpen] = useState(false);
  const [isNewCategoryOpen, setIsNewCategoryOpen] = useState(false);
  const [isQuestionEditOpen, setIsQuestionEditOpen] = useState(false);
  const [isNewQuestionOpen, setIsNewQuestionOpen] = useState(false);
  const [isNewOptionOpen, setIsNewOptionOpen] = useState(false);
  const [isArchivedOptionsOpen, setIsArchivedOptionsOpen] = useState(false);
  const [draggedQuestionId, setDraggedQuestionId] = useState(null);
  const [questionDropTarget, setQuestionDropTarget] = useState({ id: null, position: null });
  const activeOptions = currentOptions.filter((option) => !isEnabled(option.archived));
  const archivedOptions = currentOptions.filter((option) => isEnabled(option.archived));
  const questionVisibilitySummary = selectedQuestion ? formatConditionSummary(selectedQuestion.visible_if_json, currentCatQuestions, config) : '';

  const resetOptionEdit = () => setEditOpt(EMPTY_EDIT_OPTION);
  const closeDetailEditors = () => {
    setIsQuestionEditOpen(false);
    setIsNewQuestionOpen(false);
    setIsNewOptionOpen(false);
    resetOptionEdit();
  };
  const selectCategory = (category) => {
    setIsCategoryEditOpen(false);
    setIsNewCategoryOpen(false);
    setIsArchivedOptionsOpen(false);
    closeDetailEditors();
    onSelectCategory(category);
  };
  const selectQuestion = (question) => {
    setIsArchivedOptionsOpen(false);
    closeDetailEditors();
    onSelectQuestion(question);
  };
  const openNewQuestion = () => {
    setIsQuestionEditOpen(false);
    setIsNewOptionOpen(false);
    resetOptionEdit();
    setIsNewQuestionOpen(true);
  };
  const openQuestionEdit = () => {
    setIsNewQuestionOpen(false);
    setIsNewOptionOpen(false);
    resetOptionEdit();
    setIsQuestionEditOpen(true);
  };
  const openNewOption = () => {
    setIsQuestionEditOpen(false);
    resetOptionEdit();
    setIsNewOptionOpen(true);
  };
  const openOptionEdit = (option) => {
    setIsQuestionEditOpen(false);
    setIsNewQuestionOpen(false);
    setIsNewOptionOpen(false);
    beginOptionEdit(option);
  };

  const handleQuestionDragStart = (event, question) => {
    setDraggedQuestionId(question.q_db_id);
    setQuestionDropTarget({ id: null, position: null });
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(question.q_db_id));
  };
  const getDropPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  const handleQuestionDragOver = (event, question) => {
    event.preventDefault();
    const targetQuestionId = Number(question.q_db_id);
    if (Number(draggedQuestionId) === targetQuestionId) {
      setQuestionDropTarget({ id: null, position: null });
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    setQuestionDropTarget({ id: targetQuestionId, position: getDropPosition(event) });
  };
  const handleQuestionDrop = (event, targetQuestion) => {
    event.preventDefault();
    const sourceQuestionId = Number(event.dataTransfer.getData('text/plain') || draggedQuestionId);
    const targetQuestionId = Number(targetQuestion.q_db_id);
    setDraggedQuestionId(null);
    setQuestionDropTarget({ id: null, position: null });
    if (!sourceQuestionId || sourceQuestionId === targetQuestionId) return;
    const sourceIndex = currentCatQuestions.findIndex((question) => Number(question.q_db_id) === sourceQuestionId);
    if (sourceIndex < 0) return;
    const nextQuestions = [...currentCatQuestions];
    const [movedQuestion] = nextQuestions.splice(sourceIndex, 1);
    const targetIndexAfterRemoval = nextQuestions.findIndex((question) => Number(question.q_db_id) === targetQuestionId);
    if (targetIndexAfterRemoval < 0) return;
    const insertionIndex = getDropPosition(event) === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
    nextQuestions.splice(insertionIndex, 0, movedQuestion);
    reorderQuestions(nextQuestions);
  };

  return (
    <div className="space-y-4 fade-up stagger-2">
      <section className="catalog-category-context">
        <div className="catalog-category-heading">
          <div><h2>Структура каталогу</h2><p>Категорії, питання та варіанти</p></div>
          <button type="button" onClick={() => { setIsCategoryEditOpen(false); setIsNewCategoryOpen((isOpen) => !isOpen); }} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Категорія</button>
        </div>
        <div className="catalog-category-tabs" role="tablist" aria-label="Категорії каталогу">
          {Object.values(config.categories).map((category) => (
            <button key={category.code} type="button" role="tab" aria-selected={selectedCat?.code === category.code} onClick={() => selectCategory(category)} className={`catalog-category-tab ${selectedCat?.code === category.code ? 'is-active' : ''}`}>
              <span>{category.name}</span><small>{category.code}</small>
            </button>
          ))}
        </div>
        {selectedCat && (
          <>
            <div className="catalog-category-bar">
              <div className="catalog-category-status">
                <strong>{selectedCat.name}</strong><span className="font-mono">{selectedCat.code}</span>
                {schemaStatus && (
                  <span className={`catalog-schema-state ${schemaStatus.draftChanged ? 'is-draft' : 'is-published'}`}>
                    <i />{schemaStatus.active ? `Схема V${schemaStatus.active.version}` : 'Без активної схеми'}{schemaStatus.draftChanged ? ` · зміни для V${schemaStatus.nextVersion}` : ' · опубліковано'}
                  </span>
                )}
              </div>
              <div className="catalog-category-actions">
                <button type="button" onClick={() => { setIsNewCategoryOpen(false); setIsCategoryEditOpen((isOpen) => !isOpen); }} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Pencil size={14} />Категорія</button>
                <button type="button" onClick={publishSkuSchema} disabled={!schemaStatus?.draftChanged || schemaPublishState.loading} className="btn btn-primary flex items-center gap-1.5 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-45">
                  <Send size={14} />{schemaPublishState.loading ? 'Публікуємо...' : schemaStatus?.nextVersion ? `Опублікувати V${schemaStatus.nextVersion}` : 'Опублікувати'}
                </button>
                <button type="button" onClick={() => deleteItem('category', selectedCat.code)} className="catalog-icon-button is-danger" title="Видалити категорію" aria-label={`Видалити категорію ${selectedCat.name}`}><Trash2 size={15} /></button>
              </div>
            </div>
            {schemaPublishState.error && <p className="catalog-context-error" role="alert">{schemaPublishState.error}</p>}
            <SkuTemplatePreview category={selectedCat} marker={schemaStatus?.draftChanged ? schemaStatus.nextMarker : schemaStatus?.active?.marker} questions={currentCatQuestions} />
          </>
        )}
        {isCategoryEditOpen && selectedCat && <CategoryForm category={editCat} isEdit onCancel={() => setIsCategoryEditOpen(false)} onChange={setEditCat} onSave={updateCategory} />}
        {isNewCategoryOpen && <CategoryForm category={newCat} onCancel={() => setIsNewCategoryOpen(false)} onChange={setNewCat} onSave={addCategory} />}
      </section>

      {selectedCat ? (
        <section className="catalog-workspace">
          <aside className="catalog-master">
            <div className="catalog-pane-header">
              <div><h3>Питання</h3><p>{currentCatQuestions.length} у поточній категорії</p></div>
              <button type="button" onClick={openNewQuestion} className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Додати</button>
            </div>
            <button type="button" onClick={autoAssignSkuIndexes} className="catalog-master-utility">Переіндексувати SKU</button>
            <div className="catalog-question-list">
              {currentCatQuestions.map((question) => {
                const isConditional = formatConditionSummary(question.visible_if_json, currentCatQuestions, config) !== 'Завжди';
                const isSelected = selectedQuestion?.id === question.id && !isNewQuestionOpen;
                return (
                  <div
                    key={question.q_db_id}
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => selectQuestion(question)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectQuestion(question); }}
                    onDragStart={(event) => handleQuestionDragStart(event, question)}
                    onDragOver={(event) => handleQuestionDragOver(event, question)}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setQuestionDropTarget({ id: null, position: null }); }}
                    onDrop={(event) => handleQuestionDrop(event, question)}
                    onDragEnd={() => { setDraggedQuestionId(null); setQuestionDropTarget({ id: null, position: null }); }}
                    className={`catalog-question-row ${isSelected ? 'is-selected' : ''} ${draggedQuestionId === question.q_db_id ? 'is-dragging' : ''}`}
                  >
                    {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'before' && <span className="catalog-drop-line is-before" />}
                    {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'after' && <span className="catalog-drop-line is-after" />}
                    <GripVertical className="catalog-drag-handle" size={16} aria-hidden="true" />
                    <div className="min-w-0">
                      <strong>{question.label}</strong>
                      <div className="catalog-question-flags">
                        <span>{(question.input_type || 'options') === 'text' ? 'Текст' : 'Варіанти'}</span>
                        {isEnabled(question.required) && <span>Обовʼязкове</span>}
                        {isEnabled(question.include_in_sku) && <span>SKU</span>}
                        {isConditional && <span>За умовою</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {currentCatQuestions.length === 0 && <p className="catalog-empty-state">У категорії ще немає питань.</p>}
            </div>
          </aside>

          <div className="catalog-detail">
            {isNewQuestionOpen ? (
              <QuestionForm config={config} currentCatQuestions={currentCatQuestions} fillNextSkuIndex={fillNextNewQuestionSkuIndex} isNew onCancel={() => setIsNewQuestionOpen(false)} onChange={setNewQuest} onSave={addQuestion} question={newQuest} />
            ) : selectedQuestion ? (
              <>
                <div className="catalog-detail-header">
                  <div className="min-w-0"><h3>{selectedQuestion.label}</h3><p>{(selectedQuestion.input_type || 'options') === 'text' ? 'Текстове поле' : 'Поле з варіантами'}</p></div>
                  <div className="catalog-row-actions">
                    {!isQuestionEditOpen && <button type="button" onClick={openQuestionEdit} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Pencil size={14} />Редагувати</button>}
                    <button type="button" onClick={() => deleteItem('question', selectedQuestion.q_db_id)} className="catalog-icon-button is-danger" title="Видалити питання" aria-label={`Видалити питання ${selectedQuestion.label}`}><Trash2 size={15} /></button>
                  </div>
                </div>
                {isQuestionEditOpen ? (
                  <QuestionForm config={config} currentCatQuestions={currentCatQuestions} excludeQuestionId={selectedQuestion.id} onCancel={() => setIsQuestionEditOpen(false)} onChange={setEditQuestion} onSave={updateQuestion} question={editQuestion} />
                ) : (
                  <div className="catalog-question-overview">
                    <FormSection title="Загальні" variant="catalog">
                      <MetaRow label="Тип поля" value={(selectedQuestion.input_type || 'options') === 'text' ? 'Текстове поле' : 'Варіанти'} />
                      <MetaRow label="Обовʼязкове" value={isEnabled(selectedQuestion.required) ? 'Так' : 'Ні'} />
                    </FormSection>
                    <FormSection title="SKU" variant="catalog">
                      <MetaRow label="Включено в SKU" value={isEnabled(selectedQuestion.include_in_sku) ? 'Так' : 'Ні'} />
                    </FormSection>
                    <FormSection title="Видимість та умови" variant="catalog"><MetaRow label="Показувати" value={questionVisibilitySummary} /></FormSection>
                    <details className="catalog-technical-details catalog-technical-overview">
                      <summary>Технічні параметри</summary>
                      <div className="catalog-technical-details-body">
                        <MetaRow label="Ключ" value={selectedQuestion.id} />
                        <MetaRow label="Порядок" value={selectedQuestion.display_order ?? selectedQuestion.sku_index ?? '—'} />
                        {isEnabled(selectedQuestion.include_in_sku) && <MetaRow label="SKU index" value={selectedQuestion.sku_index ?? '—'} />}
                        {isEnabled(selectedQuestion.include_in_sku) && <MetaRow label="Розділювач" value={selectedQuestion.sku_separator || 'Немає'} />}
                      </div>
                    </details>
                  </div>
                )}

                <section className="catalog-variants-section">
                  <div className="catalog-variants-header">
                    <div><h4>Варіанти</h4><p>{activeOptions.length} активних{archivedOptions.length ? ` · ${archivedOptions.length} в архіві` : ''}</p></div>
                    {selectedQuestionInputType !== 'text' && <button type="button" onClick={openNewOption} className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Додати варіант</button>}
                  </div>
                  {editOpt.id && <OptionForm config={config} currentCatQuestions={currentCatQuestions} excludeQuestionId={selectedQuestion.id} onCancel={resetOptionEdit} onChange={setEditOpt} onSave={updateOption} option={editOpt} />}
                  {isNewOptionOpen && selectedQuestionInputType !== 'text' && <OptionForm config={config} currentCatQuestions={currentCatQuestions} excludeQuestionId={selectedQuestion.id} isNew onCancel={() => setIsNewOptionOpen(false)} onChange={setNewOpt} onSave={addOption} option={newOpt} />}
                  {selectedQuestionInputType === 'text' ? <p className="catalog-empty-state">Для текстового питання варіанти не використовуються.</p> : (
                    <div className="catalog-option-list">
                      {activeOptions.map((option) => <OptionRow key={option.db_id} option={option} config={config} currentCatQuestions={currentCatQuestions} onArchive={archiveOption} onDelete={deleteItem} onEdit={openOptionEdit} />)}
                      {activeOptions.length === 0 && <p className="catalog-empty-state">Активних варіантів немає.</p>}
                    </div>
                  )}
                  {archivedOptions.length > 0 && (
                    <div className="catalog-archived-section">
                      <button type="button" onClick={() => setIsArchivedOptionsOpen((isOpen) => !isOpen)}><span><Archive size={14} />Архівні варіанти ({archivedOptions.length})</span><ChevronDown size={16} className={isArchivedOptionsOpen ? 'rotate-180' : ''} /></button>
                      {isArchivedOptionsOpen && <div className="catalog-option-list">{archivedOptions.map((option) => <OptionRow key={option.db_id} archived option={option} config={config} currentCatQuestions={currentCatQuestions} onArchive={archiveOption} onDelete={deleteItem} onEdit={openOptionEdit} />)}</div>}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <div className="catalog-detail-empty"><h3>Виберіть питання</h3><p>Налаштування та варіанти відкриються у цій панелі.</p></div>
            )}
          </div>
        </section>
      ) : <section className="catalog-no-category"><h3>Виберіть категорію</h3><p>Питання та схема SKU відкриються для вибраної категорії.</p></section>}
    </div>
  );
}
