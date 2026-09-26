import { SearchablePicker } from './SearchablePicker';
import { availableSources } from '../../lib/export-template-columns';
import { sourceLabel } from '../../lib/export-template-presentation';

import { categoryNames } from '../../lib/export-template-categories';

// Discovery is restricted to the authorized registry. Existing unknown selections
// remain visible, but cannot be selected as new sources.
export function SourcePicker({ registry, group, value, onChange, disabled, label = 'Характеристика', choices: supplied, required = false, showDetails = true }) {
  const choices = supplied || availableSources(registry, group);
  const readable = (entry) => {
    const source = entry.descriptor;
    const name = sourceLabel({ sources: { [entry.id]: source } }, entry.id, registry);
    return `${categoryNames[source.category] || 'Товар'} → ${name}`;
  };
  const selected = choices.find((entry) => entry.id === value);
  const identity = (entry) => JSON.stringify(['kind', 'category', 'key', 'field', 'type'].map((key) => entry.descriptor[key]));
  const distinct = choices.filter((entry, index) => selected && identity(entry) === identity(selected) ? entry === selected : choices.findIndex((other) => identity(other) === identity(entry)) === index);
  return <div className="et-source-picker">
    <SearchablePicker label={label} options={distinct.map((entry) => ({ value: entry.id, label: readable(entry) }))} value={value} onChange={onChange} disabled={disabled} required={required} unknownLabel="Збережена характеристика поза доступним реєстром" />
    {selected && <><small className="et-muted">{({ semantic: 'Вибір із варіантів характеристики', information: 'Збережений текст або значення характеристики', product: 'Значення з товару' })[selected.descriptor.kind]}</small>
      {showDetails && <details><summary>Технічні подробиці характеристики</summary><code>{selected.id} · {selected.descriptor.type}</code></details>}</>}
  </div>;
}
