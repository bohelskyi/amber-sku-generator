import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { Notice } from '../app/UiPrimitives.jsx';
const root = '/admin/magento-integration';
export default function MagentoCategoryActions({ revision, observation }) {
  const { permissions } = useAuth();
  const [preview, setPreview] = useState(null); const [actions, setActions] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const canCreate = permissions.includes('export_templates.manage') && permissions.includes('export_templates.publish');
  useEffect(() => { let live = true;
    api.get(`${root}/actions`).then(({ data }) => { if (!Array.isArray(data)) throw Error(); if (live) setActions(data); }).catch(() => { if (live) setError('Не вдалося прочитати історію створення.'); });
    return () => { live = false; };
  }, []);
  async function run(name, command) {
    setBusy(true); setError('');
    try {
      const { data } = await api.post(`${root}/categories/${name}`, command);
      if (name === 'preview') setPreview({ command, proof: data });
      else { setPreview(null); setActions((old) => [data, ...old.filter((r) => r.id !== data.id)]); }
    } catch (cause) {
      setPreview(null); setError(cause.response?.data?.error || 'Не вдалося завершити дію.');
      const id = cause.response?.data?.details?.actionId;
      if (id) {
        try { const { data } = await api.get(`${root}/actions/${id}`); setActions((old) => [data, ...old.filter((r) => r.id !== id)]); }
        catch { setError('Надсилання могло відбутися. Оновіть сторінку для перевірки збереженої дії; не повторюйте створення.'); }
      }
    } finally { setBusy(false); }
  }
  const requirements = revision?.bindings.attributes.filter((a) => a.target === 'categories')
    .flatMap((a) => (a.evidence.categories || []).map((d) => ({ ...d, bindingKey: a.bindingKey }))) || [];
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">Категорії Magento</h2>
    <p className="text-sm">Створення категорії та підтвердження зв’язку — окремі дії. Нові категорії активні, але приховані з меню.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {!observation && <p className="text-sm text-slate-500">Спочатку перевірте структуру Magento.</p>}
    {observation && requirements.map((d) => {
      const found = observation.categories.filter((c) => c.comparable && c.normalizedPath === d.normalizedPath);
      const parentPath = d.normalizedPath.split('/').slice(0, -1).join('/');
      const parents = observation.categories.filter((c) => c.comparable && c.normalizedPath === parentPath);
      const recorded = actions.find((r) => r.path === d.normalizedPath);
      return <div className="border-t py-3 text-sm" key={`${d.bindingKey}:${d.normalizedPath}`}>
        <p className="break-words">{d.requestedPath} · {found.length === 1 ? `ID ${found[0].categoryId}` : found.length > 1 ? 'Неоднозначно' : 'Відсутня'}</p>
        {found.length === 0 && canCreate && revision.state === 'draft' && (!recorded || recorded.canReview) && <div className="mt-2 flex flex-wrap gap-2">
          {parents.length === 1 ? <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => run('preview', {
            bindingRevisionId: revision.id, expectedRevision: revision.revision, bindingKey: d.bindingKey,
            path: d.normalizedPath, parentId: Number(parents[0].categoryId),
          })}>Перевірити створення під {parentPath} / {parents[0].categoryId}</button> : <p>Потрібен однозначний батьківський шлях: {parentPath}.</p>}
        </div>}
      </div>;
    })}
    {preview && preview.proof.bindingRevisionId === revision?.id && preview.proof.expectedRevision === revision?.revision && <Notice>
      <p>Створити одну категорію: {preview.proof.path}. Батько: {preview.proof.parentId}. У меню не додаватиметься.</p>
      <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-compact-md" disabled={busy} onClick={() => run('apply', { ...preview.command, previewToken: preview.proof.previewToken })}>Створити підкатегорію</button>
        <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => setPreview(null)}>Скасувати</button></div>
    </Notice>}
    {actions.filter((a) => a.kind === 'category').map((a) => <div className="border-t py-3 text-sm" key={a.id}><p>{a.path} · {a.message}{a.remoteId ? ` · ID ${a.remoteId}` : ''}</p>
      {a.canReconcile && canCreate && <button className="btn btn-outline btn-compact-md mt-2" disabled={busy} onClick={() => run('reconcile', { actionId: a.id })}>Перевірити результат читанням</button>}
      <details><summary>Технічні деталі</summary>{a.id} · {a.state}</details>
    </div>)}
  </section>;
}
