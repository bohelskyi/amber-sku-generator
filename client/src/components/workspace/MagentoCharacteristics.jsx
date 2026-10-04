import { useState } from 'react';
import { Link } from 'react-router-dom';
import './category-journeys.css';

export default function MagentoCharacteristics({ questions, values, targets, definition, revision, actionFor, catalogPath }) {
  const [search, setSearch] = useState(''); const [page, setPage] = useState(0);
  if (!Array.isArray(questions)) return null;
  const rows = questions.filter((question) => `${question.label} ${question.id}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 30) - 1));
  return <section className="space-y-3" aria-label="Характеристики категорії">
    <label className="block text-sm">Пошук характеристики<input className="input" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
    <table className="category-characteristics-table"><caption className="sr-only">Характеристики товару та поля магазину</caption><thead><tr><th>Характеристика товару</th><th>Поле магазину</th><th>Стан</th><th>Дія</th></tr></thead><tbody>{rows.slice(current * 30, (current + 1) * 30).map((question) => {
      const mappings = values.filter((value) => value.questionKey === question.id);
      const fields = [...new Set([...(targets[question.id] || []), ...mappings.flatMap((value) => value.mappings.map((mapping) => mapping.attribute).filter(Boolean))])];
      const labels = fields.map((code) => revision?.schema?.attributes?.find((item) => item.attribute_code === code)?.default_frontend_label || code);
      const unresolved = mappings.filter((value) => !['approved', 'not_applicable'].includes(value.state)).length;
      const text = question.input_type === 'text';
      return <tr key={question.id}><th scope="row" data-label="Характеристика товару">{question.label}<small>{text ? 'Текстове поле' : `Варіантів у каталозі: ${question.options?.length || 0}`}</small></th>
        <td data-label="Поле магазину">{fields.length ? [...new Set(labels)].join(', ') : definition ? 'Не передається за чинними правилами' : 'Правила ще не прочитано'}</td>
        <td data-label="Стан">{unresolved ? `Значень без підтвердження: ${unresolved}` : fields.length ? text ? 'Правило задано; перевірте значення товару' : 'Перегляньте значення нижче' : 'Підключення не підтверджено'}</td>
        <td data-label="Дія">{actionFor && <Link className="underline" to={actionFor(question, fields)}>{text ? 'Налаштувати передачу' : 'Додати варіант'}</Link>}{catalogPath && <Link className="block underline text-sm mt-2" to={`${catalogPath}&question=${encodeURIComponent(question.id)}&action=edit-question`}>Редагувати характеристику</Link>}</td></tr>;
    })}</tbody></table>
    {!rows.length && <p>Характеристик за цим пошуком немає.</p>}
    {rows.length > 30 && <nav className="category-journey-actions" aria-label="Сторінки характеристик"><button className="btn btn-outline" disabled={!current} onClick={() => setPage(current - 1)}>Назад</button><span>{current + 1} / {Math.ceil(rows.length / 30)}</span><button className="btn btn-outline" disabled={(current + 1) * 30 >= rows.length} onClick={() => setPage(current + 1)}>Далі</button></nav>}
  </section>;
}
