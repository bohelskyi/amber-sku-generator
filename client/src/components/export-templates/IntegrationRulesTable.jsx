import { useState } from 'react';
import { fieldLabels, protectedCells } from '../../lib/export-template-editor.js';
import { sourceLabel, summary } from '../../lib/export-template-presentation.js';
import './export-template-editor.css';

// Presentation of persisted expressions only. Product results are calculated by
// the server preview; this view deliberately never evaluates a rule in React.
function sourcesFor(definition, expression, seen = new Set(), found = new Set()) {
  if (!expression || typeof expression !== 'object') return found;
  if (expression.op === 'source') found.add(expression.id);
  if (expression.op === 'ref' && !seen.has(expression.id)) {
    sourcesFor(definition, definition.bindings?.find((item) => item.id === expression.id)?.value, new Set([...seen, expression.id]), found);
  }
  for (const value of Object.values(expression)) if (typeof value === 'object') sourcesFor(definition, value, seen, found);
  return found;
}

function policyText(revision, route, column, rowId) {
  if (!revision) return 'Визначається опублікованими відповідностями';
  const keys = (revision.bindings?.attributes || []).filter((item) => item.routeKey.split(/[.:]/)[0] === route
    && item.target === column && item.rowId === rowId).map((item) => item.bindingKey);
  const policies = (revision.bindings?.policies || []).filter((item) => keys.includes(item.bindingKey) && item.reviewState === 'approved');
  const labels = { authoritative_create_update: 'Amber створює та оновлює', initialize_create_only: 'Amber задає лише при створенні', magento_managed: 'Значенням керує Magento' };
  return [...new Set(policies.map((item) => labels[item.policy] || 'Правило потребує перевірки'))].join('; ') || 'Поведінку ще не підтверджено';
}

export function IntegrationRulesTable({ definition, groupIndex, registry, revision, onSelect, readOnly, onCreate }) {
  const [search, setSearch] = useState(''); const [language, setLanguage] = useState(0);
  const group = definition.groups[groupIndex];
  const rowIndex = Math.min(language, group.rows.length - 1); const row = group.rows[rowIndex];
  const columns = group.columns.filter((code) => `${code} ${group.columnLabels?.[code] || fieldLabels[code] || ''}`.toLocaleLowerCase('uk').includes(search.toLocaleLowerCase('uk')));
  return <section className="integration-rules" aria-label={`${group.name || group.route} · правила передачі`}>
    <div className="integration-rules-toolbar">
      <label>Пошук поля<input className="input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Мова<select className="input" value={rowIndex} onChange={(event) => setLanguage(Number(event.target.value))}>{group.rows.map((item, index) => <option key={item.id} value={index}>{item.id === 'english' ? 'English' : 'Основна'}</option>)}</select></label>
      {!readOnly && onCreate && <button type="button" className="btn btn-outline" onClick={onCreate}>Додати поле</button>}
    </div>
    <p className="text-sm text-slate-600">Відкрийте поле, щоб переглянути або змінити його правило. Приклади для товарів обчислює сервер у розділі «Перевірка».</p>
    <table><caption className="sr-only">Поля, джерела Amber та поведінка Magento</caption><thead><tr><th>Поле Magento</th><th>Джерело в Amber</th><th>Правило</th><th>Приклад</th><th>Поведінка в Magento</th></tr></thead>
      <tbody>{columns.map((column) => {
        const expression = row.cells[column]; const sources = [...sourcesFor(definition, expression)];
        return <tr key={column}>
          <th scope="row" data-label="Поле Magento"><button type="button" className="et-link" onClick={() => onSelect(column, rowIndex)}>{group.columnLabels?.[column] || fieldLabels[column] || column}</button><small>{column}</small>{protectedCells.has(column) && <small>Захищене правило</small>}</th>
          <td data-label="Джерело в Amber">{sources.length ? sources.map((id) => sourceLabel(definition, id, registry)).join(', ') : 'У самому правилі'}</td>
          <td data-label="Правило">{summary(definition, expression)}</td>
          <td data-label="Приклад">{expression?.op === 'literal' ? <>{expression.value === '' ? 'Порожній текст' : String(expression.value ?? 'Відсутнє значення')}<small>Постійне значення</small></> : 'Після перевірки товару'}</td>
          <td data-label="Поведінка в Magento">{policyText(revision, group.route, column, row.id)}</td>
        </tr>;
      })}</tbody>
    </table>
    {!columns.length && <p>Полів за цим запитом немає.</p>}
  </section>;
}
