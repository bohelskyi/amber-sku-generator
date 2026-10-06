import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';

const root = '/admin/magento-integration';

function groupRequirements(revision, categoryCode) {
  const routes = revision?.bindings.routes || [];
  const grouped = new Map();
  for (const attribute of revision?.bindings.attributes || []) {
    if (attribute.target !== 'categories') continue;
    const route = routes.find((item) => item.routeKey === attribute.routeKey);
    if (categoryCode && route?.routeKey.split(/[.:]/)[0] !== categoryCode) continue;
    for (const decision of attribute.evidence?.categories || []) {
      const path = decision.normalizedPath;
      if (!grouped.has(path)) grouped.set(path, { path, label: decision.requestedPath, decisions: [] });
      grouped.get(path).decisions.push({ ...decision, bindingKey: attribute.bindingKey,
        routeKey: attribute.routeKey, rowId: attribute.rowId });
    }
  }
  return [...grouped.values()];
}

function CategoryRequirement({ requirement, observation, revision, actions, busy, canCreate, run, invalidatePreview }) {
  const [bindingKey, setBindingKey] = useState('');
  const { path, decisions } = requirement;
  const selectedKey = decisions.length === 1 ? decisions[0].bindingKey : bindingKey;
  const found = observation.categories.filter((category) => category.comparable && category.normalizedPath === path);
  const parentPath = path.split('/').slice(0, -1).join('/');
  const parents = observation.categories.filter((category) => category.comparable && category.normalizedPath === parentPath);
  const recorded = actions.find((action) => action.path === path && action.state !== 'superseded');
  const canPrepare = found.length === 0 && canCreate && revision.state === 'draft' && (!recorded || recorded.canReview);
  return <section aria-label={`Категорія Magento: ${path}`} className="border-t py-3 text-sm space-y-2">
    <p className="break-words">{requirement.label} · {found.length === 1 ? 'Знайдено' : found.length > 1 ? 'Неоднозначно' : 'Відсутня'}</p>
    {decisions.length > 1 && <p>Використань у відповідностях: {decisions.length}.</p>}
    {canPrepare && <div className="space-y-2">
      {decisions.length > 1 && <label className="block">Призначення категорії
        <select className="input" value={bindingKey} disabled={busy} onChange={(event) => { invalidatePreview(); setBindingKey(event.target.value); }}>
          <option value="">Оберіть відповідність для перевірки</option>
          {decisions.map((decision) => <option key={decision.bindingKey} value={decision.bindingKey}>{decision.routeKey || decision.bindingKey}{decision.rowId ? ` · ${decision.rowId}` : ''}</option>)}
        </select>
      </label>}
      {parents.length === 1 ? <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !selectedKey} onClick={() => run('preview', {
        bindingRevisionId: revision.id, expectedRevision: revision.revision, bindingKey: selectedKey,
        path, parentId: Number(parents[0].categoryId),
      })}>Перевірити створення під {parentPath}</button> : <p>Потрібен однозначний батьківський шлях: {parentPath}.</p>}
    </div>}
    <MagentoDetails summary="Відповідності та технічні свідчення">{() => <>
      {found.map((category) => <p key={category.categoryId}>Magento ID: {category.categoryId}</p>)}
      {decisions.map((decision, index) => <article key={`${decision.bindingKey}:${index}`} className="border-t py-2">
        <p>{decision.routeKey || 'Маршрут не вказано'} · {decision.bindingKey}</p>
        <pre className="overflow-auto text-xs">{JSON.stringify(decision, null, 2)}</pre>
      </article>)}
    </>}</MagentoDetails>
  </section>;
}

