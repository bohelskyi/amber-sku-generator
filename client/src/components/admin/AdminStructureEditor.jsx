import { useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, GripVertical, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { ConditionBuilder } from './ConditionBuilder';
import { SkuTemplatePreview } from './SkuTemplatePreview';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { FormSection } from '../shared/FormSection';

const EMPTY_EDIT_OPTION = { id: null, value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
const isEnabled = (value) => value === 1 || value === true;

function FieldControl({ children, hint, label }) {
  return (
    <label className="catalog-field-control">
      <span>{label}</span>
      <div>{children}{hint && <small>{hint}</small>}</div>
    </label>
  );
}

function MetaRow({ label, value }) {
  return <div className="catalog-meta-row"><span>{label}</span><strong>{value}</strong></div>;
}

function CategoryForm({ category, isEdit = false, onCancel, onChange, onSave }) {
  return (
    <div className="catalog-context-form">
      <div className="catalog-context-form-header">
        <div>
          <h3>{isEdit ? 'Налаштування категорії' : 'Нова категорія'}</h3>
          <p>{isEdit ? 'Загальні правила для поточної категорії.' : 'Створіть категорію перед додаванням питань.'}</p>
        </div>
        <button type="button" onClick={onCancel} className="btn btn-outline px-3 py-2 text-xs">Закрити</button>
      </div>
      <div className="catalog-compact-form-grid">
        <FieldControl label="Код" hint={category.code_mutable === false ? 'Код уже використано в SKU і його не можна змінити.' : undefined}>
          <input
            className="input-sm"
            placeholder="CODE"
            value={category.code}
            disabled={category.code_mutable === false}
            title={category.code_mutable === false ? 'Код уже використано в SKU і його не можна змінити' : ''}
            onChange={(event) => onChange({ ...category, code: event.target.value.toUpperCase() })}
          />
        </FieldControl>
        <FieldControl label="Назва">
          <input className="input-sm" placeholder="Назва категорії" value={category.name} onChange={(event) => onChange({ ...category, name: event.target.value })} />
        </FieldControl>
      </div>
      <div className="catalog-checkbox-row">
        <label><input type="checkbox" checked={category.requires_weight} onChange={(event) => onChange({ ...category, requires_weight: event.target.checked })} />Потрібна вага</label>
        <label><input type="checkbox" checked={category.skip_hidden_sku_questions} onChange={(event) => onChange({ ...category, skip_hidden_sku_questions: event.target.checked })} />Пропускати приховані питання в SKU</label>
      </div>
      <div className="catalog-form-actions">
        <button type="button" onClick={onSave} className={`btn ${isEdit ? 'btn-primary' : 'btn-amber'}`}>{isEdit ? 'Зберегти зміни' : 'Зберегти категорію'}</button>
        <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>
      </div>
    </div>
  );
}

function QuestionForm({ config, currentCatQuestions, excludeQuestionId, fillNextSkuIndex, isNew = false, onCancel, onChange, onSave, question }) {
  const canUseSkuSettings = question.input_type !== 'text' && question.include_in_sku;

  return (
    <div className="catalog-detail-form">
      <div className="catalog-detail-form-title">
        <div><h3>{isNew ? 'Нове питання' : 'Редагування питання'}</h3><p>{isNew ? 'Налаштуйте поле у контексті поточної категорії.' : question.label}</p></div>
        <button type="button" onClick={onCancel} className="btn btn-outline px-3 py-2 text-xs">Закрити</button>
      </div>
      <FormSection title="Загальні" variant="catalog">
        <FieldControl label="Назва питання">
          <input className="input-sm" placeholder="Розмір" value={question.label} onChange={(event) => onChange({ ...question, label: event.target.value })} />
        </FieldControl>
        <FieldControl label="Тип поля">
          <select
            className="input-sm"
            value={question.input_type}
            onChange={(event) => onChange({ ...question, input_type: event.target.value, include_in_sku: event.target.value === 'text' ? false : question.include_in_sku })}
          >
            <option value="options">Варіанти</option>
            <option value="text">Текстове поле</option>
          </select>
        </FieldControl>
        <div className="catalog-checkbox-row catalog-checkbox-row-compact">
          <label><input type="checkbox" checked={question.required} onChange={(event) => onChange({ ...question, required: event.target.checked })} />Обовʼязкове</label>
        </div>
        <details className="catalog-technical-details">
          <summary>Технічні параметри</summary>
          <div className="catalog-technical-details-body">
            <FieldControl label="Ключ">
              <input className="input-sm font-mono" placeholder="size" value={question.key} onChange={(event) => onChange({ ...question, key: event.target.value })} />
            </FieldControl>
            <FieldControl label="Порядок у формі" hint="Підтримуються проміжні значення: 0.5, 1.5 тощо.">
              <input className="input-sm" type="number" step="0.1" placeholder="0.5" value={question.display_order} onChange={(event) => onChange({ ...question, display_order: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            </FieldControl>
          </div>
        </details>
      </FormSection>
      <FormSection title="SKU" variant="catalog">
        <div className="catalog-checkbox-row catalog-checkbox-row-compact">
          <label><input type="checkbox" checked={question.include_in_sku} disabled={question.input_type === 'text'} onChange={(event) => onChange({ ...question, include_in_sku: event.target.checked })} />Додавати значення в SKU</label>
        </div>
        {canUseSkuSettings ? (
          <div className="catalog-compact-form-grid">
            <FieldControl label="SKU index" hint="Позиція значення в артикулі.">
              <div className="catalog-inline-control">
                <input className="input-sm" type="number" placeholder="1" value={question.sku_index} onChange={(event) => onChange({ ...question, sku_index: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                {isNew && <button type="button" onClick={fillNextSkuIndex} className="btn btn-outline whitespace-nowrap px-3 py-2 text-xs">Наступний</button>}
              </div>
            </FieldControl>
            <FieldControl label="Розділювач" hint="Доступні -, _, . або /.">
              <input className="input-sm font-mono" placeholder="-" value={question.sku_separator} onChange={(event) => onChange({ ...question, sku_separator: event.target.value })} />
            </FieldControl>
          </div>
        ) : <p className="catalog-neutral-note">SKU-параметри не застосовуються до цього питання.</p>}
      </FormSection>
      <FormSection title="Видимість та умови" variant="catalog">
        <ConditionBuilder
          config={config}
          excludeQuestionId={excludeQuestionId}
          label="Показувати питання"
          questions={currentCatQuestions}
          value={question.visible_if_json}
          onChange={(nextValue) => onChange({ ...question, visible_if_json: nextValue })}
        />
      </FormSection>
      <div className="catalog-form-actions">
        <button type="button" onClick={onSave} className={`btn ${isNew ? 'btn-amber' : 'btn-primary'}`}>{isNew ? 'Зберегти питання' : 'Зберегти зміни'}</button>
        <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>
      </div>
    </div>
  );
}

function OptionForm({ config, currentCatQuestions, excludeQuestionId, isNew = false, onCancel, onChange, onSave, option }) {
  return (
    <div className="catalog-option-form">
      <div className="catalog-option-form-header">
        <h4>{isNew ? 'Новий варіант' : 'Редагування варіанта'}</h4>
        <button type="button" onClick={onCancel} className="btn btn-outline px-3 py-1.5 text-xs">Закрити</button>
      </div>
      <div className="catalog-option-form-grid">
        <FieldControl label="Назва">
          <input className="input-sm" placeholder="Назва варіанта" value={option.label} onChange={(event) => onChange({ ...option, label: event.target.value })} />
        </FieldControl>
        <FieldControl label="Внутрішнє значення" hint={isNew ? 'Нове унікальне значення для цін та умов.' : 'Використовується у цінах, умовах і модифікаторах.'}>
          <input className="input-sm" type="number" placeholder="6" value={option.value_id} onChange={(event) => onChange({ ...option, value_id: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
        </FieldControl>
        <FieldControl label="Код у SKU" hint={isNew ? 'Цифри, які потраплять в артикул після публікації.' : 'Може повторно використовувати код з попередньої версії.'}>
          <input className="input-sm font-mono" inputMode="numeric" placeholder="3" value={option.sku_code} onChange={(event) => onChange({ ...option, sku_code: event.target.value.replace(/\D/g, '') })} />
        </FieldControl>
      </div>
      <div className="catalog-condition-grid">
        <ConditionBuilder config={config} excludeQuestionId={excludeQuestionId} label="Показувати варіант" questions={currentCatQuestions} value={option.visible_if_json} onChange={(nextValue) => onChange({ ...option, visible_if_json: nextValue })} />
        <ConditionBuilder config={config} excludeQuestionId={excludeQuestionId} label="Приховувати варіант" questions={currentCatQuestions} value={option.hidden_if_json} onChange={(nextValue) => onChange({ ...option, hidden_if_json: nextValue })} />
      </div>
      <div className="catalog-form-actions">
        <button type="button" onClick={onSave} className={`btn ${isNew ? 'btn-amber' : 'btn-primary'}`}>{isNew ? 'Зберегти варіант' : 'Зберегти зміни'}</button>
        <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>
      </div>
    </div>
  );
}

function OptionRow({ archived = false, config, currentCatQuestions, onArchive, onDelete, onEdit, option }) {
  const visibleSummary = formatConditionSummary(option.visible_if_json, currentCatQuestions, config);
  const hiddenSummary = formatConditionSummary(option.hidden_if_json, currentCatQuestions, config, 'Ніколи');
  const hasConditions = visibleSummary !== 'Завжди' || hiddenSummary !== 'Ніколи';

  return (
    <div className={`catalog-option-row ${archived ? 'is-archived' : ''}`}>
      <div className="min-w-0">
        <div className="catalog-option-name"><span>{option.label}</span>{archived && <small>Архівний</small>}</div>
        <div className="catalog-option-meta">
          <span className="font-mono">SKU {option.sku_code ?? option.id}</span>
          {hasConditions && <span title={`Показувати: ${visibleSummary}. Приховувати: ${hiddenSummary}`}>За умовою</span>}
        </div>
      </div>
      <div className="catalog-row-actions">
        <button type="button" onClick={() => onEdit(option)} className="catalog-icon-button" title="Редагувати" aria-label={`Редагувати ${option.label}`}><Pencil size={14} /></button>
        <button type="button" onClick={() => onArchive(option, !archived)} className="catalog-icon-button" title={archived ? 'Відновити з архіву' : 'Архівувати'} aria-label={`${archived ? 'Відновити' : 'Архівувати'} ${option.label}`}>{archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button>
        <button type="button" onClick={() => onDelete('option', option.db_id)} className="catalog-icon-button is-danger" title="Видалити" aria-label={`Видалити ${option.label}`}><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

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
