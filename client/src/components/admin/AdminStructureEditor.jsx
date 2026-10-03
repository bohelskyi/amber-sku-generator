import { useEffect, useState } from 'react';
import { Archive, ChevronDown, GripVertical, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { SkuTemplatePreview } from './SkuTemplatePreview';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { FormSection } from '../shared/FormSection';
import { CategoryForm, MetaRow, OptionForm, OptionRow, QuestionForm } from './AdminCatalogForms';

const EMPTY_EDIT_OPTION = { id: null, value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false };
const EMPTY_NEW_CATEGORY = { code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true };
const EMPTY_NEW_OPTION = { value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false };
const draftsMatch = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ruleText = (value) => value ? (typeof value === 'string' ? value : JSON.stringify(value)) : '';
const isEnabled = (value) => value === 1 || value === true;
export function AdminStructureEditor({
  canManage = true, canPublish = false,
  config, selectedCat, selectedQuestion, currentCatQuestions, currentOptions,
  selectedQuestionInputType, schemaStatus, schemaStatusError, retrySchemaStatus, schemaPublishState, editCat = {}, setEditCat,
  editQuestion = {}, setEditQuestion, newCat = EMPTY_NEW_CATEGORY, setNewCat, newQuest = {}, setNewQuest, newOpt = EMPTY_NEW_OPTION,
  setNewOpt, editOpt = EMPTY_EDIT_OPTION, setEditOpt, onSelectCategory, onSelectQuestion, addCategory,
  updateCategory, addQuestion, updateQuestion, reorderQuestions, autoAssignSkuIndexes,
  fillNextNewQuestionSkuIndex, addOption, archiveOption, beginOptionEdit, updateOption,
  publishSkuSchema, deleteItem,
  onDirtyChange = () => {},
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
  const selectedOption = editOpt.id ? currentOptions.find((option) => option.db_id === editOpt.id) : null;
  const nextDisplayOrder = String(currentCatQuestions.reduce((maxValue, question) => {
    const value = Number(question.display_order ?? question.sku_index);
    return Number.isFinite(value) ? Math.max(maxValue, value) : maxValue;
  }, 0) + 1);
  const nextSkuIndex = String(currentCatQuestions.filter((question) => isEnabled(question.include_in_sku))
    .reduce((maxValue, question) => {
      const value = Number(question.sku_index);
      return Number.isFinite(value) ? Math.max(maxValue, value) : maxValue;
    }, 0) + 1);
  const catalogDirty = (
    (isNewCategoryOpen && !draftsMatch(newCat, EMPTY_NEW_CATEGORY))
    || (isCategoryEditOpen && selectedCat && !draftsMatch(editCat, {
      code: selectedCat.code,
      name: selectedCat.name,
      requires_weight: isEnabled(selectedCat.requires_weight),
      skip_hidden_sku_questions: isEnabled(selectedCat.skip_hidden_sku_questions),
      marketing_rounding_enabled: selectedCat.marketing_rounding_enabled !== 0,
      code_mutable: selectedCat.code_mutable !== false,
    }))
    || (isNewQuestionOpen && !draftsMatch(newQuest, {
      key: '', label: '', display_order: nextDisplayOrder, sku_index: nextSkuIndex,
      required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '',
    }))
    || (isQuestionEditOpen && selectedQuestion && !draftsMatch(editQuestion, {
      key: selectedQuestion.id,
      label: selectedQuestion.label,
      display_order: selectedQuestion.display_order ?? selectedQuestion.sku_index,
      sku_index: selectedQuestion.sku_index,
      required: isEnabled(selectedQuestion.required),
      include_in_sku: isEnabled(selectedQuestion.include_in_sku),
      input_type: selectedQuestion.input_type || 'options',
      sku_separator: selectedQuestion.sku_separator || '',
      visible_if_json: ruleText(selectedQuestion.visible_if_json),
    }))
    || (isNewOptionOpen && !draftsMatch(newOpt, EMPTY_NEW_OPTION))
    || Boolean(selectedOption && !draftsMatch(editOpt, {
      id: selectedOption.db_id,
      value_id: String(selectedOption.id),
      sku_code: String(selectedOption.sku_code ?? selectedOption.id),
      label: selectedOption.label,
      label_en: selectedOption.label_en ?? '',
      visible_if_json: ruleText(selectedOption.visible_if_json),
      hidden_if_json: ruleText(selectedOption.hidden_if_json),
      archived: isEnabled(selectedOption.archived),
    }))
  );

  useEffect(() => {
    onDirtyChange(Boolean(catalogDirty));
  }, [catalogDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

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
          {canManage && <button type="button" onClick={() => { setIsCategoryEditOpen(false); setIsNewCategoryOpen((isOpen) => !isOpen); }} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Категорія</button>}
        </div>
        <div className="catalog-category-tabs" role="group" aria-label="Категорії каталогу">
          {Object.values(config.categories).map((category) => (
            <button key={category.code} type="button" aria-pressed={selectedCat?.code === category.code} onClick={() => selectCategory(category)} className={`catalog-category-tab ${selectedCat?.code === category.code ? 'is-active' : ''}`}>
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
                {!schemaStatus && !schemaStatusError && <span className="catalog-schema-state"><i />Завантажуємо стан схеми…</span>}
              </div>
              {(canManage || canPublish) && <div className="catalog-category-actions">
                {canManage && <button type="button" onClick={() => { setIsNewCategoryOpen(false); setIsCategoryEditOpen((isOpen) => !isOpen); }} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Pencil size={14} />Категорія</button>}
                {canPublish && <button type="button" onClick={publishSkuSchema} disabled={!schemaStatus?.draftChanged || schemaPublishState.loading} className="btn btn-primary flex items-center gap-1.5 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-45">
                  <Send size={14} />{schemaPublishState.loading
                    ? schemaPublishState.otherCategory
                      ? `Публікується «${schemaPublishState.categoryName}»…`
                      : 'Публікуємо…'
                    : schemaStatus?.nextVersion ? `Опублікувати V${schemaStatus.nextVersion}` : 'Опублікувати'}
                </button>}
                {canManage && <button type="button" onClick={() => deleteItem('category', selectedCat.code)} className="catalog-icon-button is-danger" title="Видалити категорію" aria-label={`Видалити категорію ${selectedCat.name}`}><Trash2 size={15} /></button>}
              </div>}
            </div>
            {schemaStatusError && <div className="catalog-context-error" role="alert">Не вдалося завантажити стан схеми. <button type="button" className="et-link" onClick={retrySchemaStatus}>Спробувати ще раз</button></div>}
            {schemaPublishState.otherCategory && <p className="catalog-context-error" role="status">Завершуємо публікацію схеми для «{schemaPublishState.categoryName}». Дочекайтеся результату перед наступною публікацією.</p>}
            {schemaPublishState.error && <p className="catalog-context-error" role="alert">{schemaPublishState.error}</p>}
            <SkuTemplatePreview category={selectedCat} marker={schemaStatus?.draftChanged ? schemaStatus.nextMarker : schemaStatus?.active?.marker} questions={currentCatQuestions} />
          </>
        )}
        {canManage && isCategoryEditOpen && selectedCat && <CategoryForm category={editCat} isEdit onCancel={() => setIsCategoryEditOpen(false)} onChange={setEditCat} onSave={updateCategory} />}
        {canManage && isNewCategoryOpen && <CategoryForm category={newCat} onCancel={() => setIsNewCategoryOpen(false)} onChange={setNewCat} onSave={addCategory} />}
      </section>

      {selectedCat ? (
        <section className="catalog-workspace">
          <aside className="catalog-master">
            <div className="catalog-pane-header">
              <div><h3>Питання</h3><p>{currentCatQuestions.length} у поточній категорії</p></div>
              {canManage && <button type="button" onClick={openNewQuestion} className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Додати</button>}
            </div>
            {canManage && <button type="button" onClick={autoAssignSkuIndexes} className="catalog-master-utility">Переіндексувати SKU</button>}
            <div className="catalog-question-list">
              {currentCatQuestions.map((question) => {
                const isConditional = formatConditionSummary(question.visible_if_json, currentCatQuestions, config) !== 'Завжди';
                const isSelected = selectedQuestion?.id === question.id && !(canManage && isNewQuestionOpen);
                return (
                  <div
                    key={question.q_db_id}
                    draggable={canManage}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => selectQuestion(question)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectQuestion(question); }
                      if (canManage && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                        event.preventDefault();
                        const index = currentCatQuestions.indexOf(question);
                        const next = index + (event.key === 'ArrowUp' ? -1 : 1);
                        if (next < 0 || next >= currentCatQuestions.length) return;
                        const ordered = [...currentCatQuestions];
                        [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
                        reorderQuestions(ordered);
                      }
                    }}
                    title={canManage ? 'Alt + ↑ / ↓: змінити порядок питання' : undefined}
                    onDragStart={(event) => handleQuestionDragStart(event, question)}
                    onDragOver={(event) => handleQuestionDragOver(event, question)}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setQuestionDropTarget({ id: null, position: null }); }}
                    onDrop={(event) => handleQuestionDrop(event, question)}
                    onDragEnd={() => { setDraggedQuestionId(null); setQuestionDropTarget({ id: null, position: null }); }}
                    className={`catalog-question-row ${isSelected ? 'is-selected' : ''} ${draggedQuestionId === question.q_db_id ? 'is-dragging' : ''}`}
                  >
                    {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'before' && <span className="catalog-drop-line is-before" />}
                    {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'after' && <span className="catalog-drop-line is-after" />}
                    {canManage && <GripVertical className="catalog-drag-handle" size={16} aria-hidden="true" />}
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
            {canManage && isNewQuestionOpen ? (
              <QuestionForm config={config} currentCatQuestions={currentCatQuestions} fillNextSkuIndex={fillNextNewQuestionSkuIndex} isNew onCancel={() => setIsNewQuestionOpen(false)} onChange={setNewQuest} onSave={addQuestion} question={newQuest} />
            ) : selectedQuestion ? (
              <>
                <div className="catalog-detail-header">
                  <div className="min-w-0"><h3>{selectedQuestion.label}</h3><p>{(selectedQuestion.input_type || 'options') === 'text' ? 'Текстове поле' : 'Поле з варіантами'}</p></div>
                  {canManage && <div className="catalog-row-actions">
                    {!isQuestionEditOpen && <button type="button" onClick={openQuestionEdit} className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs"><Pencil size={14} />Редагувати</button>}
                    <button type="button" onClick={() => deleteItem('question', selectedQuestion.q_db_id)} className="catalog-icon-button is-danger" title="Видалити питання" aria-label={`Видалити питання ${selectedQuestion.label}`}><Trash2 size={15} /></button>
                  </div>}
                </div>
                {canManage && isQuestionEditOpen ? (
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
                        {isEnabled(selectedQuestion.include_in_sku) && <MetaRow label="Позиція у внутрішньому SKU" value={selectedQuestion.sku_index ?? '—'} />}
                        {isEnabled(selectedQuestion.include_in_sku) && <MetaRow label="Розділювач" value={selectedQuestion.sku_separator || 'Немає'} />}
                      </div>
                    </details>
                  </div>
                )}

                <section className="catalog-variants-section">
                  <div className="catalog-variants-header">
                    <div><h4>Варіанти</h4><p>{activeOptions.length} активних{archivedOptions.length ? ` · ${archivedOptions.length} в архіві` : ''}</p></div>
                    {canManage && selectedQuestionInputType !== 'text' && <button type="button" onClick={openNewOption} className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs"><Plus size={14} />Додати варіант</button>}
                  </div>
                  {canManage && editOpt.id && <OptionForm config={config} currentCatQuestions={currentCatQuestions} excludeQuestionId={selectedQuestion.id} onCancel={resetOptionEdit} onChange={setEditOpt} onSave={updateOption} option={editOpt} />}
                  {canManage && isNewOptionOpen && selectedQuestionInputType !== 'text' && <OptionForm config={config} currentCatQuestions={currentCatQuestions} excludeQuestionId={selectedQuestion.id} isNew onCancel={() => setIsNewOptionOpen(false)} onChange={setNewOpt} onSave={addOption} option={newOpt} />}
                  {selectedQuestionInputType === 'text' ? <p className="catalog-empty-state">Для текстового питання варіанти не використовуються.</p> : (
                    <div className="catalog-option-list">
                      {activeOptions.map((option) => <OptionRow canManage={canManage} key={option.db_id} option={option} config={config} currentCatQuestions={currentCatQuestions} onArchive={archiveOption} onDelete={deleteItem} onEdit={openOptionEdit} />)}
                      {activeOptions.length === 0 && <p className="catalog-empty-state">Активних варіантів немає.</p>}
                    </div>
                  )}
                  {archivedOptions.length > 0 && (
                    <div className="catalog-archived-section">
                      <button type="button" onClick={() => setIsArchivedOptionsOpen((isOpen) => !isOpen)}><span><Archive size={14} />Архівні варіанти ({archivedOptions.length})</span><ChevronDown size={16} className={isArchivedOptionsOpen ? 'rotate-180' : ''} /></button>
                      {isArchivedOptionsOpen && <div className="catalog-option-list">{archivedOptions.map((option) => <OptionRow canManage={canManage} key={option.db_id} archived option={option} config={config} currentCatQuestions={currentCatQuestions} onArchive={archiveOption} onDelete={deleteItem} onEdit={openOptionEdit} />)}</div>}
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
