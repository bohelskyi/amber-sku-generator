import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { exportsApi } from '../api/exports-api';
import { useAuth } from '../auth/auth-context';
import { StoredResult } from '../components/exports/StoredResult';
import { dateText } from '../lib/export-review-presentation';
import { getApiError } from '../lib/http-error';
import { rangeText } from '../lib/export-session-presentation';
import { Button, EmptyState, LoadingState, Notice, Pagination, SectionHeader, StatusBadge, TableShell, TechnicalDisclosure } from '../components/ui';
import '../components/exports/export-workspaces.css';

export default function ExportHistoryPage() {
  const { applicationUser, permissions } = useAuth();
  return <HistoryWorkspace key={`${applicationUser?.id}:${permissions.includes('exports.create')}`} />;
}
function HistoryWorkspace() {
  const { permissions, principalLifetime } = useAuth(); const { stream: openedStream, snapshotId } = useParams();
  const [params, setParams] = useSearchParams(); const [data, setData] = useState(null); const [error, setError] = useState('');
  const location = useLocation();
  const back = Array.isArray(location.state?.exportHistoryBack) ? location.state.exportHistoryBack : [];
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
  if (snapshotId) return <><Link className="underline" to={'/exports/history?' + params.toString()} state={location.state}>← Історія файлів</Link>
    {['product', 'price'].includes(openedStream) ? <StoredResult key={`${openedStream}:${snapshotId}`} id={snapshotId} stream={openedStream} canCreate={permissions.includes('exports.create')} /> : <p>Невідомий потік експорту.</p>}</>;
  const filter = (key, value) => { const next = new URLSearchParams(params); next.set(key, value); next.delete('after'); setData(null); setError(''); setParams(next, { state: { exportHistoryBack: [] } }); };
  const changePage = (cursor, previous) => {
    const next = new URLSearchParams(params);
    if (cursor) next.set('after', cursor); else next.delete('after');
    setData(null); setError(''); setParams(next, { state: { exportHistoryBack: previous } });
  };
  const visible = data?.filterKey === filterKey ? data : null;
  return <section className="space-y-4"><SectionHeader title="Історія файлів" description="Збережені файли товарів і цін. Підтвердження в Amber не є результатом імпорту в Magento."
    actions={<Button onClick={() => { setData(null); setError(''); setRefresh((n) => n + 1); }}>Оновити список</Button>} />
    <div className="flex flex-wrap gap-3">
      <label>Потік<select className="input" value={stream} onChange={(e) => filter('stream', e.target.value)}><option value="all">Усі потоки</option><option value="product">Товари</option><option value="price">Ціни</option></select></label>
      <label>Доступ<select className="input" value={scope} onChange={(e) => filter('scope', e.target.value)}><option value="accessible">Доступні мені</option><option value="mine">Створені мною</option></select></label>
      <label>Стан<select className="input" value={status} onChange={(e) => filter('status', e.target.value)}><option value="all">Усі стани</option><option value="generated">Очікують підтвердження</option><option value="confirmed">Завершені</option></select></label>
    </div>
    {error && <Notice tone="error">{error}</Notice>}{!visible && !error && <LoadingState compact label="Завантаження історії…" />}
    {visible?.items.length === 0 && <EmptyState compact>Збережених файлів за цими умовами немає.</EmptyState>}
    {visible?.items.length > 0 && <TableShell><table className="dense-table export-history-table">
      <caption className="sr-only">Історія збережених файлів</caption>
      <thead><tr className="table-head"><th scope="col">Створено</th><th scope="col">Файл і стан</th><th scope="col">Обсяг</th><th scope="col">Автор</th><th scope="col">Дії</th></tr></thead>
      <tbody>{visible.items.map((item) => <tr key={`${item.stream}:${item.id}`}>
        <td data-label="Створено"><time dateTime={item.generatedAt}>{dateText(item.generatedAt)}</time></td>
        <td data-label="Файл і стан"><strong>{item.stream === 'price' ? 'Ціни · sku,price' : 'Товари'}</strong>
          <StatusBadge tone={item.status === 'confirmed' ? 'success' : 'neutral'}>{item.status === 'confirmed' ? 'Підтверджено в Amber' : 'Файли створено'}</StatusBadge>
          {!item.artifacts?.length && <span className="text-xs text-slate-500">Історичні файли Magento недоступні</span>}
          {item.sessionId && item.sessionTitle && <Link className="underline" to={'/exports/sessions/' + encodeURIComponent(item.sessionId)}>{item.sessionTitle}</Link>}</td>
        <td data-label="Обсяг"><span>Товарів: {item.productCount ?? 'Немає даних'}</span><span>Рядків CSV: {item.csvRowCount ?? 'Немає даних'}</span></td>
        <td data-label="Автор">{item.createdByUserId == null ? 'Автор невідомий' : item.createdByName || 'Ім’я недоступне'}</td>
        <td data-label="Дії"><Link className="btn btn-outline btn-compact-md" state={location.state}
          aria-label={`Відкрити ${item.stream === 'price' ? 'ціни' : 'товари'} від ${dateText(item.generatedAt)}`}
          to={`/exports/history/${item.stream}/${encodeURIComponent(item.id)}?${params.toString()}`}>Відкрити</Link>
          <TechnicalDisclosure summary="Деталі файлу">
            <p>{item.template ? `${item.templateLabel?.displayName || 'Шаблон'} · v${item.templateLabel?.versionNumber || 'Немає даних'}` : item.recipe?.name}</p>
            {item.capturedRange && <p>У файлах: {rangeText(item.capturedRange)}</p>}
            {item.artifacts?.length > 0 && <p>Доступних файлів: {item.artifacts.length}</p>}
            <p>{item.confirmedAt ? `Підтверджено: ${dateText(item.confirmedAt)}` : 'Очікує підтвердження'}</p>
            <p>ID експорту: {item.id}</p><p>ID автора: {item.createdByUserId ?? 'Немає даних'}</p>
          </TechnicalDisclosure></td>
      </tr>)}</tbody>
    </table></TableShell>}
    <Pagination label="Сторінки історії файлів" hasPrevious={Boolean(after)} hasNext={Boolean(visible?.next)}
      busy={!visible && !error} previousLabel={back.length ? 'Попередні 20' : 'До початку'} nextLabel="Наступні 20"
      summary={visible?.items.length ? `На сторінці: ${visible.items.length}` : undefined}
      onPrevious={() => changePage(back.at(-1) || '', back.slice(0, -1))}
      onNext={() => changePage(visible.next, [...back, after || ''])} />
  </section>;
}
