import { ConditionBuilder } from './ConditionBuilder';
import { SkuTemplatePreview } from './SkuTemplatePreview';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import { formatConditionSummary } from '../../lib/admin-conditions';

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
  addOption,
  beginOptionEdit,
  updateOption,
  deleteItem,
}) {
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
              onClick={() => onSelectCategory(category)}
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
          <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
            <div className="text-xs text-slate-500 mb-2">Редагувати категорію: {selectedCat.code}</div>
            <input className="input-sm mb-2" placeholder="Name" value={editCat.name} onChange={(event) => setEditCat({ ...editCat, name: event.target.value })} />
            <label className="flex items-center text-sm"><input type="checkbox" checked={editCat.requires_weight} onChange={(event) => setEditCat({ ...editCat, requires_weight: event.target.checked })} className="mr-2" /> Потрібна вага?</label>
            <button onClick={updateCategory} className="btn btn-primary w-full mt-3">Зберегти</button>
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
          <input className="input-sm mb-2" placeholder="Code" value={newCat.code} onChange={(event) => setNewCat({ ...newCat, code: event.target.value.toUpperCase() })} />
          <input className="input-sm mb-2" placeholder="Name" value={newCat.name} onChange={(event) => setNewCat({ ...newCat, name: event.target.value })} />
          <label className="flex items-center text-sm"><input type="checkbox" checked={newCat.requires_weight} onChange={(event) => setNewCat({ ...newCat, requires_weight: event.target.checked })} className="mr-2" /> Потрібна вага?</label>
          <button onClick={addCategory} className="btn btn-amber w-full mt-3">Додати</button>
        </div>
      </div>

      <div className="card p-5 sm:p-6 flex flex-col">
        <div className="section-title mb-4">
          <h2 className="section-title-text">2. Питання</h2>
        </div>
        <SkuTemplatePreview category={selectedCat} questions={currentCatQuestions} />
        <div className="h-96 overflow-y-auto space-y-2 pr-2">
          {currentCatQuestions.map((question) => (
            <div
              key={question.q_db_id}
              onClick={() => onSelectQuestion(question)}
              className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedQuestion?.id === question.id ? 'bg-[rgba(20,32,59,0.08)] border-[rgba(20,32,59,0.4)]' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              <div>
                <span className="font-semibold text-slate-800">{question.label}</span>
                <span className="text-xs text-slate-500 block">Key: {question.id} | Index: {question.sku_index} | {question.required === 1 ? 'Обовʼязкове' : 'Необовʼязкове'} | {question.include_in_sku === 1 ? 'Йде в SKU' : 'Лише в БД'} | Тип: {(question.input_type || 'options') === 'text' ? 'Текст' : 'Варіанти'} | Розділювач: {question.sku_separator || 'немає'}</span>
                <span className="text-[11px] text-slate-500 block">
                  {formatConditionSummary(question.visible_if_json, currentCatQuestions, config)}
                </span>
              </div>
              <button onClick={(event) => { event.stopPropagation(); deleteItem('question', question.q_db_id); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
            </div>
          ))}
        </div>
        {selectedQuestion && (
          <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
            <div className="text-xs text-slate-500 mb-2">Редагувати питання</div>
            <input className="input-sm mb-2" placeholder="Label" value={editQuestion.label} onChange={(event) => setEditQuestion({ ...editQuestion, label: event.target.value })} />
            <input className="input-sm mb-2" type="number" placeholder="Index" value={editQuestion.sku_index} onChange={(event) => setEditQuestion({ ...editQuestion, sku_index: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            <select className="input-sm mb-2" value={editQuestion.input_type} onChange={(event) => setEditQuestion({ ...editQuestion, input_type: event.target.value, include_in_sku: event.target.value === 'text' ? false : editQuestion.include_in_sku })}>
              <option value="options">Варіанти</option>
              <option value="text">Текстове поле</option>
            </select>
            <ConditionBuilder
              config={config}
              excludeQuestionId={selectedQuestion.id}
              label="Показувати питання"
              questions={currentCatQuestions}
              value={editQuestion.visible_if_json}
              onChange={(nextValue) => setEditQuestion({ ...editQuestion, visible_if_json: nextValue })}
            />
            <input className="input-sm mb-2" placeholder="Обгорнути параметр у SKU (-, _, . або /)" value={editQuestion.sku_separator} disabled={editQuestion.input_type === 'text' || !editQuestion.include_in_sku} onChange={(event) => setEditQuestion({ ...editQuestion, sku_separator: event.target.value })} />
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.required} onChange={(event) => setEditQuestion({ ...editQuestion, required: event.target.checked })} className="mr-2" /> Обовʼязкове</label>
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.include_in_sku} disabled={editQuestion.input_type === 'text'} onChange={(event) => setEditQuestion({ ...editQuestion, include_in_sku: event.target.checked })} className="mr-2" /> Додавати в SKU</label>
            <button onClick={updateQuestion} className="btn btn-primary w-full">Зберегти</button>
          </div>
        )}
        {selectedCat && (
          <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
            <input className="input-sm mb-2" placeholder="Key (size)" value={newQuest.key} onChange={(event) => setNewQuest({ ...newQuest, key: event.target.value })} />
            <input className="input-sm mb-2" placeholder="Label" value={newQuest.label} onChange={(event) => setNewQuest({ ...newQuest, label: event.target.value })} />
            <input className="input-sm mb-2" type="number" placeholder="Index" value={newQuest.sku_index} onChange={(event) => setNewQuest({ ...newQuest, sku_index: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            <select className="input-sm mb-2" value={newQuest.input_type} onChange={(event) => setNewQuest({ ...newQuest, input_type: event.target.value, include_in_sku: event.target.value === 'text' ? false : newQuest.include_in_sku })}>
              <option value="options">Варіанти</option>
              <option value="text">Текстове поле</option>
            </select>
            <ConditionBuilder
              config={config}
              label="Показувати питання"
              questions={currentCatQuestions}
              value={newQuest.visible_if_json}
              onChange={(nextValue) => setNewQuest({ ...newQuest, visible_if_json: nextValue })}
            />
            <input className="input-sm mb-2" placeholder="Обгорнути параметр у SKU (-, _, . або /)" value={newQuest.sku_separator} disabled={newQuest.input_type === 'text' || !newQuest.include_in_sku} onChange={(event) => setNewQuest({ ...newQuest, sku_separator: event.target.value })} />
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.required} onChange={(event) => setNewQuest({ ...newQuest, required: event.target.checked })} className="mr-2" /> Обовʼязкове</label>
            <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.include_in_sku} disabled={newQuest.input_type === 'text'} onChange={(event) => setNewQuest({ ...newQuest, include_in_sku: event.target.checked })} className="mr-2" /> Додавати в SKU</label>
            <button onClick={addQuestion} className="btn btn-amber w-full">Додати</button>
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
            <div className="text-xs text-slate-500 mb-2">Редагувати опцію</div>
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
          <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
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
            <button onClick={addOption} className="btn btn-amber w-full">Додати</button>
          </div>
        )}
      </div>
    </div>
  );
}
