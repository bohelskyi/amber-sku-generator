import { useState } from 'react';
import { Scalar } from './AdvancedDefinitionEditor';
import { optionEvidence } from '../../lib/export-template-attributes';
import { currentOptionIds, optionDisplayLabel } from '../../lib/export-template-option-labels';
import { SourceSupportEvidence } from './SourceSupportStatus';

export function MappingTableEditor({ entries, onChange, ids = [], evidence, support, readOnly, strictText = false, showEvidence = true, technical = true }) {
  const [newId, setNewId] = useState('');
  const values = [...new Set([...Object.keys(entries), ...ids.map(String), ...currentOptionIds(evidence)])];
  return <div className="et-mapping">
    <div className="et-table-scroll"><table aria-label="Відповідності для колонки"><thead><tr><th>Значення характеристики</th><th>Значення у CSV</th>{!readOnly && <th>Дії</th>}</tr></thead>
      <tbody>{values.map((id) => <tr key={id}><th scope="row"><span>{optionDisplayLabel(evidence, id)}</span>
        {support?.deferredValues?.includes(id) && <small>Ще не підтримується цією версією шаблону</small>}
      </th><td>
        {Object.hasOwn(entries, id) ? <>
          {strictText && typeof entries[id] !== 'string' ? <p>Некоректний тип відповідності: <code>{JSON.stringify(entries[id])}</code>. Збережено без перетворення; виправлення — у розширених правилах.</p>
            : <Scalar value={entries[id]} fixedType labelHidden disabled={readOnly} label={`Значення у CSV: ${optionDisplayLabel(evidence, id)}`} onChange={(value) => onChange({ ...entries, [id]: value })} />}
          {entries[id] === '' && <span>Порожня клітинка</span>}{entries[id] === null && <span>null — не порожній текст</span>}
        </> : <span>Відповідності немає</span>}
      </td>{!readOnly && <td>{Object.hasOwn(entries, id)
        ? <button type="button" className="et-link" aria-label={`Вилучити: ${optionDisplayLabel(evidence, id)}`} onClick={() => onChange(Object.fromEntries(Object.entries(entries).filter(([key]) => key !== id)))}>Вилучити</button>
        : <button type="button" className="et-link" aria-label={`Додати текст: ${optionDisplayLabel(evidence, id)}`} onClick={() => onChange({ ...entries, [id]: '' })}>Додати текст</button>}</td>}</tr>)}</tbody>
    </table></div>
    {showEvidence && <details><summary>Подробиці джерела</summary>
      <SourceSupportEvidence policy={support} />
      {values.map((id) => { const { current, historical } = optionEvidence(evidence, id); return <div key={id}>
        <p>ID {id} · {optionDisplayLabel(evidence, id)}</p>
        {current.map((entry, i) => <p key={'c' + i}>Поточний каталог: {entry.label} · SKU-код {entry.sku_code ?? 'не вказано'}</p>)}
        {historical.map((entry, i) => <p key={'h' + i}>Історична схема v{entry.version}: {entry.label}{entry.archived ? ' · архівний варіант' : ''}</p>)}
      </div>; })}
      {evidence?.truncated && <p>Показано частину метаданих. Відсутність значення тут не означає відсутності історичного підтвердження.</p>}
      <p>Назви допомагають налаштувати текст. Підтримку значень для експорту перевіряє сервер окремо.</p>
    </details>}
    {technical && !readOnly && <details><summary>Технічне додавання за ID</summary><label>ID характеристики<input className="input" value={newId} onChange={(e) => setNewId(e.target.value)} /></label>
      <button type="button" className="btn btn-outline px-3" disabled={!newId || Object.hasOwn(entries, newId) || ['__proto__', 'constructor', 'prototype'].includes(newId)} onClick={() => { onChange({ ...entries, [newId]: '' }); setNewId(''); }}>Додати відповідність</button></details>}
    <p className="et-muted">Назви — довідкові підказки. Текст CSV не підставляється з каталогу автоматично.</p>
  </div>;
}

