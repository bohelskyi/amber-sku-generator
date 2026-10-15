import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { api } from '../lib/api.js';
import { getApiError } from '../lib/http-error';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation.jsx';
import { CatalogCategoryEditor } from '../components/admin/CatalogCharacteristicEditor.jsx';
import MagentoCategoryWorkspace from '../components/workspace/MagentoCategoryWorkspace.jsx';
import { Button, LoadingState, Notice, PageHeader, TechnicalDisclosure } from '../components/ui/index.js';
import '../components/workspace/magento.css';

const Preparation = lazy(() => import('../components/workspace/MagentoPreparationWorkspace.jsx'));

function CategoryTask({ categoryCode, onSaved }) {
  const navigate = useNavigate(); const location = useLocation();
  const savedCategory = useRef(categoryCode);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  const guard = useDirtyNavigation({ dirty: dirty || busy, busy, discard: () => setDirty(false) });
  const destination = (code = savedCategory.current) => {
    const params = new URLSearchParams(location.search); params.delete('action');
    if (code) params.set('category', code);
    return { pathname: '/admin/catalog', search: params.toString(), hash: location.hash };
  };
  return <>
    <CatalogCategoryEditor categoryCode={categoryCode} onDirtyChange={setDirty} onBusyChange={setBusy}
      onClose={() => guard.commit(() => navigate(destination()))} onSaved={async (receipt) => {
        savedCategory.current = receipt.categoryCode || savedCategory.current;
        await onSaved(receipt);
        if (receipt.categoryCode) guard.commit(() => navigate(destination(receipt.categoryCode), { replace: true }));
      }} />
    {guard.prompt}
  </>;
}

