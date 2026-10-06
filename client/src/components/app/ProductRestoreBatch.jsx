import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../auth/auth-context';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';
import RestoreReviewHandoff from './RestoreReviewHandoff.jsx';

const reasonText = {
  PRODUCT_RESTORE_NOT_FOUND: 'Товар не знайдено', PRODUCT_ALREADY_ACTIVE: 'Товар уже активний',
  PRODUCT_RESTORE_AMBIGUOUS: 'Артикул має кілька різних власників', PRODUCT_RESTORE_DUPLICATE_TARGET: 'Повтор того самого товару',
  PRODUCT_RETIRED_ANCESTOR: 'Є наступник або виправлена версія', PRODUCT_ARCHIVE_PROOF_MISSING: 'Немає збереженої перевірки попереднього архівування',
  PRODUCT_ARCHIVE_PROOF_INVALID: 'Попереднє архівування потребує перевірки', PRODUCT_OLD_EXCLUSION_RETAINED: 'Попереднє виключення з експорту збережено',
  PRODUCT_OLD_LIFECYCLE_REVIEW_REQUIRED: 'Попередній стан експорту потребує перевірки', PRODUCT_ARCHIVE_CHANGED: 'Товар змінився після архівування',
  PRODUCT_SYNC_RECONCILIATION_REQUIRED: 'Спочатку перевірте незавершену доставку', PRODUCT_VISIBILITY_RECONCILIATION_REQUIRED: 'Результат зміни видимості ще не підтверджено',
  PRODUCT_MEDIA_RECONCILIATION_REQUIRED: 'Спочатку завершіть або перевірте передавання фото.',
  PRODUCT_VISIBILITY_UNCERTAIN: 'Результат зміни видимості ще не підтверджено', PRODUCT_VISIBILITY_PHOTOS_REQUIRED: 'Для показу потрібна підтверджена перевірка фотографій',
  PHOTO_ACTIVATION_PROOF_REQUIRED: 'Для показу потрібні підтверджені фотографії', PRODUCT_TEST_DELETION_FROZEN: 'Товар бере участь у видаленні тестового запису',
  PRODUCT_DELIVERY_HISTORY_UNKNOWN: 'Історія доставки не підтверджена', PRODUCT_REMOTE_IDENTITY_CHANGED: 'Magento ID змінився — потрібна перевірка',
  PRODUCT_AUTOMATIC_DELIVERY_REQUIRED: 'Автоматична доставка ще не готова', PRODUCT_RESTORE_BUSY: 'Товар обробляється — повторіть перевірку пізніше',
  PRODUCT_RESTORE_GENERATION_CHANGED: 'Після відновлення товар змінився — перевірте його поточну доставку',
};
const pending = (receipt) => Boolean(receipt && (receipt.pending?.length || receipt.items?.some((item) => ['restored', 'queued'].includes(item.state))));
const explain = (code) => reasonText[code] || (code ? 'Потрібна окрема перевірка товару' : '');
const time = (value) => value ? new Date(value).toLocaleString('uk-UA') : null;

