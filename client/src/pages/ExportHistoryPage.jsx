import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { exportsApi } from '../api/exports-api';
import { useAuth } from '../auth/auth-context';
import { StoredResult } from '../components/exports/StoredResult';
import { dateText } from '../lib/export-review-presentation';
import { getApiError } from '../lib/http-error';
import { rangeText } from '../lib/export-session-presentation';
import '../components/exports/export-workspaces.css';

export default function ExportHistoryPage() {
  const { applicationUser, permissions } = useAuth();
  return <HistoryWorkspace key={`${applicationUser?.id}:${permissions.includes('exports.create')}`} />;
}
function HistoryWorkspace() {
  const { permissions, principalLifetime } = useAuth(); const { stream: openedStream, snapshotId } = useParams();
  const [params, setParams] = useSearchParams(); const [data, setData] = useState(null); const [error, setError] = useState('');
  const ticket = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const stream = params.get('stream') || 'all'; const scope = params.get('scope') || 'accessible'; const status = params.get('status') || 'all'; const after = params.get('after');
  const filterKey = JSON.stringify([stream, scope, status, after]);
  useEffect(() => {
    if (snapshotId) return;
    const generation = ++ticket.current; let live = true;
    exportsApi.getHistory({ stream, scope, status, limit: 20, ...(after ? { after } : {}) }).then((response) => {
      if (live && principalLifetime?.valid !== false && generation === ticket.current) { setData({ ...response.data, filterKey }); setError(''); }
    }).catch((e) => { if (live && principalLifetime?.valid !== false) { setData(null); setError(getApiError(e)); } });
    return () => { live = false; };
  }, [stream, scope, status, after, snapshotId, principalLifetime, refresh, filterKey]);
  if (snapshotId) return <><Link className="underline" to={'/exports/history?' + params.toString()}>← Історія файлів</Link>
    {['product', 'price'].includes(openedStream) ? <StoredResult key={`${openedStream}:${snapshotId}`} id={snapshotId} stream={openedStream} canCreate={permissions.includes('exports.create')} /> : <p>Невідомий потік експорту.</p>}</>;
  const filter = (key, value) => { const next = new URLSearchParams(params); next.set(key, value); next.delete('after'); setData(null); setParams(next); };
  const visible = data?.filterKey === filterKey ? data : null;
  return <section className="space-y-4"><div className="flex flex-wrap justify-between gap-3"><h2 className="text-xl font-semibold">Історія файлів</h2>
    <button className="btn btn-outline px-3" onClick={() => { setData(null); setError(''); setRefresh((n) => n + 1); }}>Оновити список</button></div>
    <div className="flex flex-wrap gap-3">
      <label>Потік<select className="input" value={stream} onChange={(e) => filter('stream', e.target.value)}><option value="all">Усі потоки</option><option value="product">Товари</option><option value="price">Ціни</option></select></label>
      <label>Доступ<select className="input" value={scope} onChange={(e) => filter('scope', e.target.value)}><option value="accessible">Доступні мені</option><option value="mine">Створені мною</option></select></label>
      <label>Стан<select className="input" value={status} onChange={(e) => filter('status', e.target.value)}><option value="all">Усі стани</option><option value="generated">Очікують підтвердження</option><option value="confirmed">Завершені</option></select></label>
    </div>
    {error && <p role="alert">{error}</p>}{!visible && !error && <p role="status">Завантаження історії…</p>}
    {visible?.items.length === 0 && <p>Збережених файлів за цими умовами немає.</p>}
    <ul className="export-workspace-list">{visible?.items.map((item) => <li key={`${item.stream}:${item.id}`} className="export-workspace-row">
      <div className="export-workspace-identity"><h3>{item.stream === 'price' ? 'Ціни · sku,price' : 'Товари'}</h3><span className="export-workspace-status">{item.status === 'confirmed' ? 'Завершено' : 'Файли створено'}</span>
        <p>{item.createdByUserId == null ? 'Автор невідомий' : `Автор: ${item.createdByName || 'ім’я недоступне'}`}</p>
        {item.sessionId && item.sessionTitle && <Link className="underline" to={'/exports/sessions/' + encodeURIComponent(item.sessionId)}>{item.sessionTitle}</Link>}
        <p>{item.template ? `${item.templateLabel?.displayName || 'Шаблон'} · v${item.templateLabel?.versionNumber || 'Немає даних'}` : item.recipe?.name}</p></div>
      <div className="export-workspace-meta"><p>Створено: {dateText(item.generatedAt)}</p>
        <p>Товарів: {item.productCount} · Рядків CSV: {item.csvRowCount ?? 'Немає даних'}</p>
        {item.capturedRange && <p>У файлах: {rangeText(item.capturedRange)}</p>}
        <p>{item.artifacts.length ? `Доступних файлів: ${item.artifacts.length}` : 'Історичні файли Magento недоступні'}</p>
        <p>{item.confirmedAt ? `Підтверджено: ${dateText(item.confirmedAt)}` : 'Очікує підтвердження'}</p></div>
      <div className="export-workspace-open"><Link className="btn btn-outline px-3" to={`/exports/history/${item.stream}/${encodeURIComponent(item.id)}?${params.toString()}`}>Відкрити {item.stream === 'price' ? 'ціни' : 'товари'} від {dateText(item.generatedAt)}</Link>
        <details><summary>Технічні подробиці</summary><p>{item.id}</p><p>ID автора: {item.createdByUserId ?? 'Немає даних'}</p></details></div>
    </li>)}</ul>
    <div className="flex gap-3">{after && <button onClick={() => filter('scope', scope)}>До початку</button>}{visible?.next && <button onClick={() => { const next = new URLSearchParams(params); next.set('after', visible.next); setData(null); setParams(next); }}>Наступні 20</button>}</div>
  </section>;
}
