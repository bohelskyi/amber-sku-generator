import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';
import { ConditionBuilder } from './ConditionBuilder';
import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { FormSection } from '../shared/FormSection';
function FieldControl({ children, hint, label }) {
  return (
    <label className="catalog-field-control">
      <span>{label}</span>
      <div>{children}{hint && <small>{hint}</small>}</div>
    </label>
  );
}

export function MetaRow({ label, value }) {
  return <div className="catalog-meta-row"><span>{label}</span><strong>{value}</strong></div>;
}

export function CategoryForm({ category, isEdit = false, onCancel, onChange, onSave }) {
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

export function QuestionForm({ config, currentCatQuestions, excludeQuestionId, fillNextSkuIndex, isNew = false, onCancel, onChange, onSave, question }) {
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

export function OptionForm({ config, currentCatQuestions, excludeQuestionId, isNew = false, onCancel, onChange, onSave, option }) {
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

export function OptionRow({ archived = false, config, currentCatQuestions, onArchive, onDelete, onEdit, option }) {
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

