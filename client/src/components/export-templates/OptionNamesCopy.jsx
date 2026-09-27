import { copyCurrentOptionLabels } from '../../lib/export-template-option-labels';

export const frozenNamesHelp = 'Поточні назви буде скопійовано в шаблон. Подальші зміни назв у каталозі не змінять цей шаблон автоматично.';

export function OptionNamesCopy({ evidence, entries, onChange, readOnly }) {
  if (readOnly) return null;
  const available = Object.keys(copyCurrentOptionLabels(evidence)).length > 0;
  return <details><summary>Як названо в характеристиці</summary>
    <p>{frozenNamesHelp}</p>
    <p>Після копіювання перегляньте значення у таблиці. Рядки без підтвердженої поточної назви залишаться без змін.</p>
    <button type="button" className="btn btn-outline px-3" disabled={!available} onClick={() => onChange(copyCurrentOptionLabels(evidence, entries))}>Скопіювати поточні назви</button>
    {!available && <p>Поточні назви ще не отримано або не підтверджено. Можна задати власні значення.</p>}
  </details>;
}
