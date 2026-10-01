import { useEffect, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';

const labels = { update: 'Оновлення товарів', replacement: 'Погоджені заміни', hold: 'Очікують звірки' };
const reasons = { prior_exposure: 'Потрібна звірка попередніх файлів і SKU', historical_ambiguity: 'Історію експорту не з’ясовано',
  intentional_exclusion: 'Окреме бізнес-виключення', invalid_lineage: 'Потрібна перевірка ланцюга виправлень' };
export function FullProductQueues({ lifecycle, onPreview, disabled }) {
  const [queue, setQueue] = useState('update');
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    exportsApi.getQueue({ queue, after }).then(({ data }) => { if (live) { setPage(data); setError(''); } })
      .catch((cause) => { if (live) setError(getApiError(cause)); });
    return () => { live = false; };
  }, [queue, after, lifecycle]);
  return <div className="border-b p-4 space-y-3">
    <p className="text-sm">Перша доставка: {lifecycle.counts.firstDelivery} · Оновлення: {lifecycle.counts.fullUpdate} · Заміни: {lifecycle.counts.replacementReady} · На звірці: {lifecycle.counts.held}</p>
    <label className="text-sm">Черга <select className="input" value={queue} onChange={(e) => { setQueue(e.target.value); setAfter(0); setPage(null); }}>
      {Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {error && <p role="alert">{error}</p>}
    {page?.items.length === 0 && <p className="text-sm text-slate-600">У цій черзі немає товарів.</p>}
    <ul className="divide-y">{page?.items.map((p) => <li key={p.id} className="py-2 flex flex-wrap gap-3 justify-between text-sm">
      <span>{p.public_sku || p.full_sku}{p.public_sku && p.public_sku !== p.full_sku ? ` · внутрішній ${p.full_sku}` : ''}{p.magento_name_review_required ? ' · Потрібна перевірка назв' : ''}</span>
      {queue === 'hold' ? <span>{reasons[p.hold_reason] || 'Потрібне рішення щодо виключення'}</span>
        : <button className="btn btn-outline px-3" disabled={disabled} onClick={() => onPreview(queue === 'replacement'
          ? { mode:'replacement', productId:p.id, deliveryVersion:p.delivery_version }
          : { fromSku:p.public_sku || p.full_sku, toSku:p.public_sku || p.full_sku })}>Перевірити товар</button>}
    </li>)}</ul>
    {after > 0 && <button className="btn px-3" onClick={() => { setAfter(0); setPage(null); }}>На початок</button>}
    {page?.next && <button className="btn px-3" onClick={() => { setAfter(page.next); setPage(null); }}>Наступні</button>}
  </div>;
}
