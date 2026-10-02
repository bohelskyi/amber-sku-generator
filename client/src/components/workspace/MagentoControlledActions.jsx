import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import MagentoPublicationActions from './MagentoPublicationActions.jsx';

const root = '/admin/magento-integration';
const titles = { name_rule: 'Застосувати правило назв', broader_resync: 'Повторна синхронізація вибраних товарів' };
const blockers = { RECONCILIATION_REQUIRED: 'Раніше відправлену зміну ще не підтверджено. Повторна відправка заборонена.',
  NAME_CONFLICT_OR_BASELINE_REQUIRED: 'Спочатку вирішіть конфлікт або підтвердьте спільний стан назв.',
  INVALID_GENERATED_NAMES: 'Правило не формує дві допустимі назви.' };

function ControlledWorkspace({ revision, kind, onApplied }) {
  const [candidates, setCandidates] = useState(null); const [selected, setSelected] = useState([]);
  const [productCursors, setProductCursors] = useState([0]); const [productPage, setProductPage] = useState(0);
  const [search, setSearch] = useState(''); const [reason, setReason] = useState('');
  const [review, setReview] = useState(null); const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0); const inFlight = useRef(false);
  useEffect(() => { const requests = sequence; return () => { ++requests.current; }; }, []);
  async function action(path, payload, complete) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError(''); setReceipt(null);
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current) complete(data); }
    catch (cause) { if (current === sequence.current) { setReview(null); setError(cause.response?.data?.error || 'Дані змінилися або дія не завершилася. Повторіть перевірку.'); } }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  async function loadProducts(cursor = 0, page = 0, reset = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError(''); setReview(null);
    try {
      const { data } = await api.get(`${root}/bindings/${revision.id}/controlled-products`, { params: { after: cursor, search } });
      if (current === sequence.current) { setCandidates(data); setProductPage(page); if (reset) setProductCursors([0]); }
    } catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати товари.'); }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  function invalidate() { ++sequence.current; setReview(null); setReceipt(null); }
  const request = { bindingRevisionId: revision.id, expectedRevision: revision.revision, kind, productIds: selected, reason };
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">{titles[kind]}</h2>
    <p className="text-sm">{kind === 'name_rule' ? 'Перегляньте обидві назви для кожного вибраного товару перед застосуванням правила.' : 'Обирайте лише товари, яким потрібна повторна синхронізація.'} Непідтверджені відправлення не скидаються і не повторюються.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {receipt && <Notice tone="success"><p>Контрольовану дію збережено. Фактичний результат доставки перевіряйте за станом передачі товарів.</p><MagentoDetails summary="Деталі збереженої дії">{() => <pre className="overflow-auto text-xs">{JSON.stringify(receipt, null, 2)}</pre>}</MagentoDetails></Notice>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); loadProducts(0, 0, true); }}>
      <label className="text-sm">Пошук за артикулом<input className="input" maxLength={100} disabled={busy} value={search} onChange={(event) => { invalidate(); setSearch(event.target.value); setCandidates(null); }} /></label>
      <button type="submit" className="btn btn-outline btn-compact-md" disabled={busy}>Перевірити товари для контрольованої дії</button>
    </form>
    {selected.length > 0 && <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => { invalidate(); setSelected([]); }}>Очистити вибір</button>}
    {candidates && <>
      {candidates.products.map((product) => <label key={product.productId} className="block text-sm break-words"><input type="checkbox" checked={selected.includes(product.productId)} disabled={busy || (!selected.includes(product.productId) && selected.length >= 100) || product.blockers.includes('RECONCILIATION_REQUIRED') || (kind === 'name_rule' && (!product.changed || product.blockers.length > 0))}
        onChange={(event) => { invalidate(); setSelected(event.target.checked ? [...selected, product.productId] : selected.filter((id) => id !== product.productId)); }} /> {product.article} · {product.before.all || 'Назва не сформована'}
        {kind === 'name_rule' && <> → {product.after.all}; {product.before.en} → {product.after.en}</>}
        {product.blockers.length > 0 && <span className="block text-amber-800">{product.blockers.map((code) => blockers[code] || 'Потрібна перевірка').join(' ')}</span>}</label>)}
      <nav aria-label="Вибір товарів для контрольованої дії" className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || productPage === 0} onClick={() => loadProducts(productCursors[productPage - 1], productPage - 1)}>Попередні товари</button>
        <span aria-live="polite">Сторінка {productPage + 1} · вибрано {selected.length} / 100</span>
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || candidates.nextCursor == null} onClick={() => { setProductCursors([...productCursors.slice(0, productPage + 1), candidates.nextCursor]); loadProducts(candidates.nextCursor, productPage + 1); }}>Наступні товари</button>
      </nav>
      {!candidates.products.length && <p>Товарів за цим пошуком немає.</p>}
      <p className="text-sm text-slate-500">Вибір зберігається між сторінками. Перед підтвердженням сервер перевіряє весь точний вибір.</p>
      <label className="block text-sm">Пояснення контрольованої дії<input className="input" maxLength={2000} value={reason} disabled={busy} onChange={(event) => { invalidate(); setReason(event.target.value); }} /></label>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !selected.length || reason.trim().length < 3} onClick={() => action('controlled/preview', request, setReview)}>Перевірити вибрану дію</button>
    </>}
    {review && <>
      {review.blockers.length > 0 && <Notice tone="warning"><ul>{review.blockers.map((blocker, index) => <li key={index}>{blockers[blocker.code] || 'Потрібно перевірити відповідності.'}</li>)}</ul><Link className="underline" to="/sync-problems">Проблеми синхронізації</Link></Notice>}
      <p>Вибрано товарів: {review.products.length}.</p>
      {review.products.map((product) => <p className="text-sm break-words" key={product.productId}>{product.article}{kind === 'name_rule' && <>: {product.before.all} → {product.after.all}; {product.before.en} → {product.after.en}</>}</p>)}
      <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || review.blockers.length > 0} onClick={() => action('controlled/apply', { ...request, previewToken: review.previewToken }, (data) => { setReview(null); setCandidates(null); setSelected([]); setReceipt(data); onApplied?.(data); })}>Підтвердити контрольовану дію</button>
    </>}
    {busy && <LoadingState label="Перевіряємо точний вибір товарів…" />}
    {receipt && <MagentoPublicationActions revision={revision} currentPublishedId={revision.id} />}
  </section>;
}

export default function MagentoControlledActions(props) {
  const auth = useAuth();
  const canApply = isActualAdministrator(auth) && ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => auth.permissions.includes(permission))
    && (props.kind !== 'name_rule' || auth.permissions.includes('exports.create'));
  if (!Object.hasOwn(titles, props.kind)) return null;
  if (!canApply) return <Notice>Для цієї дії потрібні права Адміністратора.</Notice>;
  if (props.revision?.state !== 'published' || props.currentPublishedId !== props.revision?.id) return <Notice>Для контрольованої дії потрібна чинна опублікована версія.</Notice>;
  return <ControlledWorkspace key={`${props.revision.id}:${props.revision.revision}:${props.kind}`} {...props} />;
}