function CategoryActionsWorkspace({ revision, observation, categoryCode, onResourceChanged }) {
  const { permissions } = useAuth();
  const [preview, setPreview] = useState(null); const [actions, setActions] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0); const inFlight = useRef(false);
  const canCreate = permissions.includes('export_templates.manage') && permissions.includes('export_templates.publish')
    && !revision?.catalogAvailability?.publicationBlocked;
  useEffect(() => {
    const controller = new AbortController(); const requests = sequence;
    api.get(`${root}/actions`, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(data)) throw Error();
      setActions((current) => [...current, ...data.filter((item) => !current.some((action) => action.id === item.id))]);
    }).catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати історію створення.'); });
    return () => { controller.abort(); ++requests.current; };
  }, []);
  async function run(name, command) {
    if (inFlight.current || !canCreate) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      const { data } = await api.post(`${root}/categories/${name}`, command);
      if (current !== sequence.current) return;
      if (name === 'preview') setPreview({ command, proof: data });
      else { setPreview(null); setActions((old) => [data, ...old.filter((row) => row.id !== data.id)]);
        if (data.state === 'verified') onResourceChanged?.(); }
    } catch (cause) {
      if (current !== sequence.current) return;
      setPreview(null); setError(cause.response?.data?.error || 'Не вдалося завершити дію.');
      const id = cause.response?.data?.details?.actionId;
      if (id) {
        try {
          const { data } = await api.get(`${root}/actions/${id}`);
          if (current === sequence.current) setActions((old) => [data, ...old.filter((row) => row.id !== id)]);
        } catch {
          if (current === sequence.current) setError('Надсилання могло відбутися. Оновіть сторінку для перевірки збереженої дії; не повторюйте створення.');
        }
      }
    } finally {
      if (current === sequence.current) { inFlight.current = false; setBusy(false); }
    }
  }
  const requirements = groupRequirements(revision, categoryCode);
  const paths = new Set(requirements.map((requirement) => requirement.path));
  const relevant = (action) => action.state !== 'superseded' && (paths.has(action.path)
    || (!categoryCode && !['verified', 'superseded'].includes(action.state)));
  const categoryActions = actions.filter((action) => action.kind === 'category');
  const history = categoryActions.filter((action) => !relevant(action));
  const actionRow = (action) => <article className="border-t py-3 text-sm" key={action.id}>
    <p className="break-words">{action.path} · {action.message}</p>
    {action.canReconcile && canCreate && <button className="btn btn-outline btn-compact-md mt-2" disabled={busy} onClick={() => run('reconcile', { actionId: action.id })}>Перевірити результат читанням</button>}
    <MagentoDetails summary="Технічні деталі">{() => <p>{action.id} · {action.state}{action.remoteId ? ` · Magento ID ${action.remoteId}` : ''}</p>}</MagentoDetails>
  </article>;
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">Категорії Magento</h2>
    <p className="text-sm">Створення категорії та підтвердження зв’язку — окремі дії. Нові категорії активні, але приховані з меню.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {!observation && <p className="text-sm text-slate-500">Спочатку перевірте структуру Magento.</p>}
    {observation && requirements.map((requirement) => <CategoryRequirement key={requirement.path} requirement={requirement} observation={observation}
      revision={revision} actions={actions} busy={busy} canCreate={canCreate} run={run} invalidatePreview={() => setPreview(null)} />)}
    {preview && preview.proof.bindingRevisionId === revision?.id && preview.proof.expectedRevision === revision?.revision && <Notice>
      <p>Створити одну категорію: {preview.proof.path}. Батьківський розділ: {preview.proof.parentPath || preview.proof.parentId} · ID {preview.proof.parentId}. У меню не додаватиметься.</p>
      <p>Саме створення змінює 0 товарів. Прив’язку не застосовано; точний вплив правила перевіряється окремо перед публікацією.</p>
      <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-compact-md" disabled={busy || !canCreate} onClick={() => run('apply', { ...preview.command, previewToken: preview.proof.previewToken })}>Створити підкатегорію</button>
        <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => setPreview(null)}>Скасувати</button></div>
    </Notice>}
    {categoryActions.filter(relevant).map(actionRow)}
    {history.length > 0 && <MagentoDetails summary={`Історія інших дій (${history.length})`}>{() => history.map(actionRow)}</MagentoDetails>}
  </section>;
}

export default function MagentoCategoryActions(props) {
  const context = `${props.revision?.id}:${props.revision?.revision}:${props.categoryCode || ''}:${props.observation?.observedAt || ''}`;
  return <CategoryActionsWorkspace key={context} {...props} />;
}
