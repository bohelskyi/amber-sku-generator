import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { ProductNameConflict } from '../components/app/ProductNameConflict.jsx';
import {
  Button,
  EmptyState,
  LoadingState,
  Notice,
  PageHeader,
  Pagination,
  StatusBadge,
  TechnicalDisclosure,
} from '../components/ui/index.js';
import { api } from '../lib/api.js';
import '../components/attention/attention.css';

const PAGE_SIZE = 20;
const PRODUCT_FIELD_LABELS = Object.freeze({
  name: 'Назва українською та англійською',
  rozmir_suveniriv: 'Розмір',
  kamin_obrobka: 'Обробка каменю',
});

function productProblemFields(problem) {
  return [...new Set(problem.issueFields || [])]
    .map((field) => PRODUCT_FIELD_LABELS[field])
    .filter(Boolean);
}

function canRepairProblem(problem, selected, permissions) {
  const fields = problem.issueFields || [];
  const canRepairNames = selected.category === 'SV' && !selected.nameConflict
    && fields.includes('name') && permissions.includes('exports.create');
  const canRepairInformation = selected.category === 'SV' && fields.includes('rozmir_suveniriv')
    && permissions.includes('products.recount');
  const canRepairCharacteristics = fields.some((field) => !['name', 'rozmir_suveniriv'].includes(field))
    && permissions.includes('products.recount');
  return canRepairNames || canRepairInformation || canRepairCharacteristics;
}

