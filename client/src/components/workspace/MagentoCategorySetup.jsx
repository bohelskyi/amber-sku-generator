import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { useDirtyNavigation } from '../../hooks/useDirtyNavigation.jsx';
import { CategoryForm } from '../admin/AdminCatalogForms.jsx';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import { placementRows } from './category-journeys.js';
import '../admin/admin.css';
import './category-journeys.css';

const emptyCategory = { code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true };

export function CategoryCheckpoints({ category, detail, permissions }) {
  const code = category.code; const encoded = encodeURIComponent(code);
  const back = `/admin/magento/categories/new?category=${encoded}`;
  const catalog = `/admin/catalog?category=${encoded}&returnTo=${encodeURIComponent(back)}`;
  const paths = placementRows(detail.revision, code);
  const questionCount = detail.catalog?.questions?.[code]?.length;
  const steps = [
    { title: 'Характеристики товару', state: questionCount === undefined ? 'Дані характеристик недоступні' : questionCount ? `Характеристик у каталозі: ${questionCount}` : 'Характеристик ще немає', to: permissions.includes('catalog.view') ? catalog : null, action: 'Відкрити характеристики' },
    { title: 'Схема внутрішнього SKU', state: category.schema ? `Опублікована версія ${category.schema.version}. Подальші зміни каталогу перевіряються окремо.` : 'Схему ще не опубліковано', to: permissions.includes('catalog.view') ? catalog : null, action: 'Перевірити та опублікувати' },
    { title: 'Ціноутворення', state: 'Розрахунок ціни нового товару ще потрібно перевірити', to: permissions.includes('pricing.view') ? `/admin/pricing?category=${encoded}&returnTo=${encodeURIComponent(back)}` : null, action: 'Налаштувати ціну' },
    { title: 'Розміщення та поля магазину', state: paths.length ? `У чинних правилах: ${paths.length} розділів магазину` : 'У чинних правилах розміщення ще немає', to: permissions.includes('export_templates.manage') ? `/admin/magento/prepare?intent=category&category=${encoded}` : null, action: 'Налаштувати магазин' },
    { title: 'Перевірка та підключення', state: category.ready ? 'Структурні відповідності підтверджено. Доставка товарів перевіряється окремо.' : 'Підключення ще потребує перевірки', to: `/admin/magento/categories/${encoded}?tab=products`, action: 'Перевірити товар' },
  ];
  return <ol className="category-checkpoints" aria-label="Налаштування нової категорії">{steps.map((step) => <li key={step.title}><div><strong>{step.title}</strong><p>{step.state}</p></div>{step.to ? <Link className="btn btn-outline" to={step.to}>{step.action}</Link> : <span className="text-sm text-slate-600">Потрібен відповідний дозвіл</span>}</li>)}</ol>;
}

export default function MagentoCategorySetup() {
  const { permissions } = useAuth(); const [params, setParams] = useSearchParams();
  const code = params.get('category') || '';
  const [detail, setDetail] = useState(null); const [loadError, setLoadError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState(emptyCategory); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [receipt, setReceipt] = useState(null);
  const inFlight = useRef(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(emptyCategory);
  const navigation = useDirtyNavigation({ dirty, busy, discard: () => setForm(emptyCategory) });
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) { setDetail(data); setLoadError(''); } })
      .catch(() => { if (!controller.signal.aborted) setLoadError('Не вдалося прочитати стан категорії.'); });
    return () => controller.abort();
  }, [refresh, code]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function save() {
    if (inFlight.current || !permissions.includes('catalog.manage')) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const { data } = await api.post('/admin/category', { ...form, requires_weight: Number(form.requires_weight), skip_hidden_sku_questions: Number(form.skip_hidden_sku_questions), marketing_rounding_enabled: Number(form.marketing_rounding_enabled) });
      setReceipt(data); setForm(emptyCategory); setRefresh((value) => value + 1);
      if (data.id) navigation.commit(() => setParams({ category: data.id }));
    } catch (cause) { setError(cause.response?.data?.error || 'Не вдалося створити категорію.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const category = detail?.categories?.find((item) => item.code === code);
  return <div className="space-y-4">
    {navigation.prompt}
    <Link className="text-sm underline" to="/admin/magento/categories">До категорій</Link>
    <h2 className="text-xl font-semibold">{code ? `Налаштування категорії${category ? ` «${category.name}»` : ''}` : 'Новий тип товару'}</h2>
    {!code && <p className="text-sm text-slate-600">Окремий тип товару зі своїми характеристиками та ціною. Для нового розділу магазину відкрийте наявну категорію й додайте підкатегорію.</p>}
    {receipt && <Notice title="Категорію створено"><p>{receipt.name} · {receipt.id}</p><p>Налаштуйте характеристики, ціну та підключення до магазину.</p></Notice>}
    {loadError && <Notice tone="warning">{loadError}<button className="btn btn-outline" onClick={() => setRefresh((value) => value + 1)}>Оновити стан категорії</button></Notice>}
    {!detail && !loadError && <LoadingState />}
    {detail && <label className="block text-sm">Продовжити налаштування наявної категорії<select className="input" value={code} onChange={(event) => { const next = event.target.value; navigation.request(() => { setReceipt(null); setError(''); setParams(next ? { category: next } : {}); }); }}><option value="">Створити нову категорію</option>{detail.categories.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>}
    {!code && !receipt && (permissions.includes('catalog.manage') ? <fieldset disabled={busy}>{error && <Notice tone="error">{error}</Notice>}<CategoryForm category={form} onChange={setForm} onSave={save} onCancel={() => navigation.request(() => setForm(emptyCategory))} /></fieldset> : <Notice>Для створення категорії потрібен дозвіл керування каталогом.</Notice>)}
    {code && category && <CategoryCheckpoints category={category} detail={detail} permissions={permissions} />}
    {code && detail && !category && <Notice>Категорія ще не відображається у прочитаному стані. Оновіть стан перед наступними діями.<button className="btn btn-outline" onClick={() => setRefresh((value) => value + 1)}>Оновити стан категорії</button></Notice>}
  </div>;
}
