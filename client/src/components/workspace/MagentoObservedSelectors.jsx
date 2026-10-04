import { useState } from 'react';
import './category-journeys.css';

export function ObservedCategoryPicker({ categories = [], value = '', onChange, label = 'Розділ магазину', disabled = false }) {
  const [search, setSearch] = useState(''); const [page, setPage] = useState(0);
  const normalized = categories.filter((item) => item.comparable && item.normalizedPath);
  const counts = new Map(); normalized.forEach((item) => counts.set(item.normalizedPath, (counts.get(item.normalizedPath) || 0) + 1));
  const matches = normalized.filter((item) => item.normalizedPath.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  const current = Math.min(page, Math.max(0, Math.ceil(matches.length / 50) - 1));
  return <fieldset disabled={disabled} className="space-y-2"><legend className="font-medium">{label}</legend>
    {value && <p className="category-observed-selection">Обрано: {value.split('/').join(' › ')}</p>}
    <label className="block text-sm">Пошук розділу<input className="input" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
    <div className="category-choice-list" role="group" aria-label={`${label}: варіанти`}>{matches.slice(current * 50, (current + 1) * 50).map((item) => <button type="button" key={item.categoryId} aria-pressed={value === item.normalizedPath} disabled={counts.get(item.normalizedPath) !== 1} onClick={() => onChange(item.normalizedPath)}>{item.normalizedPath.split('/').join(' › ')}{counts.get(item.normalizedPath) !== 1 && ' — неоднозначний шлях'}</button>)}</div>
    {!matches.length && <p className="text-sm">Розділів за цим пошуком немає.</p>}
    {matches.length > 50 && <nav className="category-journey-actions" aria-label="Сторінки розділів магазину"><button type="button" className="btn btn-outline" disabled={!current} onClick={() => setPage(current - 1)}>Назад</button><span>{current + 1} / {Math.ceil(matches.length / 50)}</span><button type="button" className="btn btn-outline" disabled={(current + 1) * 50 >= matches.length} onClick={() => setPage(current + 1)}>Далі</button></nav>}
  </fieldset>;
}

export function ObservedAttributeSetPicker({ sets = [], value = '', onChange, disabled = false }) {
  const [search, setSearch] = useState('');
  const names = sets.map((item) => item.attribute_set_name);
  const matches = sets.filter((item) => item.attribute_set_name?.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  return <fieldset disabled={disabled} className="space-y-2"><legend className="font-medium">Набір характеристик магазину</legend>
    <label className="block text-sm">Пошук набору<input className="input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <label className="block text-sm">Набір характеристик<select className="input" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Оберіть набір</option>{sets.filter((item) => item.attribute_set_name === value || matches.includes(item)).map((item) => <option key={item.attribute_set_id} value={item.attribute_set_name} disabled={names.filter((name) => name === item.attribute_set_name).length !== 1}>{item.attribute_set_name}{names.filter((name) => name === item.attribute_set_name).length !== 1 ? ' — неоднозначна назва' : ''}</option>)}</select></label>
  </fieldset>;
}
