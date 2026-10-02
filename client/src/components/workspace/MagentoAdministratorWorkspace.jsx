import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { api } from '../../lib/api.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoOptionActions from './MagentoOptionActions.jsx';
import MagentoControlledActions from './MagentoControlledActions.jsx';

const workflows = [
  { kind: 'labels', title: 'Оновити підписи наявних значень', description: 'Порівняння та окремо підтверджена зміна глобальних і англійських підписів точного значення Magento.' },
  { kind: 'name_rule', title: 'Застосувати правила назв', description: 'Перегляд нових назв і підтвердження точного списку товарів. Публікація сама по собі зберігає чинні назви.' },
  { kind: 'broader_resync', title: 'Контрольована повторна синхронізація', description: 'Окремий перевірений список товарів. Непідтверджені відправлення не скидаються і не повторюються.' },
];

function AdministratorWorkspace({ activePublication, readOnlyLabels = false }) {
  const auth = useAuth(); const { categoryCode: initialCategory } = useParams();
  const [workflow, setWorkflow] = useState(readOnlyLabels ? 'labels' : '');
  const [categoryCode, setCategoryCode] = useState(initialCategory || '');
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const canInspect = ['export_templates.manage', 'export_templates.publish'].every((permission) => auth.permissions.includes(permission));
  const allowed = readOnlyLabels ? canInspect : isActualAdministrator(auth);
  useEffect(() => {
    if (!activePublication || !allowed || !workflow) return;
    const controller = new AbortController();
    api.get('/admin/magento-integration', { params: { bindingRevisionId: activePublication.id }, signal: controller.signal })
      .then(({ data: result }) => { if (!controller.signal.aborted) { setData(result); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати активні відповідності.'); });
    return () => controller.abort();
  }, [activePublication, allowed, workflow, reload]);
  if (!allowed) return <Notice>Немає доступу до цієї дії.</Notice>;
  if (!activePublication) return <EmptyState>Для цих дій потрібні чинні опубліковані відповідності.</EmptyState>;
  const category = data?.categories.find((item) => item.code === categoryCode) || data?.categories[0];
  const current = data?.currentPublishedId === activePublication.id && data?.revision?.id === activePublication.id;
  return <div className="space-y-5">
    <h2 className="text-xl font-semibold">{readOnlyLabels ? 'Порівняння підписів значень' : 'Дії Адміністратора'}</h2>
    {readOnlyLabels && <Link className="text-sm underline" to={`/admin/magento/categories/${encodeURIComponent(initialCategory || '')}`}>До категорії</Link>}
    {!workflow && <div className="space-y-3">{workflows.map((item) => <section className="card space-y-3 p-5" key={item.kind}>
      <h3 className="font-semibold">{item.title}</h3><p className="text-sm text-slate-600">{item.description}</p>
      <button className="btn btn-outline btn-compact-md" onClick={() => setWorkflow(item.kind)}>{item.title}</button>
    </section>)}</div>}
    {workflow && <>
      {!readOnlyLabels && <button className="btn btn-outline btn-compact-md" onClick={() => { setWorkflow(''); setData(null); setError(''); }}>До переліку дій Адміністратора</button>}
      <p className="text-sm">Дія стосується активної публікації, версія {activePublication.versionNumber}.</p>
      {error && <Notice>{error} <button className="btn btn-outline btn-compact-md" onClick={() => setReload((value) => value + 1)}>Повторити читання</button></Notice>}
      {!data && !error && <LoadingState />}
      {data && !current && <Notice>Активна публікація змінилася. Оновіть стан інтеграції перед продовженням.</Notice>}
      {current && (workflow === 'labels' ? <>
        <label className="block text-sm">Категорія для порівняння<select className="input" value={category?.code || ''} onChange={(event) => setCategoryCode(event.target.value)}>{data.categories.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <MagentoOptionActions mode="labels" readOnly={readOnlyLabels} revision={data.revision} currentPublishedId={activePublication.id} category={category} />
      </> : <MagentoControlledActions revision={data.revision} currentPublishedId={activePublication.id} kind={workflow} />)}
    </>}
  </div>;
}
export default function MagentoAdministratorWorkspace(props) {
  return <AdministratorWorkspace key={`${props.activePublication?.id}:${props.readOnlyLabels ? 'comparison' : 'admin'}`} {...props} />;
}