export default function CatalogPage() {
  const { permissions } = useAuth(); const [params] = useSearchParams();
  const canReadCatalog = permissions.includes('catalog.view');
  const canReadIntegration = permissions.includes('export_templates.view');
  const canManageCatalog = permissions.includes('catalog.manage');
  const [localConfig, setLocalConfig] = useState(null); const [localError, setLocalError] = useState('');
  const [overview, setOverview] = useState(null); const [integrationError, setIntegrationError] = useState('');
  const [refresh, setRefresh] = useState(0); const localSequence = useRef(0);
  const [observation, setObservation] = useState(null); const [checking, setChecking] = useState(false); const [checkError, setCheckError] = useState('');
  const checkSequence = useRef(0);
  const reloadCatalog = useCallback(async () => {
    if (!canReadCatalog) return null;
    const ticket = ++localSequence.current;
    try {
      const { data } = await api.get('/admin/config');
      if (ticket === localSequence.current) { setLocalConfig(data); setLocalError(''); }
      return data;
    } catch (error) {
      if (ticket === localSequence.current) setLocalError(getApiError(error));
      throw error;
    }
  }, [canReadCatalog]);
  useEffect(() => {
    const sequence = localSequence;
    if (canReadCatalog) void reloadCatalog().catch(() => {});
    return () => { ++sequence.current; };
  }, [canReadCatalog, reloadCatalog]);
  useEffect(() => {
    if (!canReadIntegration) return undefined;
    const controller = new AbortController();
    api.get('/admin/magento-integration/overview', { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) { setOverview(data); setIntegrationError(''); } })
      .catch((error) => { if (!controller.signal.aborted) setIntegrationError(getApiError(error)); });
    return () => controller.abort();
  }, [canReadIntegration, refresh]);
  useEffect(() => () => { ++checkSequence.current; }, []);
  const discover = async () => {
    if (!canReadIntegration || checking) return;
    const ticket = ++checkSequence.current; setChecking(true); setCheckError('');
    try {
      const { data } = await api.post('/admin/magento-integration/structure-check', {});
      if (ticket === checkSequence.current) { setObservation(data); setRefresh((value) => value + 1); }
    } catch (error) { if (ticket === checkSequence.current) setCheckError(getApiError(error)); }
    finally { if (ticket === checkSequence.current) setChecking(false); }
  };
  const categories = [...new Map([
    ...(canReadIntegration ? overview?.categories || [] : []).map((item) => [item.code, item]),
    ...Object.values(canReadCatalog ? localConfig?.categories || {} : {}).map((item) => [item.code, {
      operational: { state: 'unknown', count: null }, unboundCount: null,
      ...(canReadIntegration ? overview?.categories || [] : []).find((remote) => remote.code === item.code), ...item,
    }]),
  ]).values()];
  const categoryCode = params.get('category');
  const category = categories.find((item) => item.code === categoryCode);
  const categoryAction = params.get('action');
  const categoryTask = ['new-category', 'edit-category'].includes(categoryAction);
  const resourceTask = params.get('catalogTask') === 'resource';
  const published = canReadIntegration ? overview?.integration?.activePublication : null;
  // A failed refresh keeps the already loaded workspace and its local input.
  const integrationAvailable = canReadIntegration && Boolean(overview);
  const waitingForInitialData = (canReadIntegration && !overview && !integrationError)
    || (canReadCatalog && !localConfig && !localError);
  const onPublished = () => setRefresh((value) => value + 1);
  if (!canReadCatalog && !canReadIntegration) return <Notice tone="warning" title="Немає доступу до каталогу" />;
  return <main className="app-page magento-category-page"><div className="local-workspace magento-workspace">
    <PageHeader title={categoryTask ? categoryAction === 'new-category' ? 'Нова категорія' : 'Налаштування категорії' : 'Каталог'}
      breadcrumbs={[{ label: 'Налаштування', to: '/settings' }, { label: 'Каталог', ...(categoryTask || resourceTask ? { to: '/admin/catalog' } : {}) }]}
      description={resourceTask ? `Передавання в магазин · ${category?.name || categoryCode || 'категорія'}` : 'Категорії, характеристики, значення та їх передавання в магазин.'} />
    {categoryTask ? canReadCatalog && canManageCatalog
      ? <CategoryTask key={`${categoryAction}:${categoryCode || ''}`} categoryCode={categoryAction === 'new-category' ? null : categoryCode} onSaved={reloadCatalog} />
      : <Notice tone="warning" title="Немає дозволу змінювати каталог" />
      : <>
        {localError && <Notice tone="warning" title="Не вдалося оновити каталог" actions={<Button onClick={() => void reloadCatalog().catch(() => {})}>Оновити каталог</Button>}>{localError}</Notice>}
        {integrationError && <Notice tone="warning" title="Налаштування магазину недоступні" actions={<Button onClick={onPublished}>Повторити читання</Button>}>Каталог додатку доступний незалежно від магазину. {integrationError}</Notice>}
        {resourceTask ? permissions.includes('export_templates.manage') && integrationAvailable
          ? <Suspense fallback={<LoadingState label="Відкриваємо налаштування передавання…" />}><Preparation embedded activePublication={published} observation={observation}
            onDiscover={discover} checking={checking} checkError={checkError} onPublished={onPublished} /></Suspense>
          : canReadIntegration && !overview && !integrationError ? <LoadingState label="Читаємо налаштування магазину…" />
            : <Notice tone="warning" title="Передавання в магазин зараз недоступне"><Link to={`/admin/catalog?${new URLSearchParams(categoryCode ? { category: categoryCode } : {})}`}>Повернутися до каталогу</Link></Notice>
          : waitingForInitialData
            ? <LoadingState label="Читаємо каталог…" />
            : <MagentoCategoryWorkspace categories={categories} activePublication={published} onPublished={onPublished}
              localConfig={canReadCatalog ? localConfig : null} localConfigError={localError} onLocalSaved={reloadCatalog} integrationAvailable={integrationAvailable} />}
        {!resourceTask && <TechnicalDisclosure summary="Додаткові налаштування"><div className="flex flex-wrap gap-4">
          {canReadCatalog && <Link to={`/admin/catalog/structure${categoryCode ? `?category=${encodeURIComponent(categoryCode)}` : ''}`}>Історична структура та внутрішні SKU</Link>}
          {canReadIntegration && <Link to="/admin/magento/overview">Підключення магазину</Link>}
        </div></TechnicalDisclosure>}
      </>}
  </div></main>;
}
