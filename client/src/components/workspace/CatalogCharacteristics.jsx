import { useState } from 'react';
import { characteristicUses } from '../../lib/catalog-characteristics.js';

export default function CatalogCharacteristics({ questions = [], definition, categoryCode, rowId = 'base', attributes = [], canEdit, canConnect, disabled, selectedQuestion, onEdit, onConnect, onField }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const uses = characteristicUses(definition, categoryCode, questions);
  const ordered = [...questions.filter((question) => question.id === selectedQuestion), ...questions.filter((question) => question.id !== selectedQuestion)];
  const filtered = ordered.filter((question) => `${question.label} ${question.id}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const label = (target) => attributes.find((attribute) => attribute.target === target)?.label || target;
  return <section className="space-y-3" aria-label="Характеристики Менеджера">
    <div className="mc-actions"><label className="mc-label">Пошук характеристики<input className="input" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
      {canEdit && <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => onEdit({ initialAction: 'new-question' })}>Додати характеристику</button>}</div>
    <div className="mc-table-scroll"><table className="mc-field-table catalog-characteristics-table"><thead><tr><th>Характеристика Менеджера</th><th>Передавання в магазин</th><th>Дії</th></tr></thead>
      <tbody>{filtered.slice(currentPage * 25, (currentPage + 1) * 25).map((question) => {
        const all = (uses.get(question.id) || []).filter((use) => use.rowId === rowId);
        const direct = [...new Set(all.filter((use) => use.kind === 'attribute').map((use) => use.target))];
        const indirect = [...new Set(all.filter((use) => use.kind !== 'attribute').map((use) => use.kind === 'condition' ? 'в умовах' : use.kind === 'text' ? 'у назвах та SEO' : 'у розміщенні'))];
        return <tr key={question.id} className={selectedQuestion === question.id ? 'is-repair-target' : undefined}>
          <th scope="row">{canEdit ? <button type="button" className="mc-field-link" disabled={disabled} onClick={() => onEdit({ questionKey: question.id })}>{question.label}</button> : question.label}
            <small>{question.archived ? 'В архіві' : question.input_type === 'options' || question.options?.length ? `Значень: ${question.options?.length || 0}` : question.input_type === 'number' ? 'Число' : 'Текст'}</small></th>
          <td>{direct.length ? direct.map((target) => <div key={target}><button type="button" className="mc-field-link" disabled={disabled} onClick={() => onField?.(target)}>{label(target)}</button>{attributes.find((attribute) => attribute.target === target)?.state === 'review' && <small>Потрібна перевірка відповідності</small>}</div>) : <span>Лише Менеджер</span>}
            {indirect.length > 0 && <small>Використовується {indirect.join(', ')}</small>}</td>
          <td>{canConnect && !question.archived && <button type="button" className="btn btn-outline" disabled={disabled} onClick={() => onConnect({ questionKey: question.id })}>{direct.length ? 'Налаштувати передавання' : 'Пов’язати з Magento'}</button>}</td>
        </tr>;
      })}</tbody></table></div>
    {!filtered.length && <p>{search ? 'Характеристик за цим пошуком немає.' : 'Додайте першу характеристику цієї категорії.'}</p>}
    {filtered.length > 25 && <nav className="mc-actions" aria-label="Сторінки характеристик"><button type="button" className="btn btn-outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage + 1} / {Math.ceil(filtered.length / 25)}</span><button type="button" className="btn btn-outline" disabled={(currentPage + 1) * 25 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Далі</button></nav>}
  </section>;
}