function normalizedOffset(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export default function SyncProblemsPage() {
  const { permissions } = useAuth();
  const canDecode = permissions.includes('products.decode');
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const offset = normalizedOffset(params.get('offset'));
  const selectedId = normalizedOffset(params.get('problem')) || null;
  const queryKey = `${category}:${offset}`;
  const [result, setResult] = useState({ key: '', items: null, pageInfo: null });
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [polling, setPolling] = useState(false);

  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const setLocationState = useCallback((changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const controller = new AbortController();
    const read = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      if (live) setPolling(true);
      try {
        const { data } = await api.get('/magento/problems/page', {
          params: { category: category || undefined, limit: PAGE_SIZE, offset },
          signal: controller.signal,
        });
        if (live) {
          setResult({ key: queryKey, items: data.items || [], pageInfo: data.pageInfo || null });
          setError('');
        }
      } catch (requestError) {
        if (live && requestError?.name !== 'CanceledError') setError('Не вдалося оновити проблеми доставки.');
      } finally {
        inFlight = false;
        if (live) setPolling(false);
      }
    };
    read();
    const timer = window.setInterval(read, 15000);
    window.addEventListener('focus', read);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [category, offset, queryKey, refresh]);

  const items = result.key === queryKey ? result.items : null;
  const pageInfo = result.key === queryKey
    ? result.pageInfo
    : { limit: PAGE_SIZE, offset, total: 0, hasPrevious: false, hasNext: false };
  const selected = useMemo(() => (
    items?.find((item) => Number(item.productId) === Number(selectedId)) || items?.[0] || null
  ), [items, selectedId]);

  return <main className="app-page"><div className="sync-problems-workspace">
    <PageHeader
      breadcrumbs={[{ label: 'Потребує уваги', to: '/attention' }, { label: 'Доставка до Magento' }]}
      title="Проблеми доставки до Magento"
      description="Зафіксовані стани, для яких потрібна дія або перевірка. Невизначений результат зовнішнього запису не надсилається повторно."
      actions={<Button size="compactMd" onClick={reload} busy={polling}><RefreshCw size={15} aria-hidden="true" />Оновити</Button>}
    />
    {error && <Notice tone={items ? 'warning' : 'error'}>{error}{items && ' Показано останні отримані дані.'}</Notice>}
    {category && <Notice tone="info">Категорія: <strong>{category}</strong>. <Link className="underline" to="/sync-problems">Показати всі категорії</Link></Notice>}
    {!items && !error && <LoadingState label="Завантажуємо проблеми доставки…" />}
    {items?.length === 0 && !error && <EmptyState title="Зафіксованих проблем немає">Amber не має поточних станів доставки, що потребують уваги.</EmptyState>}
    {items?.length > 0 && <section className="sync-problem-master-detail">
      <aside className="sync-problem-queue" aria-label="Черга проблем доставки">
        {items.map((item) => <button key={`${item.productId}-${item.article}`} type="button"
          className={`sync-problem-queue-item ${Number(selected?.productId) === Number(item.productId) ? 'is-selected' : ''}`}
          aria-pressed={Number(selected?.productId) === Number(item.productId)}
          onClick={() => setLocationState({ problem: item.productId })}>
          <span><StatusBadge tone="warning">Потребує уваги</StatusBadge>{item.category && <small>{item.category}</small>}</span>
          <strong>{item.article || 'Артикул недоступний'}</strong>
          <span>{item.problems[0]?.message || 'Потрібна перевірка'}</span>
        </button>)}
        <Pagination busy={polling} hasPrevious={pageInfo.hasPrevious} hasNext={pageInfo.hasNext}
          onPrevious={() => setLocationState({ offset: Math.max(0, offset - PAGE_SIZE), problem: null })}
          onNext={() => setLocationState({ offset: offset + PAGE_SIZE, problem: null })}
          summary={pageInfo.total > 0 ? `${offset + 1}–${Math.min(offset + items.length, pageInfo.total)} із ${pageInfo.total}` : undefined} />
      </aside>

      <article className="sync-problem-detail">
        <header><div><p className="eyebrow">Артикул</p><h2>{selected.article || 'Артикул недоступний'}</h2></div><StatusBadge tone="warning">Потребує уваги</StatusBadge></header>
        <div className="sync-problem-detail-body">
          {selected.problems.map((problem, index) => <section key={`${problem.code}-${index}`}>
            <h3>{problem.message}</h3>
            {problem.resolution === 'product' && productProblemFields(problem).length > 0 && <>
              <p className="sync-problem-guidance">Проблемні дані:</p>
              <ul className="list-disc pl-5">{productProblemFields(problem).map((field) => <li key={field}>{field}</li>)}</ul>
            </>}
            {problem.resolution === 'product' && problem.code !== 'NAME_READ_UNAVAILABLE' && <p className="sync-problem-guidance">{canDecode
              && canRepairProblem(problem, selected, permissions)
              && selected.article
              ? <Link to={`/products/open?article=${encodeURIComponent(selected.article)}`}>Виправити дані товару</Link>
              : 'Передайте виправлення оператору з дозволом на зміну даних товару.'}</p>}
            {problem.resolution === 'integration_configuration' && <p className="sync-problem-guidance">{permissions.includes('export_templates.view')
              ? <Link to={selected.category ? `/admin/magento/categories/${encodeURIComponent(selected.category)}` : '/admin/magento'}>Перевірити відповідності Magento</Link>
              : 'Передайте питання оператору з доступом до відповідностей Magento.'}</p>}
            {problem.code === 'PRODUCT_EVALUATION_NOT_READY' && selected.category && permissions.includes('export_templates.view') && <div className="flex flex-wrap gap-2">
              {[...new Set(problem.issueFields || [])].map((field) => <Link key={field} className="underline" to={`/admin/magento/categories/${encodeURIComponent(selected.category)}?field=${encodeURIComponent(field)}`}>
                Відповідності: {PRODUCT_FIELD_LABELS[field] || field}
              </Link>)}
            </div>}
            <TechnicalDisclosure>
              <dl className="technical-key-values"><div><dt>Код</dt><dd>{problem.code}</dd></div>
                {problem.diagnosticCode && <div><dt>Діагностика</dt><dd>{problem.diagnosticCode}</dd></div>}
                {(problem.path || problem.target || problem.field || problem.issueFields?.length > 0) && <div><dt>Контекст</dt><dd>{problem.path || problem.target || problem.field || problem.issueFields.join(', ')}</dd></div>}</dl>
            </TechnicalDisclosure>
          </section>)}
          {selected.nameConflict && <ProductNameConflict productId={selected.productId} onSaved={reload} />}
        </div>
        <footer>{canDecode && selected.article
          ? <Link className="btn btn-outline btn-compact-md" to={`/products/open?article=${encodeURIComponent(selected.article)}`}>Відкрити товар</Link>
          : <span className="text-sm text-slate-500">{canDecode
            ? 'Артикул недоступний, тому товар неможливо відкрити.'
            : 'Відкриття товару недоступне для вашого рівня доступу.'}</span>}</footer>
      </article>
    </section>}
  </div></main>;
}
