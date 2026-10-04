import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';

const root = '/admin/magento-integration';
const empty = [];
const blockers = { REPRESENTATIVE_CREATE_REQUIRED: 'Потрібен перевірений приклад нового товару. Відкрийте «Приклад на товарі».',
  AFFECTED_CURRENT_PREVIEW_BLOCKED: 'Приклад наявного товару ще не готовий до доставки',
  RECONCILIATION_REQUIRED: 'Раніше відправлену зміну ще не підтверджено. Повторна відправка заборонена.' };
function Problems({ items, compact }) {
  return items.length > 0 && <Notice tone="warning"><ul>{items.map((blocker, index) => <li key={index}>{blockers[blocker.code] || 'Потрібно перевірити відповідності.'}{!compact && blocker.routeKey ? ` · ${blocker.routeKey}` : ''}{blocker.productId ? ` · товар ${blocker.productId}` : ''}</li>)}</ul><Link className="underline" to="/sync-problems">Проблеми синхронізації</Link></Notice>;
}
function ReviewList({ items, label, render }) {
  const [page, setPage] = useState(0); const pages = Math.ceil(items.length / 50);
  const current = Math.min(page, Math.max(0, pages - 1));
  return <div className="space-y-2">{items.slice(current * 50, (current + 1) * 50).map(render)}
    {pages > 1 && <nav aria-label={label} className="flex items-center gap-2 text-sm">
      <button type="button" className="btn btn-outline btn-compact-md" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</button>
      <span aria-live="polite">{current + 1} / {pages} · усього {items.length}</span>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Далі</button>
    </nav>}
  </div>;
}
function PublicationWorkspace({ revision, currentPublishedId, representatives = empty, onPublished, compact = false, autoPreview = false, disabled = false }) {
  const auth = useAuth(); const { permissions } = auth; const administrator = isActualAdministrator(auth);
  const canPublish = ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => permissions.includes(permission));
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ack, setAck] = useState(false); const [reason, setReason] = useState('');
  const [status, setStatus] = useState([]); const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0); const inFlight = useRef(false);
  const automaticallyChecked = useRef(false);
  useEffect(() => { const requests = sequence; return () => { ++requests.current; }; }, []);
  useEffect(() => {
    if (revision.state !== 'published') return undefined;
    const controller = new AbortController(); let timer;
    const read = async () => {
      try {
        const { data } = await api.get(`${root}/bindings/${revision.id}/handoffs`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(data); setError('');
        if (data.some((item) => item.pending_handoff > 0 || item.waiting > 0)) timer = setTimeout(read, 5000);
      } catch (cause) { if (!controller.signal.aborted) setError(cause.response?.data?.error || 'Не вдалося прочитати стан передачі товарів.'); }
    };
    read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision.id, revision.state, refresh]);
  async function action(path, payload, complete) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError('');
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current) complete(data); }
    catch (cause) { if (current === sequence.current) { setReview(null); setAck(false); setReason(''); setError(cause.response?.data?.error || 'Дані змінилися або дія не завершилася. Повторіть перевірку.'); } }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  const request = { bindingRevisionId: revision.id, expectedRevision: revision.revision, expectedCurrentId: currentPublishedId,
    representatives: representatives.map((representative) => representative.input) };
  useEffect(() => {
    if (!autoPreview || disabled || !canPublish || automaticallyChecked.current || revision.state !== 'draft') return;
    automaticallyChecked.current = true;
    action('publication/preview', request, setReview);
    // The wrapper remounts for every exact revision/current-publication/product context.
    // Auto-check starts only after an explicit check requested in this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview, disabled, canPublish]);
  const loss = Boolean(review && (review.lostRoutes.length || review.lostProducts.length));
  const statusRow = (item) => <article className="space-y-1 border-t py-2 text-sm" key={item.id}><p>{item.kind === 'publication' ? 'Після публікації' : item.kind === 'name_rule' ? 'Застосування правила назв' : 'Контрольована повторна синхронізація'} · {new Date(item.created_at).toLocaleString('uk-UA')}</p>
    <p>Magento: {item.synced} / {item.total} синхронізовано · {item.waiting} очікують · {item.pending_handoff} ще не передано · {item.needs_attention} потребують уваги</p>
    {item.protected > 0 && <p>Не передано через непідтверджену попередню роботу: {item.protected}. <Link className="underline" to="/sync-problems">Перевірити проблеми</Link></p>}
    {item.retired > 0 && <p>Товари більше не актуальні: {item.retired}</p>}
  </article>;
  const currentStatuses = status.filter((item, index) => index === 0 || item.pending_handoff > 0 || item.waiting > 0 || item.needs_attention > 0 || item.protected > 0);
  const history = status.filter((item) => !currentStatuses.includes(item));
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">{compact ? 'Застосування змін' : 'Публікація та передача товарів'}</h2>
    {error && <Notice tone="error">{error}</Notice>}
    {revision.state === 'draft' ? <>
      {!compact && <><p className="text-sm">Публікація змінить правила доставки. Чинні назви товарів зберігаються; застосування нового правила назв — окрема контрольована дія.</p><p className="text-sm">Перевірених прикладів CREATE: {representatives.length}. Нові маршрути потребують готового прикладу у розділі «Перевірка товару».</p></>}
      {canPublish && (!autoPreview || error || review?.blockers.length > 0) && <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || disabled} onClick={() => { setReview(null); setAck(false); setReason(''); action('publication/preview', request, setReview); }}>{compact ? 'Перевірити вплив на товари' : 'Перевірити вплив публікації'}</button>}
      {review && <div className="space-y-3"><p>Перевірено поточних товарів: {review.totalProducts}. До синхронізації буде передано: {review.affected.length}. Назв збережено: {review.preservedNames.length}.</p>
        <Problems items={review.blockers} compact={compact} />
        {review.affected.length > 0 && <MagentoDetails summary="Точний перелік товарів для доставки">{() => <ReviewList key={review.previewToken} items={review.affected} label="Товари для доставки" render={(product) => <p className="break-words" key={product.productId}>{product.article} · {product.reason === 'unblocked' ? 'Готовність відновлено' : 'Змінилась доставка'}</p>} />}</MagentoDetails>}
        {review.preservedNames.length > 0 && <MagentoDetails summary="Вплив нового правила назв">{() => <ReviewList key={review.previewToken} items={review.preservedNames} label="Вплив на назви" render={(product) => <p className="text-sm break-words" key={product.productId}>{product.article}: {product.before.all} → {product.generated.all}; {product.before.en} → {product.generated.en}. Чинні назви залишаться без змін.</p>} />}</MagentoDetails>}
        {loss && <Notice tone="warning"><p>Покриття буде скорочено. Потрібне підтвердження Адміністратора.</p><p>Маршрути: {review.lostRoutes.join(', ') || 'без втрат'}</p>
          <ReviewList key={review.previewToken} items={review.lostProducts} label="Втрата покриття" render={(product) => <p className="break-words" key={product.productId}>{product.article} · {product.routeKey}</p>} />
          {administrator && <><label className="block text-sm"><input type="checkbox" checked={ack} disabled={busy} onChange={(event) => setAck(event.target.checked)} /> Підтверджую точну втрату покриття</label>
            <label className="block text-sm">Пояснення скорочення<input className="input" maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label></>}
        </Notice>}
        {canPublish && (!loss || administrator) && <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || disabled || review.blockers.length > 0 || (loss && (!ack || reason.trim().length < 3))}
          onClick={() => action('publication/apply', { ...request, previewToken: review.previewToken, ...(loss ? { ackCoverageLoss: ack, coverageReason: reason } : {}) }, (data) => onPublished(data.revision))}>{compact ? 'Застосувати зміни' : 'Опублікувати відповідності'}</button>}
      </div>}
    </> : <>
      <p className="text-sm">Опублікована версія незмінна. Передача товарів зберігається в Amber: можна залишити сторінку й повернутися пізніше.</p>
      {currentStatuses.map(statusRow)}
      {history.length > 0 && <MagentoDetails summary={`Попередні передачі (${history.length})`}>{() => history.map(statusRow)}</MagentoDetails>}
      <button type="button" className="btn btn-outline btn-compact-md" onClick={() => setRefresh((value) => value + 1)}>Оновити стан передачі</button>
    </>}
    {busy && <LoadingState label="Перевіряємо вплив та актуальність даних…" />}
  </section>;
}

export default function MagentoPublicationActions(props) {
  if (!props.revision) return null;
  const context = `${props.revision.id}:${props.revision.revision}:${props.currentPublishedId}:${JSON.stringify(props.representatives || empty)}`;
  return <PublicationWorkspace key={context} {...props} />;
}
