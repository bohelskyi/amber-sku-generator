import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AppPageHeader, EmptyState, LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { ProductNameConflict } from '../components/app/ProductNameConflict.jsx';

export default function SyncProblemsPage() {
  const [items, setItems] = useState(null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true; const controller = new AbortController();
    const read = () => { if (!document.hidden) api.get('/magento/problems', { signal: controller.signal })
      .then(({ data }) => { if (live) { setItems(data); setError(''); } })
      .catch(() => { if (live) setError('Не вдалося завантажити проблеми синхронізації.'); }); };
    read(); const timer = window.setInterval(read, 15000); window.addEventListener('focus', read);
    return () => { live = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', read); };
  }, [refresh]);
  return <main className="app-page"><div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <AppPageHeader title="Проблеми синхронізації" description="Товари, для яких потрібна дія перед завершенням синхронізації Magento." />
    {error && <Notice>{error}</Notice>}
    {!items && !error && <LoadingState />}
    {items?.length === 0 && <EmptyState>Невирішених проблем немає.</EmptyState>}
    {items?.map((item) => <section key={item.productId} className="card space-y-3 p-5">
      <h2 className="break-all font-semibold">{item.article}</h2>
      {item.problems.map((problem, index) => <div key={index} className="text-sm">
        <p>{problem.message}</p>
        {(problem.target || problem.field || problem.path || problem.issueFields?.length > 0) && <p className="mt-1 break-words text-slate-600">
          {problem.path || problem.target || problem.field || problem.issueFields.join(', ')}</p>}
        {problem.resolution === 'integration_configuration' && <p className="mt-1 text-slate-500">Відповідності потрібно перевірити адміністратору інтеграції. Редактор відповідностей ще недоступний.</p>}
      </div>)}
      {item.nameConflict && <ProductNameConflict productId={item.productId} onSaved={() => setRefresh((value) => value + 1)} />}
      <Link className="btn btn-outline text-xs" to={`/?article=${encodeURIComponent(item.article)}`}>Відкрити товар</Link>
    </section>)}
  </div></main>;
}
