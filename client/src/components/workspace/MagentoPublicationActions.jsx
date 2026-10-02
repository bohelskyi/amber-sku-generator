import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
const root = '/admin/magento-integration';
const empty = [];
const blockers = { REPRESENTATIVE_CREATE_REQUIRED: 'Потрібен готовий приклад CREATE для маршруту',
  AFFECTED_CURRENT_PREVIEW_BLOCKED: 'Приклад наявного товару ще не готовий до доставки',
  RECONCILIATION_REQUIRED: 'Раніше відправлену зміну ще не підтверджено. Повторна відправка заборонена.',
  NAME_CONFLICT_OR_BASELINE_REQUIRED: 'Спочатку вирішіть конфлікт або підтвердьте спільний стан назв.',
  INVALID_GENERATED_NAMES: 'Правило не формує дві допустимі назви.' };
function Problems({ items }) {
  return items.length > 0 && <Notice tone="warning"><ul>{items.map((b, i) => <li key={i}>{blockers[b.code] || 'Потрібно перевірити відповідності.'}{b.routeKey ? ` · ${b.routeKey}` : ''}{b.productId ? ` · товар ${b.productId}` : ''}</li>)}</ul><Link className="underline" to="/sync-problems">Проблеми синхронізації</Link></Notice>;
}
function ReviewList({ items, label, render }) {
  const [page,setPage]=useState(0),pages=Math.ceil(items.length/50);
  const current=Math.min(page,Math.max(0,pages-1));
  return <div className="space-y-2">{items.slice(current*50,(current+1)*50).map(render)}
    {pages>1 && <nav aria-label={label} className="flex items-center gap-2 text-sm">
      <button type="button" className="btn btn-outline btn-compact-md" disabled={current===0} onClick={()=>setPage(current-1)}>Назад</button>
      <span>{current+1} / {pages} · усього {items.length}</span>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={current===pages-1} onClick={()=>setPage(current+1)}>Далі</button>
    </nav>}
  </div>;
}
export default function MagentoPublicationActions({ revision, currentPublishedId, representatives = empty, onPublished }) {
  const { permissions } = useAuth();
  const canPublish = ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((p) => permissions.includes(p));
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ack, setAck] = useState(false); const [reason, setReason] = useState('');
  const [status, setStatus] = useState([]); const [refresh, setRefresh] = useState(0);
  const [candidates, setCandidates] = useState(null); const [selected, setSelected] = useState([]);
  const [productCursors,setProductCursors]=useState([0]); const [productPage,setProductPage]=useState(0);
  const [kind, setKind] = useState('broader_resync'); const [actionReason, setActionReason] = useState('');
  const [actionReview, setActionReview] = useState(null); const sequence = useRef(0);
  useEffect(() => () => { ++sequence.current; }, []);
  useEffect(() => {
    if (revision?.state !== 'published') return undefined;
    const controller = new AbortController(); let timer;
    const read = async () => {
      try {
        const { data } = await api.get(`${root}/bindings/${revision.id}/handoffs`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(data);
        if (data.some((s) => s.pending_handoff > 0 || s.waiting > 0)) timer = setTimeout(read, 5000);
      } catch (cause) { if (!controller.signal.aborted) setError(cause.response?.data?.error || 'Не вдалося прочитати стан передачі товарів.'); }
    };
    read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision?.id, revision?.state, refresh]);
  if (!revision) return null;
  async function action(path, payload, complete) {
    const current = ++sequence.current; setBusy(true); setError('');
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current) complete(data); }
    catch (cause) { if (current === sequence.current) { setReview(null); setActionReview(null); setError(cause.response?.data?.error || 'Дані змінилися або дія не завершилася. Повторіть перевірку.'); } }
    finally { if (current === sequence.current) setBusy(false); }
  }
  async function loadProducts(cursor=0,page=0,reset=false) {
    const current = ++sequence.current; setBusy(true); setError(''); setActionReview(null);
    try { const { data } = await api.get(`${root}/bindings/${revision.id}/controlled-products`, {params:{after:cursor}}); if (current === sequence.current) { setCandidates(data); setProductPage(page); if(reset){setSelected([]);setProductCursors([0]);} } }
    catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати товари.'); }
    finally { if (current === sequence.current) setBusy(false); }
  }
  function invalidate() { ++sequence.current; setBusy(false); setActionReview(null); }
  const request = { bindingRevisionId: revision.id, expectedRevision: revision.revision, expectedCurrentId: currentPublishedId,
    representatives: representatives.map((r) => r.input) };
  const controlled = { bindingRevisionId: revision.id, expectedRevision: revision.revision, kind, productIds: selected, reason: actionReason };
  const loss = Boolean(review && (review.lostRoutes.length || review.lostProducts.length));
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">Публікація та передача товарів</h2>
    {error && <Notice tone="error">{error}</Notice>}
    {revision.state === 'draft' ? <>
      <p className="text-sm">Публікація змінить правила доставки. Чинні назви товарів зберігаються; застосування нового правила назв — окрема контрольована дія.</p>
      <p className="text-sm">Перевірених прикладів CREATE: {representatives.length}. Нові маршрути потребують готового прикладу у розділі «Перевірка товару».</p>
      {canPublish && <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => action('publication/preview', request, setReview)}>Перевірити вплив публікації</button>}
      {review && <div className="space-y-3"><p>Перевірено поточних товарів: {review.totalProducts}. До синхронізації буде передано: {review.affected.length}. Назв збережено: {review.preservedNames.length}.</p>
        <Problems items={review.blockers} />
        {review.affected.length > 0 && <details><summary>Точний перелік товарів для доставки</summary><ReviewList key={review.previewToken} items={review.affected} label="Товари для доставки" render={(p) => <p key={p.productId}>{p.article} · {p.reason === 'unblocked' ? 'Готовність відновлено' : 'Змінилась доставка'}</p>} /></details>}
        {review.preservedNames.length > 0 && <details><summary>Вплив нового правила назв</summary><ReviewList key={review.previewToken} items={review.preservedNames} label="Вплив на назви" render={(p) => <p className="text-sm" key={p.productId}>{p.article}: {p.before.all} → {p.generated.all}; {p.before.en} → {p.generated.en}. Чинні назви залишаться без змін.</p>} /></details>}
        {loss && <Notice tone="warning"><p>Покриття буде скорочено. Потрібне підтвердження Адміністратора.</p><p>Маршрути: {review.lostRoutes.join(', ') || 'без втрат'}</p>
          <ReviewList key={review.previewToken} items={review.lostProducts} label="Втрата покриття" render={(p) => <p key={p.productId}>{p.article} · {p.routeKey}</p>} />
          <label className="block text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Підтверджую точну втрату покриття</label>
          <label className="block text-sm">Пояснення скорочення<input className="input" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label></Notice>}
        {canPublish && <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || review.blockers.length > 0 || (loss && (!ack || reason.trim().length < 3))}
          onClick={() => action('publication/apply', { ...request, previewToken: review.previewToken, ...(loss ? { ackCoverageLoss: ack, coverageReason: reason } : {}) }, (data) => onPublished(data.revision))}>Опублікувати відповідності</button>}
      </div>}
    </> : <>
      <p className="text-sm">Опублікована версія незмінна. Передача товарів зберігається в Amber: можна залишити сторінку й повернутися пізніше.</p>
      {status.map((s) => <article className="space-y-1 border-t py-2 text-sm" key={s.id}><p>{s.kind === 'publication' ? 'Після публікації' : s.kind === 'name_rule' ? 'Застосування правила назв' : 'Контрольована повторна синхронізація'} · {new Date(s.created_at).toLocaleString('uk-UA')}</p>
        <p>Magento: {s.synced} / {s.total} синхронізовано · {s.waiting} очікують · {s.pending_handoff} ще не передано · {s.needs_attention} потребують уваги</p>
        {s.protected > 0 && <p>Не передано через непідтверджену попередню роботу: {s.protected}. <Link className="underline" to="/sync-problems">Перевірити проблеми</Link></p>}
        {s.retired > 0 && <p>Товари більше не актуальні: {s.retired}</p>}
      </article>)}
      <button type="button" className="btn btn-outline btn-compact-md" onClick={() => setRefresh((n) => n + 1)}>Оновити стан передачі</button>
      {canPublish && currentPublishedId === revision.id && <details><summary>Контрольовані дії Адміністратора</summary><div className="space-y-3 pt-3">
        <p className="text-sm">Обирайте лише потрібні товари. Непідтверджені відправлення не скидаються і не повторюються.</p>
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={()=>loadProducts(0,0,true)}>Перевірити товари для контрольованої дії</button>
        {candidates && <><label className="block text-sm">Дія<select className="input" value={kind} onChange={(e) => { invalidate(); setKind(e.target.value); setSelected([]); }}><option value="broader_resync">Повторно синхронізувати вибрані товари</option><option value="name_rule">Застосувати нове правило назв</option></select></label>
          {candidates.products.map((p) => <label key={p.productId} className="block text-sm"><input type="checkbox" checked={selected.includes(p.productId)} disabled={(!selected.includes(p.productId) && selected.length>=100) || p.blockers.includes('RECONCILIATION_REQUIRED') || (kind === 'name_rule' && (!p.changed || p.blockers.length > 0))}
            onChange={(e) => { invalidate(); setSelected(e.target.checked ? [...selected, p.productId] : selected.filter((id) => id !== p.productId)); }} /> {p.article} · {p.before.all || 'Назва не сформована'}
            {kind === 'name_rule' && <> → {p.after.all}; {p.before.en} → {p.after.en}</>}
            {p.blockers.length > 0 && <span className="block text-amber-800">{p.blockers.map((code) => blockers[code] || 'Потрібна перевірка').join(' ')}</span>}</label>)}
          <nav aria-label="Вибір товарів для контрольованої дії" className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || productPage===0} onClick={()=>loadProducts(productCursors[productPage-1],productPage-1)}>Попередні товари</button>
            <span>Сторінка {productPage+1} · вибрано {selected.length} / 100</span>
            <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || candidates.nextCursor==null} onClick={()=>{setProductCursors([...productCursors.slice(0,productPage+1),candidates.nextCursor]);loadProducts(candidates.nextCursor,productPage+1);}}>Наступні товари</button>
          </nav>
          <p className="text-sm text-slate-500">Вибір зберігається між сторінками. Кожна сторінка показує поточні дані; перед підтвердженням перевіряється весь точний вибір.</p>
          <label className="block text-sm">Пояснення контрольованої дії<input className="input" maxLength={2000} value={actionReason} onChange={(e) => { invalidate(); setActionReason(e.target.value); }} /></label>
          <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !selected.length || actionReason.trim().length < 3 || (kind === 'name_rule' && !permissions.includes('exports.create'))} onClick={() => action('controlled/preview', controlled, setActionReview)}>Перевірити вибрану дію</button>
        </>}
        {actionReview && <><Problems items={actionReview.blockers} /><p>Вибрано товарів: {actionReview.products.length}.</p>
          {kind === 'name_rule' && actionReview.products.map((p) => <p className="text-sm" key={p.productId}>{p.article}: {p.before.all} → {p.after.all}; {p.before.en} → {p.after.en}</p>)}
          <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || actionReview.blockers.length > 0} onClick={() => action('controlled/apply', { ...controlled, previewToken: actionReview.previewToken }, () => { setActionReview(null); setCandidates(null); setSelected([]); setRefresh((n) => n + 1); })}>Підтвердити контрольовану дію</button></>}
      </div></details>}
    </>}
    {busy && <LoadingState label="Перевіряємо вплив та актуальність даних…" />}
  </section>;
}
