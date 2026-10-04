import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/auth-context.js';
import { isActualAdministrator } from '../auth/auth-model.js';
import { LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { WorkspaceHeader, WorkspaceLocalNav } from '../components/workspace/WorkspacePrimitives.jsx';
import MagentoOverview from '../components/workspace/MagentoOverview.jsx';
import MagentoCategoryDetail from '../components/workspace/MagentoCategoryDetail.jsx';
import MagentoDetails from '../components/workspace/MagentoDetails.jsx';
import MagentoActionHistory from '../components/workspace/MagentoActionHistory.jsx';
import MagentoStructureResult from '../components/workspace/MagentoStructureResult.jsx';
import '../components/workspace/magento.css';

const Preparation = lazy(() => import('../components/workspace/MagentoPreparationWorkspace.jsx'));
const Administrator = lazy(() => import('../components/workspace/MagentoAdministratorWorkspace.jsx'));
const Rules = lazy(() => import('./ExportTemplatesPage.jsx'));
const Changes = lazy(() => import('../components/workspace/MagentoChangesWorkspace.jsx'));
const CategorySetup = lazy(() => import('../components/workspace/MagentoCategorySetup.jsx'));
const root = '/admin/magento-integration';
const date = (value) => value ? new Date(value).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : 'Немає доступного спостереження';

function useNarrowMagentoLayout() {
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia?.('(max-width: 900px)').matches || false);
  useEffect(() => {
    const query = globalThis.matchMedia?.('(max-width: 900px)');
    if (!query) return undefined;
    const update = () => setNarrow(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function MagentoIntegrationPage() {
  const auth = useAuth(); const { pathname } = useLocation();
  const canManage = auth.permissions.includes('export_templates.manage');
  const canViewProducts = auth.permissions.includes('products.view');
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [observation, setObservation] = useState(null); const [checking, setChecking] = useState(false); const [checkError, setCheckError] = useState('');
  const narrowViewport = useNarrowMagentoLayout(); const [contextOpen, setContextOpen] = useState(false);
  const narrowLayout = narrowViewport || pathname !== '/admin/magento';
  const discoverySequence = useRef(0);
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
    try { const { data: result } = await api.post(`${root}/structure-check`, {}); if (ticket === discoverySequence.current) { setObservation(result); setRefresh((value) => value + 1); } }
    catch (cause) { if (ticket === discoverySequence.current) setCheckError(cause.response?.data?.error || 'Перевірка структури не завершилася. Попереднє спостереження збережено.'); }
    finally { if (ticket === discoverySequence.current) setChecking(false); }
  }
  const integration = data?.integration;
  const published = integration?.activePublication;
  const stored = integration?.structureObservation;
  const useExplicit = observation && (!stored || Date.parse(observation.observedAt) >= Date.parse(stored.observedAt));
  const observedAt = useExplicit ? observation.observedAt : stored?.observedAt;
  const deliveryText = integration?.delivery.state === 'enabled' ? 'Автоматичну синхронізацію увімкнено'
    : integration?.delivery.state === 'disabled' ? 'Автоматичну синхронізацію вимкнено' : 'Стан автоматичної синхронізації невідомий';
  const operationalText = integration?.operational.state !== 'known' ? 'Дані про зафіксовані проблеми недоступні'
    : integration?.operational.count ? `Потребують уваги: ${integration.operational.count}` : 'Зафіксованих проблем немає';
  const publicationText = published ? `Версія ${published.versionNumber}` : 'Опублікованих відповідностей ще немає';
  const items = [{ to: '/admin/magento', label: 'Огляд' },
    { to: '/admin/magento/categories', label: 'Категорії' },
    ...(canManage ? [{ to: '/admin/magento/changes', label: 'Підготовлені зміни' }] : []),
    { to: '/admin/magento/history', label: 'Історія' },
    ...(isActualAdministrator(auth) ? [{ to: '/admin/magento/administrator', label: 'Контрольовані операції' }] : [])];
  return <main className="app-page"><div className="local-workspace magento-workspace">
    <WorkspaceHeader title="Інтеграція Magento" description="Категорії, характеристики та правила передачі товарів." actions={<button className="btn btn-outline btn-compact-md" onClick={() => setRefresh((value) => value + 1)}>Оновити стан</button>} />
    <WorkspaceLocalNav label="Інтеграція Magento" items={items} />
    {error && <Notice>{error}</Notice>}
    {!data && !error && <LoadingState label="Читаємо стан інтеграції…" />}
    {data && <>{narrowLayout && <section className="magento-compact-context" aria-label="Поточна інтеграція">
      <div><span>Поточна доставка</span><strong>{deliveryText}</strong><small>{operationalText}</small></div>
      <div><span>Активні відповідності</span><strong>{publicationText}</strong></div>
      <button type="button" className="magento-context-toggle" aria-expanded={contextOpen}
        onClick={() => setContextOpen((value) => !value)}>{contextOpen ? 'Сховати деталі' : 'Деталі інтеграції'}</button>
    </section>}
    <div className={`magento-layout${narrowLayout ? ' is-narrow' : ''}`}>
      <aside hidden={narrowLayout && !contextOpen} className={`magento-context card p-5${narrowLayout ? ' is-narrow-details' : ''}`}
        aria-label={narrowLayout ? 'Деталі поточної інтеграції' : 'Поточна інтеграція'}>
        {!narrowLayout && <div className="magento-context-summary"><div><h2 className="font-semibold">Поточна доставка</h2><p className="mt-2 text-sm">{deliveryText}</p>
          <p className="mt-2 font-medium" role="status">{operationalText}</p><p className="mt-1 text-xs text-slate-500">За записами Amber.</p>
        </div>
        <div className="magento-active-publication"><h2 className="font-semibold">Активні відповідності</h2><p className="mt-1">{publicationText}</p>
          {published && <p className="mt-1 text-sm text-slate-600">Опубліковано: {date(published.publishedAt)}{published.templateVersionNumber ? ` · Шаблон ${published.templateVersionNumber}` : ''}</p>}
        </div></div>}
        {(!narrowLayout || contextOpen) && <div className="magento-context-details">
        <div>
          {integration.draftCount > 0 && <p className="mt-2 text-sm">Є чернетки змін: {integration.draftCount}. Вони не змінюють поточну доставку.</p>}
        </div>
        <div className="border-t pt-4"><p className="text-sm font-medium" role="status">Остання перевірка структури Magento: {date(observedAt)}</p>
          {observedAt && <p className="mt-1 text-xs text-slate-500">{useExplicit ? 'Явна перевірка в цьому сеансі.' : `Доступне збережене спостереження ${stored.state === 'draft' ? 'чернетки' : 'опублікованої версії'}.`} Не є перевіркою доставки товарів.</p>}
          <button className="btn btn-outline btn-compact-md mt-3" disabled={checking || !integration.configured} onClick={discover}>Перевірити структуру</button>
          {!integration.configured && <p className="mt-2 text-sm">Підключення Magento не налаштоване.</p>}
          {checking && <LoadingState compact label="Перевіряємо структуру…" />}{checkError && <Notice>{checkError}</Notice>}
          <MagentoStructureResult comparison={checkError ? null : observation?.comparison} activeId={published?.id} />
        </div>
        <MagentoDetails>{() => <div className="space-y-2 text-xs"><p>Знімок локальних даних: {date(integration.asOf)}</p><p className="break-all">Активний binding: {published?.id || '—'} · revision: {published?.revision || '—'}</p><p>Спостереження активної публікації: {date(published?.observedAt)}</p><p className="break-all">Джерело спостереження: {useExplicit ? 'Явний GET огляд Magento' : stored?.bindingId || '—'}</p></div>}</MagentoDetails>
        <MagentoDetails summary="Історія дій">{() => <MagentoActionHistory />}</MagentoDetails>
        </div>}
      </aside>
      <div className="min-w-0">
        <Suspense fallback={<LoadingState />}><Routes>
          <Route index element={<MagentoOverview categories={data.categories} canManage={canManage} />} />
          <Route path="categories" element={<MagentoOverview categories={data.categories} all canManage={canManage} />} />
          <Route path="categories/new" element={<CategorySetup activePublication={published} />} />
          <Route path="categories/:categoryCode" element={<MagentoCategoryDetail key={published?.id || 'none'} categories={data.categories} canManage={canManage} canViewProducts={canViewProducts} activeId={published?.id} />} />
          <Route path="categories/:categoryCode/labels" element={<Administrator activePublication={published} readOnlyLabels />} />
          <Route path="rules/*" element={<Rules embedded basePath="/admin/magento/rules" activePublication={published} />} />
          <Route path="changes" element={<Changes activePublication={published} canManage={canManage} />} />
          <Route path="history" element={<Changes activePublication={published} canManage={canManage} history />} />
          <Route path="prepare" element={canManage ? <Preparation activePublication={published} observation={observation} onDiscover={discover} checking={checking} checkError={checkError} onPublished={() => setRefresh((value) => value + 1)} /> : <Notice>Немає доступу до підготовки змін.</Notice>} />
          <Route path="administrator" element={isActualAdministrator(auth) ? <Administrator activePublication={published} /> : <Notice>Ці дії доступні лише Адміністратору.</Notice>} />
          <Route path="configuration" element={<Navigate to="/admin/magento/prepare" replace />} />
          <Route path="*" element={<Notice>Розділ не знайдено. <Link to="/admin/magento">До огляду</Link></Notice>} />
        </Routes></Suspense>
      </div>
    </div></>}
  </div></main>;
}
