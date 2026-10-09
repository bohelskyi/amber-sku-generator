import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import RetiredCatalogNotice from './RetiredCatalogNotice.jsx';
import MagentoPublicationProblems from './MagentoPublicationProblems.jsx';
import MagentoProductChecks from './MagentoProductChecks.jsx';

const root = '/admin/magento-integration';
const empty = [];
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
function PublicationWorkspace({ revision, currentPublishedId, representatives = empty, onPublished, onRepresentative, definition, registry, categories, repairContext, compact = false, autoPreview = false, disabled: suppliedDisabled = false, editScope }) {
  const auth = useAuth(); const { permissions } = auth; const administrator = isActualAdministrator(auth);
  const retired = Boolean(revision.catalogAvailability?.publicationBlocked);
  const disabled = suppliedDisabled || retired;
  const canPublish = ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => permissions.includes(permission));
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false); const [busyStage, setBusyStage] = useState(''); const [error, setError] = useState('');
  const [rejectedReview, setRejectedReview] = useState(null);
  const [ack, setAck] = useState(false); const [reason, setReason] = useState('');
  const [status, setStatus] = useState([]); const [refresh, setRefresh] = useState(0);
  const [statusLoaded, setStatusLoaded] = useState(false); const [statusReadAt, setStatusReadAt] = useState(null); const [statusStale, setStatusStale] = useState(false);
  const [exampleCategory, setExampleCategory] = useState(null);
  const sequence = useRef(0); const inFlight = useRef(false);
  const automaticallyChecked = useRef(false);
  useEffect(() => { const requests = sequence; return () => { ++requests.current; }; }, []);
  useEffect(() => {
    if (revision.state !== 'published' || auth.principalLifetime?.valid === false) return undefined;
    const controller = new AbortController(); let timer; let reading = false;
    const read = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted || reading) return;
      reading = true;
      try {
        const { data } = await api.get(root + '/bindings/' + revision.id + '/handoffs', { signal: controller.signal });
        if (controller.signal.aborted || auth.principalLifetime?.valid === false) return;
        if (!Array.isArray(data)) throw new Error('Incomplete handoff evidence');
        setStatus(data); setStatusLoaded(true); setStatusReadAt(new Date().toISOString()); setStatusStale(false); setError('');
        if (data.some((item) => item.pending_handoff > 0 || item.waiting > 0)) timer = setTimeout(read, 5000);
      } catch (cause) { if (!controller.signal.aborted) { setStatusStale(true); setError(cause.response?.data?.error || 'Не вдалося прочитати стан передачі товарів. Показано останні отримані дані.'); } }
      finally { reading = false; }
    };
    read(); window.addEventListener('focus', read);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', read); };
  }, [revision.id, revision.state, refresh, auth.principalLifetime]);
  async function action(path, payload, complete) {
    if (inFlight.current || disabled || !canPublish || auth.principalLifetime?.valid === false) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setBusyStage(path.endsWith('/apply') ? 'apply' : 'preview'); setError(''); setRejectedReview(null);
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current && auth.principalLifetime?.valid !== false) complete(data); }
    catch (cause) { if (current === sequence.current) {
      setReview(null); setAck(false); setReason('');
      const blockers = cause.response?.data?.details?.blockers;
      if (Array.isArray(blockers) && blockers.length) setRejectedReview({ blockers, affected: [], checked: [] });
      setError(cause.response?.data?.code === 'MAGENTO_PUBLICATION_STALE' ? 'Перевірка застаріла. Зміни не застосовано. Перевірте причини нижче й повторіть перевірку впливу на товари.'
        : cause.response?.data?.error || 'Дані змінилися або дія не завершилася. Повторіть перевірку.');
    } }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); setBusyStage(''); } }
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
    <p>Magento: {item.synced} / {item.total} синхронізовано · {item.waiting} у черзі доставки · Ще не поставлено в чергу доставки: {item.pending_handoff} · {item.needs_attention} потребують уваги</p>
    <p>Підтвердження Magento: {item.lastConfirmedAt ? new Date(item.lastConfirmedAt).toLocaleString('uk-UA') : 'Час підтвердження недоступний у цьому огляді'}.</p>
    {item.protected > 0 && <p>Не передано через непідтверджену попередню роботу: {item.protected}. <Link className="underline" to="/sync-problems">Перевірити проблеми</Link></p>}
    {item.retired > 0 && <p>Товари більше не актуальні: {item.retired}</p>}
  </article>;
  const currentStatuses = status.filter((item, index) => index === 0 || item.pending_handoff > 0 || item.waiting > 0 || item.needs_attention > 0 || item.protected > 0);
  const history = status.filter((item) => !currentStatuses.includes(item));
  const applyDisabledReason = busy ? 'Перевірка або застосування виконується.' : disabled ? 'Завершіть локальні рішення або оновіть неактуальну перевірку.' : review?.blockers.length ? `Застосування заблоковано: ${review.blockers.length} перешкод у пакеті.` : loss && (!ack || reason.trim().length < 3) ? 'Підтвердьте точну втрату покриття й додайте пояснення.' : '';
  return <section className={`card space-y-3 p-5${compact ? ' mc-publication-actions' : ''}`}><h2 className="font-semibold">{compact ? 'Застосування змін' : 'Публікація та передача товарів'}</h2>
    <RetiredCatalogNotice availability={revision.catalogAvailability} />
    {error && <Notice tone="error">{error}</Notice>}
    {rejectedReview && <MagentoPublicationProblems review={rejectedReview} revision={revision} currentPublishedId={currentPublishedId} definition={definition} registry={registry} categories={categories} repairContext={repairContext} compact={compact} />}
    {revision.state === 'draft' ? <>
      {!compact && <><p className="text-sm">Публікація змінить правила доставки. Чинні назви товарів зберігаються; застосування нового правила назв — окрема контрольована дія.</p><p className="text-sm">Перевірених прикладів CREATE: {representatives.length}. Нові маршрути потребують готового прикладу у розділі «Перевірка товару».</p></>}
      {canPublish && (!autoPreview || error || review?.blockers.length > 0) && <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || disabled} onClick={() => { setReview(null); setAck(false); setReason(''); action('publication/preview', request, setReview); }}>{busyStage === 'preview' ? 'Перевіряємо вплив на товари…' : compact ? 'Перевірити вплив на товари' : 'Перевірити вплив публікації'}</button>}
      <p className="text-sm">Перевірка показує точний вплив усього пакета. Правила й передача товарів запускаються лише окремим підтвердженням нижче.</p>
      {review && <div className="space-y-3"><p>Перевірено поточних товарів: {review.totalProducts}. До синхронізації буде передано: {review.affected.length}. Назв збережено: {review.preservedNames.length}.</p>
        <MagentoPublicationProblems review={review} revision={revision} currentPublishedId={currentPublishedId} definition={definition} registry={registry} categories={categories} repairContext={repairContext} compact={compact} onExample={onRepresentative ? setExampleCategory : undefined} />
        {exampleCategory && onRepresentative && <section className="space-y-3" aria-label="Приклад для застосування змін"><h3 className="font-semibold">Приклад нового товару</h3><MagentoProductChecks revision={revision} categoryCode={exampleCategory} onRepresentative={onRepresentative} /></section>}
        {review.affected.length > 0 && <section aria-label="Точний перелік товарів для доставки"><h3 className="font-semibold">Точний перелік товарів для доставки</h3><ReviewList key={review.previewToken} items={review.affected} label="Товари для доставки" render={(product) => <p className="break-words" key={product.productId}>{product.article} · {product.reason === 'unblocked' ? 'Готовність відновлено' : 'Змінилась доставка'}</p>} /></section>}
        {review.preservedNames.length > 0 && <MagentoDetails summary="Вплив нового правила назв">{() => <ReviewList key={review.previewToken} items={review.preservedNames} label="Вплив на назви" render={(product) => <p className="text-sm break-words" key={product.productId}>{product.article}: {product.before.all} → {product.generated.all}; {product.before.en} → {product.generated.en}. Чинні назви залишаться без змін.</p>} />}</MagentoDetails>}
        {loss && <Notice tone="warning"><p>Покриття буде скорочено. Потрібне підтвердження Адміністратора.</p><p>Маршрути: {review.lostRoutes.join(', ') || 'без втрат'}</p>
          <ReviewList key={review.previewToken} items={review.lostProducts} label="Втрата покриття" render={(product) => <p className="break-words" key={product.productId}>{product.article} · {product.routeKey}</p>} />
          {administrator && <><label className="block text-sm"><input type="checkbox" checked={ack} disabled={busy} onChange={(event) => setAck(event.target.checked)} /> Підтверджую точну втрату покриття</label>
            <label className="block text-sm">Пояснення скорочення<input className="input" maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label></>}
        </Notice>}
        <div className="mc-publication-command">{editScope && <p>Редагували: {editScope.categoryName} · {editScope.language}. Змінених полів: {editScope.changedCount}. Застосування перевіряє весь пакет.</p>}<p>{review.blockers.length ? `Залишилося перешкод пакета: ${review.blockers.length}.` : 'Перевірку всього пакета завершено.'} До доставки: {review.affected.length} товарів. Назви чинних товарів залишаються збереженими.</p>{applyDisabledReason && <p role="status">{applyDisabledReason}</p>}{canPublish && (!loss || administrator) && <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || disabled || review.blockers.length > 0 || (loss && (!ack || reason.trim().length < 3))}
          onClick={() => action('publication/apply', { ...request, previewToken: review.previewToken, ...(loss ? { ackCoverageLoss: ack, coverageReason: reason } : {}) }, (data) => onPublished(data.revision))}>{busyStage === 'apply' ? 'Застосовуємо правила й передачу…' : 'Застосувати правила й передати ' + review.affected.length + ' товарів'}</button>}</div>
      </div>}
    </> : <>
      <p className="text-sm">Опублікована версія незмінна. Передача товарів зберігається в Amber: можна залишити сторінку й повернутися пізніше.</p>
      <p className="text-sm">Застосовано в Amber: {revision.publishedAt ? new Date(revision.publishedAt).toLocaleString('uk-UA') : 'Час застосування недоступний у цьому огляді'}.</p>
      {!statusLoaded && !error && <LoadingState compact label="Читаємо збережений результат передачі…" />}
      {statusLoaded && !status.length && <p>Для цієї публікації немає доступного запису передачі товарів. Підтвердження Magento не встановлено.</p>}
      {statusLoaded && statusReadAt && <p className="text-sm" role="status">Стан прочитано з Amber: {new Date(statusReadAt).toLocaleString('uk-UA')}.{statusStale && ' Дані не оновлено; поточний результат невідомий.'} Час підтвердження Magento показано окремо.</p>}
      {currentStatuses.length > 0 && <section aria-label="Поточна й незавершена доставка"><h3 className="font-semibold">Поточна й незавершена доставка</h3>{currentStatuses.map(statusRow)}</section>}
      {history.length > 0 && <MagentoDetails summary={`Попередні передачі (${history.length})`}>{() => history.map(statusRow)}</MagentoDetails>}
      <button type="button" className="btn btn-outline btn-compact-md" onClick={() => setRefresh((value) => value + 1)}>Оновити стан передачі</button>
    </>}
    {busy && <LoadingState label={busyStage === 'apply' ? 'Застосовуємо перевірений пакет в Amber…' : 'Перевіряємо вплив усього пакета на товари…'} />}
  </section>;
}

export default function MagentoPublicationActions(props) {
  const { principalLifetime } = useAuth();
  if (!props.revision) return null;
  const context = `${principalLifetime?.id || 'session'}:${props.revision.id}:${props.revision.revision}:${props.currentPublishedId}:${JSON.stringify(props.representatives || empty)}`;
  return <PublicationWorkspace key={context} {...props} />;
}
