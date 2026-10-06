import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { LoadingState, Notice, StatusBadge } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import { withRepairContext } from '../../lib/magento-repair-context.js';

const root = '/admin/magento-integration';
const kinds = { route: 'Набір атрибутів', attribute: 'Атрибут', option: 'Значення', category: 'Категорія Magento', policy: 'Правило доставки' };
const states = { proposed: 'Кандидат', review_required: 'Потрібна перевірка', approved: 'Підтверджено', blocked: 'Відмову розглянуто', not_applicable: 'Не застосовується' };
const policies = ['authoritative_create_update', 'initialize_create_only', 'magento_managed'];
const requiresReview = (entry) => !['approved', 'blocked', 'not_applicable'].includes(entry.reviewState);

function Evidence({ entry }) {
  return <MagentoDetails summary="Свідчення перевірки">{() => <>
    <p className="text-xs">{entry.group} · {entry.target} · {entry.id}</p>
    {entry.identity && <p className="text-xs">Magento: {entry.identity}</p>}
    {entry.source && <p className="text-xs">Джерело Amber: {entry.source}</p>}
    <pre className="overflow-auto text-xs">{JSON.stringify(entry.evidence, null, 2)}</pre>
    {entry.note && <p>{entry.note}</p>}
  </>}</MagentoDetails>;
}

function Decision({ entry, revision, busy, act }) {
  const [reason, setReason] = useState(''); const [identity, setIdentity] = useState('');
  const [policy, setPolicy] = useState(() => policies.includes(entry.identity) ? entry.identity : '');
  const attribute = revision.bindings.attributes.find((item) => item.bindingKey === entry.id.split(':')[1]);
  const remote = revision.schema.attributes.find((item) => item.attribute_code === attribute?.attributeCode);
  const choices = entry.kind === 'route' ? revision.schema.attributeSets.map((set) => ({ id: set.attribute_set_id, label: set.attribute_set_name }))
    : entry.kind === 'category' ? (entry.candidates || []).map((category) => ({ id: category.categoryId, label: category.path }))
      : entry.kind === 'option' ? (remote?.options || []).filter((option) => !option.isEmpty).map((option) => ({ id: option.value, label: option.label })) : [];
  const base = { expectedRevision: revision.revision, binding: entry.id };
  return <article className="space-y-2 border-t py-3" aria-label={`${kinds[entry.kind]}: ${entry.label || entry.target}`}>
    <p className="text-sm"><strong>{kinds[entry.kind]}</strong> · {entry.label || 'не визначено'} <StatusBadge>{states[entry.reviewState] || 'Потрібна перевірка'}</StatusBadge></p>
    {entry.evaluated && <p className="text-sm">Значення за правилом Amber: {entry.evaluated}</p>}
    {choices.length > 0 && <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Кандидат<select className="input" value={identity} disabled={busy} onChange={(event) => setIdentity(event.target.value)}><option value="">Оберіть точну відповідність</option>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label} / {choice.id}</option>)}</select></label>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !identity || (entry.kind === 'option' && !entry.evaluated)} onClick={() => act('select', { ...base, identity: entry.kind === 'route' ? Number(identity) : identity })}>Вибрати кандидата</button></div>}
    {entry.kind === 'policy' && <label className="block text-sm">Доставка поля<select className="input" value={policy} disabled={busy} onChange={(event) => setPolicy(event.target.value)}>
      <option value="">Оберіть правило доставки</option><option value="authoritative_create_update">Створення та оновлення</option><option value="initialize_create_only">Лише під час створення{entry.target === 'product_online' ? ' · вимкнений товар' : ''}</option><option value="magento_managed">Зберігати значення Magento</option>
    </select></label>}
    <label className="block text-sm">Пояснення перевірки<input className="input" maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !entry.identity || (!entry.exact && !reason.trim()) || (entry.kind === 'policy' && !policies.includes(policy))} onClick={() => act('decision', { ...base, action: 'approve', acceptReview: true, ...(reason ? { reason } : {}), ...(entry.kind === 'policy' ? { policy, ...(entry.target === 'product_online' && entry.row === 'base' && policy === 'initialize_create_only' ? { createValue: '2' } : {}) } : {}) })}>Підтвердити зв’язок</button>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !reason.trim()} onClick={() => act('decision', { ...base, action: 'block', reason })}>Відмовити з поясненням</button></div>
    <Evidence entry={entry} />
  </article>;
}