export function ProductRestoreBatch({ onClose, onRestored, onDirtyChange, onBusyChange, apiClient = api }) {
  const auth = useAuth();
  const allowed = auth.permissions?.includes('products.view') && auth.permissions?.includes('products.archive');
  const [text, setText] = useState('');
  const [review, setReview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef(null), inputRef = useRef(null), mounted = useRef(true), requestSequence = useRef(0), busyRef = useRef(false);
  const lifetime = auth.principalLifetime;
  const currentLifetime = useRef(lifetime), refreshInFlight = useRef(false);
  useLayoutEffect(() => { currentLifetime.current = lifetime; }, [lifetime]);
  const current = useCallback(() => mounted.current && currentLifetime.current === lifetime && (!lifetime || lifetime.valid), [lifetime]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = uncertain || pending(receipt) || (!receipt && Boolean(text.trim()));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy || uncertain); }, [busy, uncertain, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  useDialogAccessibility({ containerRef, initialFocusRef: inputRef, isOpen: true, closeDisabled: busy || uncertain, onClose });
  const acceptReceipt = useCallback((next) => {
    setReceipt(next); setUncertain(false);
    if (next.items?.some((item) => item.restoredAt)) onRestored?.(next);
  }, [onRestored]);
  const batchId = receipt?.batchId, waiting = pending(receipt);
  const refresh = useCallback(async (signal) => {
    if (!batchId || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const result = await apiClient.get(`/products/restore/batches/${batchId}`, { signal });
      if (current() && !signal?.aborted) { acceptReceipt(result.data); setError(''); }
    } catch (cause) {
      if (current() && !signal?.aborted) setError(cause.response?.data?.error || 'Не вдалося оновити стан. Перевірте результат ще раз.');
    } finally { refreshInFlight.current = false; }
  }, [batchId, apiClient, current, acceptReceipt]);
  useEffect(() => {
    if (!allowed || !waiting) return undefined;
    const controller = new AbortController();
    let stopped = false, timer;
    const loop = async () => {
      try { await refresh(controller.signal); }
      finally { if (!stopped && current()) timer = setTimeout(loop, 5000); }
    };
    timer = setTimeout(loop, 5000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [allowed, waiting, current, refresh]);
  async function check() {
    if (!allowed || busyRef.current || uncertain) return;
    const skus = text.split(/[\r\n]+/).map((sku) => sku.trim()).filter(Boolean);
    if (!skus.length || skus.length > 100) { setError('Вкажіть від 1 до 100 артикулів, по одному в рядку.'); return; }
    busyRef.current = true; setBusy(true); setError('');
    const sequence = ++requestSequence.current;
    try {
      const result = await apiClient.post('/products/restore/preview', { skus });
      if (current() && sequence === requestSequence.current) { setReview(result.data); setReceipt(null); }
    } catch (cause) {
      if (current() && sequence === requestSequence.current) setError(cause.response?.data?.error || 'Не вдалося перевірити список.');
    } finally { busyRef.current = false; if (current()) setBusy(false); }
  }
  async function apply() {
    if (!allowed || busyRef.current || !review?.counts.found || receipt) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await apiClient.post('/products/restore/apply', { skus: review.skus, reviewNonce: review.reviewNonce,
        reviewHash: review.reviewHash, confirmRestoreAndSync: true });
      if (current()) acceptReceipt(result.data);
    } catch (cause) {
      if (current()) {
        const definitive = ['PRODUCT_RESTORE_REVIEW_STALE', 'PRODUCT_RESTORE_CONFIRMATION_REQUIRED',
          'PRODUCT_RESTORE_SELECTION_INVALID', 'PRODUCT_RESTORE_NO_ELIGIBLE_ITEMS'].includes(cause.response?.data?.code);
        setUncertain(!definitive);
        setError(definitive ? (cause.response?.data?.error || 'Список змінився. Повторіть перевірку.')
          : cause.response?.data?.code === 'ADMIN_PERMISSION_REVOKED'
            ? 'Права доступу змінилися. Частина товарів могла бути відновлена. Поверніть доступ і перевірте результат цього самого списку.'
            : 'Відповідь не отримано. Частина товарів могла бути відновлена. Перевірте результат цього самого списку.');
        if (definitive) setReview(null);
      }
    } finally { busyRef.current = false; if (current()) setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <section ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="product-restore-title" tabIndex={-1}
      className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-6 shadow-xl">
      <div className="flex items-center justify-between gap-4"><h2 id="product-restore-title" className="text-xl font-semibold">Відновити товари за артикулами</h2>
        <button type="button" disabled={busy || uncertain} onClick={onClose} aria-label="Закрити відновлення" className="rounded border px-3 py-2">Закрити</button></div>
      <p className="mt-3 text-sm text-gray-600">Вкажіть до 100 точних артикулів. Перевірка покаже, які архівовані товари можна відновити та доставити до Magento.</p>
      {!allowed ? <p role="alert" className="mt-4 text-red-700">Для відновлення потрібен доступ до перегляду та архівування товарів.</p> : <>
        <label className="mt-4 block font-medium" htmlFor="product-restore-skus">Артикули, по одному в рядку</label>
        <textarea ref={inputRef} id="product-restore-skus" rows={5} value={text} disabled={busy || uncertain || Boolean(receipt)}
          className="mt-2 w-full rounded border p-3 font-mono text-sm" onChange={(event) => {
            requestSequence.current++; setText(event.target.value); setReview(null); setReceipt(null); setError('');
          }} />
        {!receipt && !uncertain && <button type="button" disabled={busy || !text.trim()} onClick={check} className="mt-3 rounded border px-4 py-2">{busy ? 'Обробка…' : 'Перевірити список'}</button>}
        {review && !receipt && <><section className="restore-review-summary" aria-label="Підсумок відновлення">
          <p className="font-medium">Можна відновити: {review.counts.found}. Пропущено: {review.counts.skipped}. Потребують перевірки: {review.counts.conflicts}.</p>
          {review.counts.found > 0 && <><p className="mt-2 text-sm">Буде відновлено лише {review.counts.found} дозволених товарів. Решта залишиться без змін.</p>
            <button type="button" disabled={busy} onClick={apply} className="btn btn-primary mt-3">{uncertain ? 'Перевірити результат відновлення' : 'Підтвердити відновлення та синхронізацію'}</button></>}
          </section>
          <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Артикул</th><th className="p-2">Результат перевірки</th><th className="p-2">Magento ID</th></tr></thead><tbody>
            {review.items.map((item, index) => <tr key={index} className="border-t"><td className="p-2 font-mono">{item.article || item.inputSku}</td>
              <td className="p-2">{item.disposition === 'found' ? 'Архівований товар — можна відновити' : explain(item.reasonCode)}</td><td className="p-2">{item.confirmedMagentoId || 'Не підтверджено'}</td></tr>)}
          </tbody></table></div>
          <RestoreReviewHandoff items={review.items} />
          {review.counts.found > 0 && <p className="mt-3 text-sm text-gray-600">Видимість зміниться після перевіреної доставки та перевірки фотографій, якщо це підтверджено попереднім архівуванням.</p>}
        </>}
        {receipt && <div className="mt-4" role="status"><p className="font-medium">Результат відновлення</p><ul className="mt-2 space-y-3">
          {receipt.items.map((item) => <li key={item.productId} className="rounded border p-3"><span className="font-mono">{item.article}</span>: {item.state === 'synced' ? 'Доставку підтверджено' : item.state === 'queued' ? 'Відновлено в Amber, очікує підтвердження доставки' : item.state === 'restored' ? 'Відновлено в Amber' : 'Потребує перевірки'}
            {item.reasonCode && <p className="text-sm text-amber-800">{explain(item.reasonCode)}</p>}
            {item.restoredAt && <p className="text-sm text-gray-600">Відновлено: {time(item.restoredAt)}</p>}
            {item.confirmedAt && <p className="text-sm text-gray-600">Доставку підтверджено: {time(item.confirmedAt)}</p>}
            {item.visibilityRestoredAt && <p className="text-sm text-gray-600">Попередню видимість перевірено: {time(item.visibilityRestoredAt)}</p>}
          </li>)}
        </ul>{receipt.pending?.length > 0 && <p className="mt-3 text-sm">Для {receipt.pending.length} товарів підтвердження локального відновлення ще не отримано.</p>}
          <button type="button" onClick={() => void refresh()} className="mt-3 rounded border px-4 py-2">Оновити стан</button>
        </div>}
      </>}
      {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
    </section>
  </div>;
}
