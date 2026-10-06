import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { LoadingState, Notice, EmptyState } from '../ui/index.js';
import MagentoActionHistory from './MagentoActionHistory.jsx';

export default function MagentoChangesWorkspace({ activePublication, history = false, canManage }) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal }).then(({ data: next }) => { if (!controller.signal.aborted) setData(next); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати збережені версії. Оновіть стан сторінки.'); });
    return () => controller.abort();
  }, [activePublication?.id]);
  const revisions = (data?.revisions || []).filter((item) => history ? item.state === 'published' : item.state === 'draft');
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{history ? 'Історія інтеграції' : 'Підготовлені зміни'}</h2><p className="text-sm text-slate-600">{history ? 'Публікації та зафіксовані дії з ресурсами Magento.' : 'Збережені чернетки. Жодна з них не замінює поточні налаштування до окремої публікації.'}</p></div>{canManage && !history && <Link className="btn btn-primary" to="/admin/magento/prepare">Підготувати зміну</Link>}</div>
    {error && <Notice tone="error">{error}</Notice>}{!data && !error && <LoadingState />}
    {data && !revisions.length && <EmptyState>{history ? 'Збережених публікацій немає.' : 'Незавершених чернеток немає. Почніть із потрібної категорії або підготуйте нову зміну.'}</EmptyState>}
    <div className="magento-revision-list">{revisions.map((item) => <div key={item.id} className="magento-revision-row"><div><strong>{history ? `Публікація ${item.version_number}` : `Чернетка · редакція ${item.revision}`}</strong><p>{item.id === activePublication?.id ? 'Використовується зараз' : history ? 'Історична незмінна версія' : item.catalogAvailability?.publicationBlocked ? 'Історична чернетка: тестові ресурси видалені, застосування заблоковано' : 'Потребує перевірки та публікації'}</p><small>{new Date(item.observed_at).toLocaleString('uk-UA')}</small></div>{canManage && <Link className="btn btn-outline" to={`/admin/magento/prepare?draft=${encodeURIComponent(item.id)}`}>{history ? 'Переглянути' : item.catalogAvailability?.publicationBlocked ? 'Переглянути історичну чернетку' : 'Продовжити підготовку'}</Link>}</div>)}</div>
    {history && <section className="space-y-3"><h3 className="font-semibold">Дії з категоріями та значеннями</h3><MagentoActionHistory /></section>}
  </div>;
}