function ReviewEntries({ review, categoryCode, field, canManage, busy, act }) {
  const [showAll, setShowAll] = useState(Boolean(field)); const [page, setPage] = useState(0);
  const entries = review.entries.filter((entry) => (!categoryCode || entry.group === categoryCode) && (!field || entry.target === field));
  const issues = entries.filter(requiresReview);
  const displayed = showAll ? entries : issues;
  const pages = Math.max(1, Math.ceil(displayed.length / 50)); const current = Math.min(page, pages - 1);
  return <div className="space-y-3">
    {field && <p className="text-sm">Перевіряємо поле: <strong>{field}</strong></p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm">Потребують перевірки: {issues.length}. Усього відповідностей: {entries.length}.</p>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => { setShowAll(!showAll); setPage(0); }}>{showAll ? 'Показати лише невирішені' : 'Показати всі відповідності'}</button>
    </div>
    {!displayed.length && <p>Невирішених відповідностей немає. Підтверджені зв’язки та розглянуті відмови доступні в повному списку.</p>}
    {displayed.slice(current * 50, (current + 1) * 50).map((entry) => canManage && review.revision.state === 'draft'
      ? <Decision key={`${review.revision.revision}:${entry.id}`} entry={entry} revision={review.revision} busy={busy} act={act} />
      : <article className="space-y-2 border-t py-3" key={entry.id}><p className="text-sm">{kinds[entry.kind]} · {entry.label || '—'} · {states[entry.reviewState]}</p><Evidence entry={entry} /></article>)}
    {pages > 1 && <nav aria-label="Сторінки відповідностей" className="flex items-center gap-3">
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || current === 0} onClick={() => setPage(current - 1)}>Назад</button>
      <span className="text-sm" aria-live="polite">{current + 1} / {pages}</span>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || current === pages - 1} onClick={() => setPage(current + 1)}>Далі</button>
    </nav>}
  </div>;
}

