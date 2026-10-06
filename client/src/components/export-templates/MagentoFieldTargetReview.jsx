import { useState } from 'react';
import { columnChange, requiredColumns } from '../../lib/export-template-columns.js';
import MagentoTargetPicker from './MagentoTargetPicker.jsx';

export default function MagentoFieldTargetReview({ definition, groupIndex, column, disabled, onApply, onEditing }) {
  const [target, setTarget] = useState(null); const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState('');
  const group = definition.groups[groupIndex];
  const eligible = target && target.attribute_code !== column && !group.columns.includes(target.attribute_code)
    && !requiredColumns.has(column) && ['text', 'textarea', 'select', 'multiselect'].includes(target.frontend_input);
  return <section className="space-y-3" aria-label="Змінити атрибут призначення">
    <p>Поточне поле: <strong>{column}</strong>. Оберіть точний наявний атрибут у наборі Magento.</p>
    <MagentoTargetPicker group={group} replacing={column} selected={target?.attribute_code || ''} disabled={disabled}
      onSelect={(next) => { if (disabled) return; setTarget(next); setConfirmed(false); setError(''); onEditing(); }} />
    {target && <p>Нове поле: <strong>{target.default_frontend_label || target.attribute_code}</strong> · {target.attribute_code}.</p>}
    <p>Правила основної та EN-мови й пов’язані перевірки збережуться під новим полем у чернетці. Тип і точні значення нового атрибута потрібно заново перевірити в підготовці відповідностей.</p>
    <label className="block"><input type="checkbox" checked={confirmed} disabled={disabled || !eligible}
      onChange={(event) => { if (!disabled) { setConfirmed(event.target.checked); onEditing(); } }} /> Переглянув обидві мови та обрав точний атрибут призначення.</label>
    <p>Після збереження потрібні нова версія правил, свіже спостереження, перевірка товарів і явне застосування пакета. Чинна публікація зберігається.</p>
    <button type="button" className="btn btn-primary" disabled={disabled || !eligible || !confirmed} onClick={() => {
      if (disabled || !eligible || !confirmed) return;
      try { const next = columnChange(definition, groupIndex, 'rename', column, target.attribute_code);
        if (onApply(next) === false) throw new Error('Чернетка змінилася. Повторіть перегляд атрибута.');
      } catch (cause) { setError(cause.message); }
    }}>Зберегти нове призначення в чернетці</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
