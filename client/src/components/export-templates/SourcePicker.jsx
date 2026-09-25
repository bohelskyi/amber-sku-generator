import { useId, useState } from 'react';
import { availableSources } from '../../lib/export-template-columns';
import { sourceLabel } from '../../lib/export-template-presentation';

import { categoryNames } from '../../lib/export-template-categories';

// Discovery is restricted to the authorized registry. Existing unknown selections
// remain visible, but cannot be selected as new sources.
export function SourcePicker({ registry, group, value, onChange, disabled, label = 'Характеристика', choices: supplied, required = false, showDetails = true }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const choices = supplied || availableSources(registry, group);
  const readable = (entry) => {
    const source = entry.descriptor;
    const name = sourceLabel({ sources: { [entry.id]: source } }, entry.id, registry);
    return `${categoryNames[source.category] || 'Товар'} → ${name}`;
  };
  const selected = choices.find((entry) => entry.id === value);
  const matches = choices.filter((entry) => entry.id === value || `${readable(entry)} ${entry.id}`.toLocaleLowerCase('uk').includes(query.toLocaleLowerCase('uk')));
  const groups = [...new Set(matches.map((entry) => entry.descriptor.category || 'product'))];
  return <div className="et-source-picker">
    <label htmlFor={id + '-search'}>Пошук характеристики</label>
    <input id={id + '-search'} type="search" className="input" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} placeholder="Наприклад, колір" />
    <label htmlFor={id}>{label}</label>
    <select id={id} className="input" required={required} disabled={disabled} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">Оберіть характеристику</option>
      {!selected && value && <option value={value} disabled>{showDetails ? value + ' · ' : ''}Збережена характеристика поза доступним реєстром</option>}
      {groups.map((key) => <optgroup key={key} label={categoryNames[key] || 'Товар'}>{matches.filter((entry) => (entry.descriptor.category || 'product') === key).map((entry) => <option key={entry.id} value={entry.id}>{readable(entry)}</option>)}</optgroup>)}
    </select>
    {selected && <><small className="et-muted">{({ semantic: 'Вибір із варіантів характеристики', information: 'Збережений текст або значення характеристики', product: 'Значення з товару' })[selected.descriptor.kind]}</small>
      {showDetails && <details><summary>Технічні подробиці характеристики</summary><code>{selected.id} · {selected.descriptor.type}</code></details>}</>}
    {!matches.length && <p>Немає доступних характеристик за цим запитом.</p>}
  </div>;
}