function BindingReviewWorkspace({ revision, templateVersions = [], onChanged, mode = 'all', categoryCode, field, currentPublishedId, initialTemplateVersionId, guided = false, refreshing = false, repairContext = {}, taskIntent }) {
  const { permissions } = useAuth(); const canManage = permissions.includes('export_templates.manage');
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [versionId, setVersionId] = useState(templateVersions.some((item) => item.id === initialTemplateVersionId) ? initialTemplateVersionId : ''); const [preparation, setPreparation] = useState(null);
  const sequence = useRef(0); const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); const requests = sequence; const current = ++requests.current;
    if (mode !== 'successor') api.get(`${root}/bindings/${revision.id}`, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted && current === requests.current) setReview(data);
    }).catch((cause) => { if (!controller.signal.aborted && current === requests.current) setError(cause.response?.data?.error || 'Не вдалося прочитати перевірку.'); });
    return () => { controller.abort(); ++requests.current; };
  }, [revision.id, mode]);
  async function action(path, payload, complete) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError('');
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current) complete(data); }
    catch (cause) { if (current === sequence.current) { setPreparation(null); setError(cause.response?.data?.error || 'Дію не завершено. Повторіть перевірку.'); } }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  const request = { sourceId: revision.id, expectedSourceRevision: revision.revision, templateVersionId: versionId };
  const isCurrent = currentPublishedId === undefined || currentPublishedId === revision.id;
  const reviewEntries = review && <ReviewEntries review={review} categoryCode={categoryCode} field={field} canManage={canManage && !review?.revision.catalogAvailability?.publicationBlocked} busy={busy}
    act={(name, body) => action(`bindings/${revision.id}/${name}`, body, onChanged)} />;
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">{mode === 'successor' ? guided ? refreshing ? 'Продовжити підключення' : 'Почати зміну налаштувань' : 'Підготовка наступної версії' : 'Перевірка відповідностей'}</h2>
    {error && <Notice tone="error">{error}</Notice>}
    <p className="text-sm">{revision.state === 'published' ? 'Опублікована версія незмінна. Подальші зміни готуються окремою чернеткою.' : 'Чернетка не змінює поточну доставку. Вибір кандидата та підтвердження — окремі дії.'}</p>
    {revision.templateId && <Link className="text-sm underline" to={withRepairContext(`/admin/magento/rules/${revision.templateId}`, repairContext, { version: revision.templateVersionId, ...(taskIntent ? { intent: taskIntent } : {}), ...(categoryCode ? { category: categoryCode } : {}), ...(field ? { field } : {}) })}>Правила передачі цієї категорії</Link>}
    {mode !== 'review' && revision.state === 'published' && !isCurrent && <Notice>Це попередня публікація. Наступну чернетку потрібно готувати від чинної опублікованої версії.</Notice>}
    {mode !== 'review' && canManage && revision.state === 'published' && isCurrent && <>
      {(!guided || refreshing) && <p className="text-sm">{guided ? 'Перевіримо нові дані Magento. Підтверджені чинні налаштування збережуться; неопубліковані рішення попередньої підготовки потрібно переглянути повторно.' : 'Після створення ресурсів Magento підготуйте нову чернетку зі свіжим спостереженням. Попередня чернетка не оновлюється; її неопубліковані рішення автоматично не переносяться.'}</p>}
      <details open={!guided || !versionId}><summary>{guided ? 'Правила, на основі яких готуємо зміни' : 'Вибір опублікованого шаблону'}</summary><label className="block text-sm">Опублікований шаблон наступної версії<select className="input" value={versionId} disabled={busy} onChange={(event) => { setPreparation(null); setVersionId(event.target.value); }}><option value="">Оберіть версію</option>{templateVersions.map((version) => <option key={version.id} value={version.id}>{version.display_name} · {version.version_number}</option>)}</select></label></details>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !versionId} onClick={() => action('successor/prepare', request, setPreparation)}>{guided ? refreshing ? 'Перевірити підключення нових даних' : 'Перевірити налаштування перед зміною' : 'Перевірити наступну чернетку зі свіжою структурою Magento'}</button>
      {preparation && <div className="space-y-2"><p>Підтверджень перенесено з чинної публікації: {preparation.carried.approvalsCarried}. Нові або змінені рішення потребують окремої перевірки.</p><p>Перевірено наявних товарів: {preparation.productIds.length}. Приклади CREATE перевірте після підготовки чернетки.</p>
        {preparation.blockers.map((blocker, index) => <p key={index}>{blocker.message || blocker.code}</p>)}
        <button type="button" className="btn btn-primary btn-compact-md" disabled={busy} onClick={() => action('successor/apply', { ...request, previewToken: preparation.previewToken }, onChanged)}>{guided ? 'Зберегти підготовку і продовжити' : 'Підготувати наступну чернетку'}</button></div>}
      <MagentoDetails summary="Точна копія без нового спостереження">{() => <>
        <p className="text-sm">Копія зберігає заморожене спостереження чинної публікації. Нові ресурси Magento до нього не потраплять.</p>
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => action(`bindings/${revision.id}/clone`, { expectedRevision: revision.revision }, onChanged)}>Створити точну чернетку</button>
      </>}</MagentoDetails>
    </>}
    {mode !== 'successor' && review && <><p className="text-sm">{review.validation.valid ? 'Структурна перевірка пройдена. Можливість надсилання товарів перевіряється окремо.' : `Невирішених структурних питань: ${review.validation.diagnostics.length}`}</p>
      {mode === 'review' ? reviewEntries : <MagentoDetails summary="Рішення за маршрутами та полями">{reviewEntries}</MagentoDetails>}
    </>}
    {mode !== 'successor' && !review && !error && <LoadingState label="Читаємо відповідності…" />}
    {busy && <LoadingState label="Перевіряємо відповідності…" />}
  </section>;
}

export default function MagentoBindingReview(props) {
  if (!props.revision) return null;
  return <BindingReviewWorkspace key={`${props.revision.id}:${props.revision.revision}:${props.categoryCode || ''}:${props.mode || 'all'}:${props.currentPublishedId}`} {...props} />;
}
