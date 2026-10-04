import { useState } from 'react';
import { Link } from 'react-router-dom';
import MagentoDetails from './MagentoDetails.jsx';
import './category-journeys.css';

const labels = { approved: 'Підтверджено', not_applicable: 'Не застосовується', blocked: 'Рішення / обмеження', candidate: 'Потрібна перевірка', missing: 'Відсутня відповідність', ambiguous: 'Потрібно уточнити', drifted: 'Потрібна повторна перевірка' };
const ROW_LIMIT = 50;
const GROUP_LIMIT = 20;

function MappingRow({ value, targetFields = [], actionFor }) {
  const targets = value.mappings || [];
  return <article className="py-3 category-mapping-row">
    <div><p className="font-medium">{value.questionLabel}: {value.label}</p><small>Значення в Amber</small></div>
    <div>{targets.length ? targets.map((mapping, index) => <p key={index}>{mapping.optionLabel || 'Значення ще не обрано'}<small>{mapping.attribute || 'Атрибут ще не визначено'}</small></p>)
      : <p>Не пов’язано<small>{targetFields.length ? `Поле правила: ${targetFields.join(', ')}` : 'Поле Magento ще не визначено'}</small></p>}</div>
    <div><p className="text-sm">{labels[value.state] || 'Потрібна перевірка'}</p>{actionFor && value.state !== 'not_applicable' && <Link className="underline text-sm" to={actionFor(value, targetFields)}>{value.state === 'approved' ? 'Переглянути відповідність' : 'Налаштувати відповідність'}</Link>}</div>
    <div className="category-mapping-evidence"><MagentoDetails>{() => <><p>value_id: {value.valueId} · sku_code: {value.skuCode}</p>{targets.map((mapping, index) => <p key={index}>{mapping.routeKey} · {mapping.attribute} · Magento ID {mapping.optionId ?? '—'} · {mapping.optionLabel}</p>)}</>}</MagentoDetails></div>
  </article>;
}

function Pages({ page, count, limit, onChange, label }) {
  if (count <= limit) return null;
  return <nav className="flex flex-wrap gap-3" aria-label={label}>
    <button type="button" className="btn btn-outline btn-compact-md" disabled={!page} onClick={() => onChange(page - 1)}>Назад</button>
    <span>{page + 1} / {Math.ceil(count / limit)}</span>
    <button type="button" className="btn btn-outline btn-compact-md" disabled={(page + 1) * limit >= count} onClick={() => onChange(page + 1)}>Далі</button>
  </nav>;
}

export default function MagentoMappingBrowser({ values, field = '', catalogPath, targetsByQuestion = {}, actionFor, optionActionFor }) {
  const [all, setAll] = useState(Boolean(field));
  const [search, setSearch] = useState('');
  const [context, setContext] = useState(field);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const [rowPage, setRowPage] = useState(0);
  const reset = () => { setPage(0); setOpen(null); setRowPage(0); };
  const term = search.trim().toLocaleLowerCase('uk');
  const visible = values.filter((value) => (all || ['missing', 'candidate', 'ambiguous', 'drifted'].includes(value.state))
    && (!context || value.mappings.some((mapping) => mapping.attribute === context) || targetsByQuestion[value.questionKey]?.includes(context))
    && (!term || [value.questionLabel, value.label, value.questionKey,
      ...(targetsByQuestion[value.questionKey] || []), ...value.mappings.flatMap((mapping) => [mapping.attribute, mapping.routeKey, mapping.optionLabel])]
      .some((text) => String(text ?? '').toLocaleLowerCase('uk').includes(term))));
  const groups = new Map();
  for (const value of visible) {
    const targets = [...new Set([...value.mappings.map((mapping) => mapping.attribute).filter(Boolean), ...(targetsByQuestion[value.questionKey] || [])])].sort();
    const key = JSON.stringify([value.questionKey, targets]);
    if (!groups.has(key)) groups.set(key, { key, label: value.questionLabel, questionKey: value.questionKey, targets, values: [] });
    groups.get(key).values.push(value);
  }
  const grouped = [...groups.values()];
  const count = all ? grouped.length : visible.length;
  const limit = all ? GROUP_LIMIT : ROW_LIMIT;
  const current = Math.min(page, Math.max(0, Math.ceil(count / limit) - 1));
  return <div className="space-y-3">
    <button type="button" className="btn btn-outline btn-compact-md" aria-pressed={all} onClick={() => { setAll(!all); setContext(''); setSearch(''); reset(); }}>{all ? 'Показати лише питання' : 'Показати всі відповідності'}</button>
    {all && <>
      {context && <p className="text-sm">Відповідності для <strong>{context}</strong> <button type="button" className="underline" onClick={() => { setContext(''); reset(); }}>Зняти фільтр поля</button></p>}
      <label className="block text-sm">Пошук відповідностей
        <input className="input mt-1 w-full" type="search" value={search} placeholder="Питання, значення, ключ або атрибут Magento" onChange={(event) => { setSearch(event.target.value); reset(); }} />
      </label>
      <p className="text-sm text-slate-600">Знайдено значень: {visible.length} · Груп: {grouped.length}. Відкрийте групу для перегляду.</p>
    </>}
    {!visible.length && <p className="text-sm">{all ? 'Відповідностей за цим фільтром немає.' : 'Немає невирішених відповідностей у цьому перегляді. Переглянуті відмови доступні серед усіх відповідностей.'}</p>}
    {all ? <div className="divide-y">{grouped.slice(current * limit, (current + 1) * limit).map((group) => <section className="py-2" key={group.key}>
      <button type="button" className="text-left font-medium break-words" aria-expanded={open === group.key} onClick={() => { setOpen(open === group.key ? null : group.key); setRowPage(0); }}>
        {group.label} · {group.questionKey}{group.targets.length > 0 && ` → ${group.targets.join(', ')}`} · {group.values.length}
      </button>
      {open === group.key && <div className="divide-y pl-3">
        {(optionActionFor || catalogPath) && <p className="py-2 text-sm"><Link className="underline" to={optionActionFor ? optionActionFor(group) : `${catalogPath}&question=${encodeURIComponent(group.questionKey)}&action=new-option`}>Додати значення: {group.label}</Link></p>}
        {group.values.slice(rowPage * ROW_LIMIT, (rowPage + 1) * ROW_LIMIT).map((value) => <MappingRow key={`${value.questionKey}:${value.valueId}`} value={value} targetFields={targetsByQuestion[value.questionKey]} actionFor={actionFor} />)}
        <Pages page={rowPage} count={group.values.length} limit={ROW_LIMIT} onChange={setRowPage} label="Сторінки значень групи" />
      </div>}
    </section>)}</div> : <div className="divide-y">{visible.slice(current * limit, (current + 1) * limit).map((value) => <MappingRow key={`${value.questionKey}:${value.valueId}`} value={value} targetFields={targetsByQuestion[value.questionKey]} actionFor={actionFor} />)}</div>}
    <Pages page={current} count={count} limit={limit} onChange={(next) => { setPage(next); setOpen(null); setRowPage(0); }} label={all ? 'Сторінки груп відповідностей' : 'Сторінки відповідностей'} />
  </div>;
}
