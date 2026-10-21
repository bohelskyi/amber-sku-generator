import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { getAuditActorLabel } from '../../lib/audit-viewer.js';

export function AuditActorFilter({ actorId, onChange }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState({ query: '', items: [], error: false });
  useEffect(() => {
    if (actorId || selected || query.trim().length < 2) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api.get('/admin/audit-events/actors', { params: { q: query.trim() } }).then(({ data }) => {
        if (live) setResult({ query, items: data.items || [], error: false });
      }).catch(() => { if (live) setResult({ query, items: [], error: true }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, actorId, selected]);
  const searching = !actorId && !selected && query.trim().length >= 2;
  const visibleQuery = actorId ? selected?.id === String(actorId) ? selected.label : `Користувач #${actorId}` : selected ? '' : query;
  return <div className="audit-actor-filter">
    <label className="text-sm font-medium text-slate-600">Виконавець
      <input className="input-sm mt-1" type="search" placeholder="Ім’я або логін" value={visibleQuery}
        onChange={(event) => { setSelected(null); setQuery(event.target.value); onChange(''); }} />
    </label>
    {actorId && <button type="button" className="text-sm underline" onClick={() => { setSelected(null); setQuery(''); onChange(''); }}>Усі виконавці</button>}
    {searching && result.query === query && <div className="audit-actor-results">
      {result.items.map((actor) => <button type="button" key={actor.id} onClick={() => {
        const label = getAuditActorLabel(actor);
        setSelected({ id: String(actor.id), label }); onChange(String(actor.id)); setQuery(label);
      }}>{getAuditActorLabel(actor)} <span>#{actor.id}</span></button>)}
      {!result.items.length && <p role="status">{result.error ? 'Не вдалося знайти виконавців. Змініть запит, щоб повторити.' : 'У журналі такого виконавця не знайдено.'}</p>}
    </div>}
  </div>;
}
