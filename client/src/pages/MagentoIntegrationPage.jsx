import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/auth-context.js';
import { isActualAdministrator } from '../auth/auth-model.js';
import { LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { WorkspaceHeader, WorkspaceLocalNav } from '../components/workspace/WorkspacePrimitives.jsx';
import MagentoOverview from '../components/workspace/MagentoOverview.jsx';
import MagentoCategoryDetail from '../components/workspace/MagentoCategoryDetail.jsx';
import MagentoCategoryWorkspace from '../components/workspace/MagentoCategoryWorkspace.jsx';
import '../components/workspace/magento.css';
import '../components/workspace/store-connection.css';

const Preparation = lazy(() => import('../components/workspace/MagentoPreparationWorkspace.jsx'));
const Administrator = lazy(() => import('../components/workspace/MagentoAdministratorWorkspace.jsx'));
const Rules = lazy(() => import('./ExportTemplatesPage.jsx'));
const Changes = lazy(() => import('../components/workspace/MagentoChangesWorkspace.jsx'));
const CategorySetup = lazy(() => import('../components/workspace/MagentoCategorySetup.jsx'));
const root = '/admin/magento-integration';


function CategoryEntrance({ categories, canManage, canViewProducts, published, ...workspace }) {
  const { search } = useLocation(); const params = new URLSearchParams(search);
  if (['products', 'legacy'].includes(params.get('tab'))) {
    return <MagentoCategoryDetail categories={categories} canManage={canManage} canViewProducts={canViewProducts} activeId={published?.id} />;
  }
  return <MagentoCategoryWorkspace categories={categories} activePublication={published} {...workspace} />;
}

export default function MagentoIntegrationPage() {
  const auth = useAuth(); const { pathname } = useLocation();
  const canManage = auth.permissions.includes('export_templates.manage');
  const canViewProducts = auth.permissions.includes('products.view');
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [observation, setObservation] = useState(null); const [checking, setChecking] = useState(false); const [checkError, setCheckError] = useState('');
  const categoryWorkspace = pathname === '/admin/magento' || pathname === '/admin/magento/categories' || /^\/admin\/magento\/categories\/[^/]+$/.test(pathname);
  const discoverySequence = useRef(0);
  useEffect(() => { const reload = () => setRefresh((value) => value + 1); window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload); }, []);
  useEffect(() => () => { ++discoverySequence.current; }, []);
  useEffect(() => {
    const controller = new AbortController();
    api.get(`${root}/overview`, { signal: controller.signal }).then(({ data: result }) => {
      if (!controller.signal.aborted) { setData(result); setError(''); }
    }).catch(() => { if (!controller.signal.aborted) setError('Не вдалося оновити стан інтеграції. Доступні дані можуть бути неактуальними.'); });
    return () => controller.abort();
  }, [refresh, canViewProducts]);
  async function discover() {
    const ticket = ++discoverySequence.current; setChecking(true); setCheckError('');
    try { const { data: result } = await api.post(`${root}/structure-check`, {});
      if (typeof result?.observedAt !== 'string' || !Number.isFinite(Date.parse(result.observedAt))) throw new Error('Incomplete observation');
      if (ticket === discoverySequence.current) { setObservation(result); setRefresh((value) => value + 1); } }
    catch (cause) { if (ticket === discoverySequence.current) setCheckError(cause.response?.data?.error || 'Не вдалося завершити перевірку Magento. Спробуйте ще раз.'); }
    finally { if (ticket === discoverySequence.current) setChecking(false); }
  }
  const integration = data?.integration;
  const published = integration?.activePublication;
  const items = [{ to: '/admin/catalog', label: 'Каталог' },
    { to: '/admin/magento/overview', label: 'Підключення' },
    { to: '/admin/magento/history', label: 'Історія' },
    ...(isActualAdministrator(auth) ? [{ to: '/admin/magento/administrator', label: 'Службові операції' }] : [])];
  return <main className={categoryWorkspace ? 'app-page magento-category-page' : 'app-page'}><div className="local-workspace magento-workspace">
    <WorkspaceHeader title={categoryWorkspace ? 'Каталог' : 'Підключення магазину'} actions={!categoryWorkspace && <button type="button" className="btn btn-outline btn-compact-md" onClick={() => setRefresh(value => value + 1)}>Оновити стан</button>} />
    {!categoryWorkspace && <WorkspaceLocalNav label="Підключення магазину" items={items} />}
    {error && <Notice>{error}</Notice>}
    {!data && !error && <LoadingState label="Читаємо стан інтеграції…" />}
    {data && <div className="min-w-0">
        <Suspense fallback={<LoadingState />}><Routes>
          <Route index element={<MagentoCategoryWorkspace categories={data.categories} activePublication={published} onPublished={() => setRefresh((value) => value + 1)} onObserve={discover} checking={checking} />} />
          <Route path="overview" element={<MagentoOverview integration={integration} observation={observation} checking={checking} checkError={checkError} onCheck={discover} canManage={canManage} />} />
          <Route path="categories" element={<MagentoCategoryWorkspace categories={data.categories} activePublication={published} onPublished={() => setRefresh((value) => value + 1)} onObserve={discover} checking={checking} />} />
          <Route path="categories/new" element={<CategorySetup activePublication={published} />} />
          <Route path="categories/:categoryCode" element={<CategoryEntrance categories={data.categories} canManage={canManage} canViewProducts={canViewProducts} published={published} onPublished={() => setRefresh((value) => value + 1)} onObserve={discover} checking={checking} />} />
          <Route path="categories/:categoryCode/labels" element={<Administrator activePublication={published} readOnlyLabels />} />
          <Route path="rules/*" element={<Rules embedded basePath="/admin/magento/rules" activePublication={published} />} />
          <Route path="changes" element={<Changes activePublication={published} canManage={canManage} />} />
          <Route path="history" element={<Changes activePublication={published} canManage={canManage} history />} />
          <Route path="prepare" element={canManage ? <Preparation activePublication={published} observation={observation} onDiscover={discover} checking={checking} checkError={checkError} onPublished={() => setRefresh((value) => value + 1)} /> : <Notice>Немає доступу до підготовки змін.</Notice>} />
          <Route path="administrator" element={isActualAdministrator(auth) ? <Administrator activePublication={published} onApplied={() => setRefresh((value) => value + 1)} /> : <Notice>Ці дії доступні лише Адміністратору.</Notice>} />
          <Route path="configuration" element={<Navigate to="/admin/magento/prepare" replace />} />
          <Route path="*" element={<Notice>Розділ не знайдено. <Link to="/admin/magento">До огляду</Link></Notice>} />
        </Routes></Suspense>
    </div>}
  </div></main>;
}
