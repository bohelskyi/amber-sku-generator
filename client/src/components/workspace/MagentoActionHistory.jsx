import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';

export default function MagentoActionHistory() {
  const [actions, setActions] = useState(null); const [error, setError] = useState(''); const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration/actions', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setActions(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати історію дій.'); });
    return () => controller.abort();
  }, []);
  return <div className="space-y-3 text-sm">
    <p>Останні збережені дії з ресурсами Magento (до 100). Перевірені записи не є перевіркою поточного стану всієї інтеграції.</p>
    {error && <Notice>{error}</Notice>}{!actions && !error && <LoadingState compact />}
    {actions?.length === 0 && <p>Збережених дій немає.</p>}
    {actions?.slice(page * 20, (page + 1) * 20).map((action) => <article key={action.id} className="border-t py-2">
      <p className="break-words">{action.path || action.label || action.attributeCode} · {action.message}</p>
      <MagentoDetails summary="Свідчення дії">{() => <pre className="text-xs">{JSON.stringify(action, null, 2)}</pre>}</MagentoDetails>
    </article>)}
    {actions?.length > 20 && <nav className="flex flex-wrap gap-2" aria-label="Сторінки історії дій"><button className="btn btn-outline btn-compact-md" disabled={!page} onClick={() => setPage(page - 1)}>Назад</button><span>{page + 1} / {Math.ceil(actions.length / 20)}</span><button className="btn btn-outline btn-compact-md" disabled={(page + 1) * 20 >= actions.length} onClick={() => setPage(page + 1)}>Далі</button></nav>}
  </div>;
}
