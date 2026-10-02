import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { LoadingState, Notice, StatusBadge } from '../app/UiPrimitives.jsx';
const root = '/admin/magento-integration';
const kinds = { route: 'Набір атрибутів', attribute: 'Атрибут', option: 'Значення', category: 'Категорія Magento', policy: 'Правило доставки' };
const states = { proposed: 'Кандидат', review_required: 'Потрібна перевірка', approved: 'Підтверджено', blocked: 'Заблоковано' };
function Decision({ entry, revision, busy, act }) {
  const [reason, setReason] = useState(''); const [identity, setIdentity] = useState('');
  const [policy, setPolicy] = useState('authoritative_create_update');
  const attribute = revision.bindings.attributes.find((a) => a.bindingKey === entry.id.split(':')[1]);
  const remote = revision.schema.attributes.find((a) => a.attribute_code === attribute?.attributeCode);
  const choices = entry.kind === 'route' ? revision.schema.attributeSets.map((s) => ({ id: s.attribute_set_id, label: s.attribute_set_name }))
    : entry.kind === 'category' ? (entry.candidates || []).map((c) => ({ id: c.categoryId, label: c.path }))
      : entry.kind === 'option' ? (remote?.options || []).filter((o) => !o.isEmpty).map((o) => ({ id: o.value, label: o.label })) : [];
  const base = { expectedRevision: revision.revision, binding: entry.id };
  return <article className="space-y-2 border-t py-3"><p className="text-sm"><strong>{kinds[entry.kind]}</strong> · {entry.group} · {entry.target} · {entry.label || 'не визначено'} <StatusBadge>{states[entry.reviewState]}</StatusBadge></p>
    {entry.source && <p className="text-sm">Значення Amber: {entry.source} → {entry.evaluated || 'Немає правила у шаблоні'}</p>}
    {entry.identity && <p className="text-sm text-slate-500">Magento: {entry.identity}</p>}
    {choices.length > 0 && <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Кандидат<select className="input" value={identity} onChange={(e) => setIdentity(e.target.value)}><option value="">Оберіть точну відповідність</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.label} / {c.id}</option>)}</select></label>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !identity || (entry.kind === 'option' && !entry.evaluated)} onClick={() => act('select', { ...base, identity: entry.kind === 'route' ? Number(identity) : identity })}>Вибрати кандидата</button></div>}
    {entry.kind === 'policy' && <label className="block text-sm">Доставка поля<select className="input" value={policy} onChange={(e) => setPolicy(e.target.value)}><option value="authoritative_create_update">Створення та оновлення</option><option value="initialize_create_only">Лише під час створення{entry.target === 'product_online' ? ' · вимкнений товар' : ''}</option><option value="magento_managed">Зберігати значення Magento</option></select></label>}
    <label className="block text-sm">Пояснення перевірки<input className="input" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !entry.identity || (!entry.exact && !reason.trim())} onClick={() => act('decision', { ...base, action: 'approve', acceptReview: true, ...(reason ? { reason } : {}), ...(entry.kind === 'policy' ? { policy, ...(entry.target === 'product_online' && entry.row === 'base' && policy === 'initialize_create_only' ? { createValue: '2' } : {}) } : {}) })}>Підтвердити зв’язок</button>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !reason.trim()} onClick={() => act('decision', { ...base, action: 'block', reason })}>Відмовити з поясненням</button></div>
    <details className="text-xs"><summary>Свідчення перевірки</summary><pre className="overflow-auto">{JSON.stringify(entry.evidence, null, 2)}</pre></details>
  </article>;
}
export default function MagentoBindingReview({ revision, templateVersions = [], onChanged }) {
  const { permissions } = useAuth(); const canManage = permissions.includes('export_templates.manage');
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [versionId, setVersionId] = useState(''); const [preparation, setPreparation] = useState(null);
  const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const current = ++sequence.current;
    if (revision) api.get(`${root}/bindings/${revision.id}`, { signal: controller.signal }).then(({ data }) => { if (current === sequence.current) setReview(data); })
      .catch((cause) => { if (!controller.signal.aborted && current === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати перевірку.'); });
    return () => { controller.abort(); };
  }, [revision]);
  if (!revision) return null;
  async function action(path, payload, complete) {
    const current = ++sequence.current; setBusy(true); setError('');
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current) complete(data); }
    catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || 'Дію не завершено. Повторіть перевірку.'); }
    finally { if (current === sequence.current) setBusy(false); }
  }
  const request = { sourceId: revision.id, expectedSourceRevision: revision.revision, templateVersionId: versionId };
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">Перевірка відповідностей</h2>
    {error && <Notice tone="error">{error}</Notice>}
    <p className="text-sm">{revision.state === 'published' ? 'Опублікована версія незмінна. Подальші зміни готуються окремою чернеткою.' : 'Чернетка не змінює поточну доставку. Вибір кандидата та підтвердження — окремі дії.'}</p>
    <Link className="text-sm underline" to={`/admin/export-templates/${revision.templateId}?version=${revision.templateVersionId}`}>Правила інтеграційного шаблону</Link>
    {canManage && revision.state === 'published' && <>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => action(`bindings/${revision.id}/clone`, { expectedRevision: revision.revision }, onChanged)}>Створити точну чернетку</button>
      <label className="block text-sm">Опублікований шаблон наступної версії<select className="input" value={versionId} onChange={(e) => { ++sequence.current; setBusy(false); setPreparation(null); setVersionId(e.target.value); }}><option value="">Оберіть версію</option>{templateVersions.map((v) => <option key={v.id} value={v.id}>{v.display_name} · {v.version_number} · {v.evaluator_version}</option>)}</select></label>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !versionId} onClick={() => action('successor/prepare', request, setPreparation)}>Перевірити наступну чернетку зі свіжою структурою Magento</button>
      {preparation && <div className="space-y-2"><p>Підтверджень збережено: {preparation.carried.approvalsCarried}. Нові або змінені рішення потребують окремої перевірки.</p><p>Перевірено наявних товарів: {preparation.productIds.length}. Приклади CREATE перевірте після підготовки чернетки.</p>
        {preparation.blockers.map((b, i) => <p key={i}>{b.code}</p>)}
        <button type="button" className="btn btn-primary btn-compact-md" disabled={busy} onClick={() => action('successor/apply', { ...request, previewToken: preparation.previewToken }, onChanged)}>Підготувати наступну чернетку</button></div>}
    </>}
    {review && <><p className="text-sm">{review.validation.valid ? 'Структурна перевірка пройдена. Preview товарів перевіряється окремо.' : `Невирішених структурних питань: ${review.validation.diagnostics.length}`}</p>
      <details><summary>Рішення за маршрутами та полями</summary>{canManage && revision.state === 'draft' ? review.entries.map((e) => <Decision key={`${revision.revision}:${e.id}`} entry={e} revision={review.revision} busy={busy} act={(name, body) => action(`bindings/${revision.id}/${name}`, body, onChanged)} />)
        : review.entries.map((e) => <p className="text-sm" key={e.id}>{kinds[e.kind]} · {e.group} · {e.target} · {e.label || '—'} · {states[e.reviewState]}</p>)}</details></>}
    {busy && <LoadingState label="Перевіряємо відповідності…" />}
  </section>;
}
