import { useState } from 'react';
import { ConditionBuilder } from './ConditionBuilder';
import { SkuTemplatePreview } from './SkuTemplatePreview';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import { formatConditionSummary } from '../../lib/admin-conditions';

function FieldControl({ children, hint, label }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function AdminStructureEditor({
  config,
  selectedCat,
  selectedQuestion,
  currentCatQuestions,
  currentOptions,
  selectedQuestionInputType,
  editCat,
  setEditCat,
  editQuestion,
  setEditQuestion,
  newCat,
  setNewCat,
  newQuest,
  setNewQuest,
  newOpt,
  setNewOpt,
  editOpt,
  setEditOpt,
  onSelectCategory,
  onSelectQuestion,
  addCategory,
  updateCategory,
  addQuestion,
  updateQuestion,
  reorderQuestions,
  autoAssignSkuIndexes,
  fillNextNewQuestionSkuIndex,
  addOption,
  beginOptionEdit,
  updateOption,
  deleteItem,
}) {
  const [isCategoryEditOpen, setIsCategoryEditOpen] = useState(false);
  const [isNewCategoryOpen, setIsNewCategoryOpen] = useState(false);
  const [isQuestionEditOpen, setIsQuestionEditOpen] = useState(false);
  const [isNewQuestionOpen, setIsNewQuestionOpen] = useState(false);
  const [isNewOptionOpen, setIsNewOptionOpen] = useState(false);
  const [draggedQuestionId, setDraggedQuestionId] = useState(null);
  const [questionDropTarget, setQuestionDropTarget] = useState({ id: null, position: null });
  const canEditQuestionSku = editQuestion.input_type !== 'text' && editQuestion.include_in_sku;
  const canNewQuestionSku = newQuest.input_type !== 'text' && newQuest.include_in_sku;

  const selectCategory = (category) => {
    setIsCategoryEditOpen(false);
    setIsQuestionEditOpen(false);
    setIsNewQuestionOpen(false);
    setIsNewOptionOpen(false);
    onSelectCategory(category);
  };

  const selectQuestion = (question) => {
    setIsQuestionEditOpen(false);
    setIsNewOptionOpen(false);
    onSelectQuestion(question);
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
    setQuestionDropTarget({
      id: targetQuestionId,
      position: getDropPosition(event),
    });
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

    const insertionIndex = getDropPosition(event) === 'after'
      ? targetIndexAfterRemoval + 1
      : targetIndexAfterRemoval;
    nextQuestions.splice(insertionIndex, 0, movedQuestion);
    reorderQuestions(nextQuestions);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start fade-up stagger-2">
      <div className="card p-5 sm:p-6 flex flex-col">
        <div className="section-title mb-4">
          <h2 className="section-title-text">1. Категорії</h2>
        </div>
        <div className="h-96 overflow-y-auto space-y-2 pr-2">
          {Object.values(config.categories).map((category) => (
            <div
              key={category.code}
              onClick={() => selectCategory(category)}
              className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedCat?.code === category.code ? 'bg-[rgba(221,151,74,0.18)] border-[rgba(221,151,74,0.5)]' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              <div>
                <span className="font-semibold text-slate-800">{category.name}</span>
                <span className="text-xs text-slate-500 block">Code: {category.code}</span>
              </div>
              <button onClick={(event) => { event.stopPropagation(); deleteItem('category', category.code); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
            </div>
          ))}
        </div>
        {selectedCat && (
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setIsCategoryEditOpen((isOpen) => !isOpen)}
              className="btn btn-outline w-full text-xs"
            >
              {isCategoryEditOpen ? 'Приховати редагування' : 'Редагувати категорію'}
            </button>
          </div>
        )}
        {selectedCat && isCategoryEditOpen && (
          <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
            <div className="text-xs text-slate-500 mb-2">Редагувати категорію: {selectedCat.code}</div>
            <input className="input-sm mb-2" placeholder="Code" value={editCat.code} onChange={(event) => setEditCat({ ...editCat, code: event.target.value.toUpperCase() })} />
            <input className="input-sm mb-2" placeholder="Name" value={editCat.name} onChange={(event) => setEditCat({ ...editCat, name: event.target.value })} />
            <label className="flex items-center text-sm"><input type="checkbox" checked={editCat.requires_weight} onChange={(event) => setEditCat({ ...editCat, requires_weight: event.target.checked })} className="mr-2" /> Потрібна вага?</label>
            <label className="mt-2 flex items-start text-sm">
              <input type="checkbox" checked={editCat.skip_hidden_sku_questions} onChange={(event) => setEditCat({ ...editCat, skip_hidden_sku_questions: event.target.checked })} className="mr-2 mt-1" />
              <span>Пропускати приховані питання в SKU</span>
            </label>
            <button onClick={updateCategory} className="btn btn-primary w-full mt-3">Зберегти</button>
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-slate-200">
          <button
            onClick={() => setIsNewCategoryOpen((isOpen) => !isOpen)}
            className="btn btn-amber w-full"
          >
            {isNewCategoryOpen ? 'Приховати додавання' : 'Додати категорію'}
          </button>
          {isNewCategoryOpen && (
            <div className="mt-3 bg-slate-50/70 p-3 rounded-xl">
              <input className="input-sm mb-2" placeholder="Code" value={newCat.code} onChange={(event) => setNewCat({ ...newCat, code: event.target.value.toUpperCase() })} />
              <input className="input-sm mb-2" placeholder="Name" value={newCat.name} onChange={(event) => setNewCat({ ...newCat, name: event.target.value })} />
              <label className="flex items-center text-sm"><input type="checkbox" checked={newCat.requires_weight} onChange={(event) => setNewCat({ ...newCat, requires_weight: event.target.checked })} className="mr-2" /> Потрібна вага?</label>
              <label className="mt-2 flex items-start text-sm">
                <input type="checkbox" checked={newCat.skip_hidden_sku_questions} onChange={(event) => setNewCat({ ...newCat, skip_hidden_sku_questions: event.target.checked })} className="mr-2 mt-1" />
                <span>Пропускати приховані питання в SKU</span>
              </label>
              <button onClick={addCategory} className="btn btn-amber w-full mt-3">Зберегти категорію</button>
            </div>
          )}
        </div>
      </div>

      <div className="card p-5 sm:p-6 flex flex-col">
        <div className="section-title mb-4">
          <h2 className="section-title-text">2. Питання</h2>
          {selectedCat && (
            <button onClick={autoAssignSkuIndexes} className="btn btn-outline text-xs px-3 py-2">
              Переіндексувати SKU
            </button>
          )}
        </div>
        <SkuTemplatePreview category={selectedCat} questions={currentCatQuestions} />
        <div className="h-96 overflow-y-auto space-y-2 pr-2">
          {currentCatQuestions.map((question) => (
            <div
              key={question.q_db_id}
              draggable
              onClick={() => selectQuestion(question)}
              onDragStart={(event) => handleQuestionDragStart(event, question)}
              onDragOver={(event) => handleQuestionDragOver(event, question)}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setQuestionDropTarget({ id: null, position: null });
                }
              }}
              onDrop={(event) => handleQuestionDrop(event, question)}
              onDragEnd={() => {
                setDraggedQuestionId(null);
                setQuestionDropTarget({ id: null, position: null });
              }}
              className={`relative p-3 rounded-xl cursor-move flex justify-between items-center border transition ${draggedQuestionId === question.q_db_id ? 'opacity-60 border-[rgba(221,151,74,0.6)] bg-[rgba(221,151,74,0.10)]' : selectedQuestion?.id === question.id ? 'bg-[rgba(20,32,59,0.08)] border-[rgba(20,32,59,0.4)]' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'before' && (
                <div className="pointer-events-none absolute -top-1 left-3 right-3 h-1 rounded-full bg-[rgba(221,151,74,0.95)]" />
              )}
              {questionDropTarget.id === question.q_db_id && questionDropTarget.position === 'after' && (
                <div className="pointer-events-none absolute -bottom-1 left-3 right-3 h-1 rounded-full bg-[rgba(221,151,74,0.95)]" />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="select-none rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-400" title="Перетягніть питання вище або нижче">::</span>
                  <span className="font-semibold text-slate-800">{question.label}</span>
                </div>
                <span className="text-xs text-slate-500 block">Key: {question.id} | Порядок: {question.display_order ?? question.sku_index} | SKU index: {question.include_in_sku === 1 ? question.sku_index : 'немає'} | {question.required === 1 ? 'Обовʼязкове' : 'Необовʼязкове'} | {question.include_in_sku === 1 ? 'Йде в SKU' : 'Лише в БД'} | Тип: {(question.input_type || 'options') === 'text' ? 'Текст' : 'Варіанти'} | Розділювач: {question.include_in_sku === 1 ? question.sku_separator || 'немає' : 'немає'}</span>
                <span className="text-[11px] text-slate-500 block">
                  {formatConditionSummary(question.visible_if_json, currentCatQuestions, config)}
                </span>
              </div>
              <button onClick={(event) => { event.stopPropagation(); deleteItem('question', question.q_db_id); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
            </div>
          ))}
        </div>
        {selectedQuestion && (
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setIsQuestionEditOpen((isOpen) => !isOpen)}
              className="btn btn-outline w-full text-xs"
            >
              {isQuestionEditOpen ? 'Приховати редагування' : 'Редагувати питання'}
            </button>
          </div>
        )}
        {selectedQuestion && isQuestionEditOpen && (
          <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
            <div className="text-xs text-slate-500 mb-2">Редагувати питання</div>
            <FieldControl label="Key">
              <input className="input-sm" placeholder="size" value={editQuestion.key} onChange={(event) => setEditQuestion({ ...editQuestion, key: event.target.value })} />
            </FieldControl>
            <FieldControl label="Назва питання">
              <input className="input-sm" placeholder="Розмір" value={editQuestion.label} onChange={(event) => setEditQuestion({ ...editQuestion, label: event.target.value })} />
            </FieldControl>
            <FieldControl label="Тип питання">
              <select className="input-sm" value={editQuestion.input_type} onChange={(event) => setEditQuestion({ ...editQuestion, input_type: event.target.value, include_in_sku: event.target.value === 'text' ? false : editQuestion.include_in_sku })}>
                <option value="options">Варіанти</option>
                <option value="text">Текстове поле</option>
              </select>
            </FieldControl>
            <FieldControl label="Порядок у формі" hint="Відповідає тільки за місце питання на екрані. Можна вводити 0.5, 1.5 тощо.">
              <input className="input-sm" type="number" step="0.1" placeholder="0.5" value={editQuestion.display_order} onChange={(event) => setEditQuestion({ ...editQuestion, display_order: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            </FieldControl>
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.required} onChange={(event) => setEditQuestion({ ...editQuestion, required: event.target.checked })} className="mr-2" /> Обовʼязкове</label>
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.include_in_sku} disabled={editQuestion.input_type === 'text'} onChange={(event) => setEditQuestion({ ...editQuestion, include_in_sku: event.target.checked })} className="mr-2" /> Додавати в SKU</label>
            {canEditQuestionSku ? (
              <>
                <FieldControl label="SKU index" hint="Відповідає за позицію значення в артикулі.">
                  <input className="input-sm" type="number" placeholder="1" value={editQuestion.sku_index} onChange={(event) => setEditQuestion({ ...editQuestion, sku_index: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                </FieldControl>
                <FieldControl label="Розділювач у SKU" hint="Можна використовувати тільки -, _, . або /.">
                  <input className="input-sm" placeholder="-" value={editQuestion.sku_separator} onChange={(event) => setEditQuestion({ ...editQuestion, sku_separator: event.target.value })} />
                </FieldControl>
              </>
            ) : (
              <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                SKU index не потрібен, бо це питання не додається в артикул.
              </p>
            )}
            <ConditionBuilder
              config={config}
              excludeQuestionId={selectedQuestion.id}
              label="Показувати питання"
              questions={currentCatQuestions}
              value={editQuestion.visible_if_json}
              onChange={(nextValue) => setEditQuestion({ ...editQuestion, visible_if_json: nextValue })}
            />
            <button onClick={updateQuestion} className="btn btn-primary w-full">Зберегти</button>
          </div>
        )}
        {selectedCat && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <button
              onClick={() => setIsNewQuestionOpen((isOpen) => !isOpen)}
              className="btn btn-amber w-full"
            >
              {isNewQuestionOpen ? 'Приховати додавання' : 'Додати питання'}
            </button>
            {isNewQuestionOpen && (
              <div className="mt-3 bg-slate-50/70 p-3 rounded-xl">
                <FieldControl label="Key">
                  <input className="input-sm" placeholder="size" value={newQuest.key} onChange={(event) => setNewQuest({ ...newQuest, key: event.target.value })} />
                </FieldControl>
                <FieldControl label="Назва питання">
                  <input className="input-sm" placeholder="Розмір" value={newQuest.label} onChange={(event) => setNewQuest({ ...newQuest, label: event.target.value })} />
                </FieldControl>
                <FieldControl label="Тип питання">
                  <select className="input-sm" value={newQuest.input_type} onChange={(event) => setNewQuest({ ...newQuest, input_type: event.target.value, include_in_sku: event.target.value === 'text' ? false : newQuest.include_in_sku })}>
                    <option value="options">Варіанти</option>
                    <option value="text">Текстове поле</option>
                  </select>
                </FieldControl>
                <FieldControl label="Порядок у формі" hint="Відповідає тільки за місце питання на екрані. Можна вводити 0.5, 1.5 тощо.">
                  <input className="input-sm" type="number" step="0.1" placeholder="0.5" value={newQuest.display_order} onChange={(event) => setNewQuest({ ...newQuest, display_order: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                </FieldControl>
                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.required} onChange={(event) => setNewQuest({ ...newQuest, required: event.target.checked })} className="mr-2" /> Обовʼязкове</label>
                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.include_in_sku} disabled={newQuest.input_type === 'text'} onChange={(event) => setNewQuest({ ...newQuest, include_in_sku: event.target.checked })} className="mr-2" /> Додавати в SKU</label>
                {canNewQuestionSku ? (
                  <>
                    <FieldControl label="SKU index" hint="Відповідає за позицію значення в артикулі.">
                      <input className="input-sm" type="number" placeholder="1" value={newQuest.sku_index} onChange={(event) => setNewQuest({ ...newQuest, sku_index: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                    </FieldControl>
                    <button onClick={fillNextNewQuestionSkuIndex} className="btn btn-outline mb-2 w-full text-xs">
                      Наступний SKU index
                    </button>
                    <FieldControl label="Розділювач у SKU" hint="Можна використовувати тільки -, _, . або /.">
                      <input className="input-sm" placeholder="-" value={newQuest.sku_separator} onChange={(event) => setNewQuest({ ...newQuest, sku_separator: event.target.value })} />
                    </FieldControl>
                  </>
                ) : (
                  <p className="mb-2 rounded-lg bg-white/80 px-3 py-2 text-xs text-slate-500">
                    SKU index не потрібен, бо це питання не додається в артикул.
                  </p>
                )}
                <ConditionBuilder
                  config={config}
                  label="Показувати питання"
                  questions={currentCatQuestions}
                  value={newQuest.visible_if_json}
                  onChange={(nextValue) => setNewQuest({ ...newQuest, visible_if_json: nextValue })}
                />
                <button onClick={addQuestion} className="btn btn-amber w-full">Зберегти питання</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card p-5 sm:p-6 flex flex-col">
        <div className="section-title mb-4">
          <h2 className="section-title-text">3. Варіанти</h2>
        </div>
        <div className="h-96 overflow-y-auto space-y-2 pr-2">
          {selectedQuestionInputType === 'text' && (
            <div className="p-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-600">
              Для текстового питання варіанти не використовуються.
            </div>
          )}
          {currentOptions.map((option) => (
            <div key={option.db_id} className="p-2 border border-slate-200 rounded-xl flex justify-between bg-white/80 items-center">
              <div>
                <span className="text-sm text-slate-700">{option.label}</span>
                <span className="text-[11px] text-slate-500 block">
                  {formatConditionSummary(option.visible_if_json, currentCatQuestions, config)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="bg-slate-100 px-2 rounded text-xs text-slate-600">{option.id}</span>
                <button onClick={() => beginOptionEdit(option)} className="btn btn-outline text-xs px-2 py-1">Редагувати</button>
                <button onClick={() => deleteItem('option', option.db_id)} className="text-rose-400 hover:text-rose-600 font-bold px-2">×</button>
              </div>
            </div>
          ))}
        </div>
        {editOpt.id && (
          <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">Редагувати опцію</div>
              <button onClick={() => setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' })} className="btn btn-outline px-2 py-1 text-xs">Приховати</button>
            </div>
            <input className="input-sm mb-2" type="number" placeholder="Value ID" value={editOpt.value_id} onChange={(event) => setEditOpt({ ...editOpt, value_id: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            <input className="input-sm mb-2" placeholder="Label" value={editOpt.label} onChange={(event) => setEditOpt({ ...editOpt, label: event.target.value })} />
            <ConditionBuilder
              config={config}
              excludeQuestionId={selectedQuestion.id}
              label="Показувати варіант"
              questions={currentCatQuestions}
              value={editOpt.visible_if_json}
              onChange={(nextValue) => setEditOpt({ ...editOpt, visible_if_json: nextValue })}
            />
            <div className="flex gap-2">
              <button onClick={updateOption} className="btn btn-primary w-full">Зберегти</button>
              <button onClick={() => setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' })} className="btn btn-outline w-full">Скасувати</button>
            </div>
          </div>
        )}
        {selectedQuestion && selectedQuestionInputType !== 'text' && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <button
              onClick={() => setIsNewOptionOpen((isOpen) => !isOpen)}
              className="btn btn-amber w-full"
            >
              {isNewOptionOpen ? 'Приховати додавання' : 'Додати варіант'}
            </button>
            {isNewOptionOpen && (
              <div className="mt-3 bg-slate-50/70 p-3 rounded-xl">
                <input className="input-sm mb-2" type="number" placeholder="Value ID" value={newOpt.value_id} onChange={(event) => setNewOpt({ ...newOpt, value_id: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                <input className="input-sm mb-2" placeholder="Label" value={newOpt.label} onChange={(event) => setNewOpt({ ...newOpt, label: event.target.value })} />
                <ConditionBuilder
                  config={config}
                  excludeQuestionId={selectedQuestion.id}
                  label="Показувати варіант"
                  questions={currentCatQuestions}
                  value={newOpt.visible_if_json}
                  onChange={(nextValue) => setNewOpt({ ...newOpt, visible_if_json: nextValue })}
                />
                <button onClick={addOption} className="btn btn-amber w-full">Зберегти варіант</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
