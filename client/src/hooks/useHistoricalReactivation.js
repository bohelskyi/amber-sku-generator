import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { notifyExportReviewChanged } from '../lib/export-review-events.js';
import { historicalReactivationApi } from '../api/historical-reactivation-api.js';
import {
  canUseHistoricalReactivation, historicalConfirmation, historicalInput, historicalPending,
  isStandardHistorical, UUID_PATTERN, validateHistoricalInspection, validateHistoricalPreview, validateHistoricalReceipt,
} from '../lib/historical-reactivation.js';

const noAcceptanceCodes = new Set([
  'HISTORICAL_REVIEW_STALE', 'HISTORICAL_SELECTION_INVALID', 'HISTORICAL_CONFIRMATION_REQUIRED',
]);
const createUuid = () => crypto.randomUUID();
const errorMessage = (error, fallback) => {
  const serverMessage = error?.response?.data?.error;
  return typeof serverMessage === 'string' && serverMessage.trim() ? serverMessage
    : typeof error?.message === 'string' && error.message.trim() ? error.message : fallback;
};
const uncertainMessage = 'Результат нового рішення ще не підтверджено. Не надсилайте підтвердження повторно. Перевірте стан цієї самої операції за її номером.';

export function useHistoricalReactivation({
  auth, config, open, apiClient = historicalReactivationApi, createRequestId = createUuid, onReceipt,
}) {
  const allowed = canUseHistoricalReactivation(auth, config);
  const [text, setText] = useState('');
  const [review, setReview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [selectedCreate, setSelectedCreate] = useState([]);
  const [cancelAcknowledged, setCancelAcknowledged] = useState({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [batchId, setBatchId] = useState(null);
  const [lookupId, setLookupId] = useState('');
  const [inspections, setInspections] = useState({});
  const [reconcileAcknowledged, setReconcileAcknowledged] = useState({});
  const [busyKind, setBusyKind] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now);
  const mounted = useRef(true), flight = useRef(false), attempt = useRef(null), notified = useRef(new Set()), generation = useRef(0);
  const lifetime = auth.principalLifetime;
  const currentLifetime = useRef(lifetime), currentAllowed = useRef(allowed), currentOpen = useRef(open);
  useLayoutEffect(() => {
    currentLifetime.current = lifetime; currentAllowed.current = allowed; currentOpen.current = open;
  }, [lifetime, allowed, open]);
  const ownerCurrent = useCallback(() => mounted.current && currentLifetime.current === lifetime
    && (!lifetime || lifetime.valid !== false), [lifetime]);
  const mayRead = useCallback(() => ownerCurrent() && currentAllowed.current, [ownerCurrent]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !review) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, review]);
  const acceptReceipt = useCallback((value, expectedId, expectedSelection) => {
    const next = validateHistoricalReceipt(value, expectedId);
    if (isStandardHistorical(next)) {
      for (const item of next.items) {
        const original = receipt?.batchId === next.batchId ? receipt.items.find((previous) => previous.intentId === item.intentId)
          : attempt.current?.idempotencyKey === next.batchId ? review?.items.find((previous) => previous.article === item.article) : null;
        if (original && (item.deliveryMode !== original.deliveryMode || item.targetStatus !== original.targetStatus
          || item.targetVisibility !== original.targetVisibility || Number(item.remoteProductId) !== Number(original.remoteProductId)
          || original.nativeJobId && item.nativeJobId !== original.nativeJobId)) throw new Error('Первісний план або номер задачі доставки не збігається. Прочитайте квитанцію тієї самої операції.');
      }
    }
    if (expectedSelection) {
      const actual = next.items.map((item) => item.article);
      if (actual.length !== expectedSelection.length || actual.some((sku) => !expectedSelection.includes(sku))) {
        throw new Error('Сервер не підтвердив точний обраний склад операції. Перевірте її стан за незмінним номером.');
      }
    }
    setInspections({}); setReconcileAcknowledged({}); setCancelAcknowledged({});
    setReceipt(next); setBatchId(next.batchId); setUncertain(false); setError('');
    const activated = next.items.filter((item) => item.localActivatedAt && !notified.current.has(item.intentId));
    if (activated.length) {
      activated.forEach((item) => notified.current.add(item.intentId));
      notifyExportReviewChanged({ kind: 'product' });
      onReceipt?.(next);
    }
    return next;
  }, [onReceipt, receipt, review]);
  function start(kind) {
    if (!mayRead() || flight.current) return false;
    flight.current = true; setBusyKind(kind); setError(''); return true;
  }
  function finish() {
    flight.current = false;
    if (ownerCurrent()) setBusyKind('');
  }
  function editText(next) {
    if (!allowed || busyKind || uncertain || batchId) return;
    generation.current++;
    setText(next); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false); setError('');
  }
  function select(article, checked) {
    if (!allowed || busyKind || uncertain || batchId
      || !review?.items.some((item) => item.article === article && item.disposition === 'eligible')) return;
    setSelected((previous) => checked ? [...new Set([...previous, article])] : previous.filter((sku) => sku !== article));
    setSelectedCreate((previous) => previous.filter((sku) => sku !== article));
    setAcknowledged(false);
  }
  function selectCreate(article, checked) {
    if (!allowed || busyKind || uncertain || batchId || !selected.includes(article)
      || !review?.items.some((item) => item.article === article && item.deliveryMode === 'create' && item.disposition === 'eligible')) return;
    setSelectedCreate((previous) => checked ? [...new Set([...previous, article])] : previous.filter((sku) => sku !== article));
    setAcknowledged(false);
  }
  function selectEligible() {
    if (!allowed || busyKind || uncertain || batchId || !review) return;
    setSelectedCreate([]);
    setSelected(review.items.filter((item) => item.disposition === 'eligible').map((item) => item.article));
    setAcknowledged(false);
  }
  async function preview() {
    if (uncertain || batchId || !start('preview')) return;
    const ticket = ++generation.current;
    setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    try {
      const skus = historicalInput(text, config.historicalReactivation.maxItems);
      const result = await apiClient.preview(skus);
      if (mayRead() && ticket === generation.current) {
        setReview(validateHistoricalPreview(result.data)); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
        setClock(Date.now());
      }
    } catch (cause) { if (mayRead()) setError(errorMessage(cause, 'Не вдалося перевірити перелік.')); }
    finally { finish(); }
  }
  async function confirm() {
    if (!review || !acknowledged || uncertain || attempt.current || !start('confirm')) return;
    let submitted;
    try {
      submitted = historicalConfirmation(review, selected, createRequestId(), Date.now(), selectedCreate);
      attempt.current = submitted; setBatchId(submitted.idempotencyKey);
      const result = await apiClient.confirm(submitted);
      if (!ownerCurrent()) return;
      if (!currentAllowed.current) { setUncertain(true); setError(uncertainMessage); return; }
      acceptReceipt(result.data, submitted.idempotencyKey, submitted.selectedSkus);
    } catch (cause) {
      if (!ownerCurrent()) return;
      if (!submitted || noAcceptanceCodes.has(cause.response?.data?.code)) {
        attempt.current = null; setBatchId(null); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
        setError(errorMessage(cause, 'Оновіть перевірку перед новим підтвердженням.'));
      } else { setUncertain(true); setError(uncertainMessage); }
    } finally { finish(); }
  }
  const readStatus = useCallback(async (id, signal) => {
    const ticket = generation.current;
    setInspections({}); setReconcileAcknowledged({}); setCancelAcknowledged({});
    const result = await apiClient.status(id, signal ? { signal } : {});
    if (mayRead() && !signal?.aborted && ticket === generation.current) {
      try { return acceptReceipt(result.data, id, attempt.current?.idempotencyKey === id ? attempt.current.selectedSkus : null); }
      catch (cause) { setUncertain(true); throw cause; }
    }
    return null;
  }, [apiClient, mayRead, acceptReceipt]);
  async function refresh() {
    const id = batchId || lookupId.trim();
    if (!UUID_PATTERN.test(id)) { setError('Введіть точний номер операції UUID.'); return; }
    if (!start('status')) return;
    try { await readStatus(id); }
    catch (cause) {
      if (mayRead()) setError(cause.response?.status === 404
        ? 'Операцію за цим номером ще не знайдено. Це не підтверджує відсутність змін. Підтвердження не буде надіслано повторно.'
        : errorMessage(cause, 'Не вдалося прочитати стан. Збережіть номер та повторіть лише перевірку стану.'));
    } finally { finish(); }
  }
  const waiting = historicalPending(receipt);
  useEffect(() => {
    if (!open || !allowed || !batchId || !waiting || uncertain) return undefined;
    const controller = new AbortController();
    let stopped = false, timer;
    async function poll() {
      if (flight.current || !currentOpen.current || !mayRead()) {
        if (!stopped) timer = setTimeout(poll, 5000);
        return;
      }
      flight.current = true;
      try { await readStatus(batchId, controller.signal); }
      catch (cause) { if (!stopped && mayRead()) setError(errorMessage(cause, 'Не вдалося оновити стан.')); }
      finally { flight.current = false; if (!stopped && mayRead()) timer = setTimeout(poll, 5000); }
    }
    timer = setTimeout(poll, 5000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [open, allowed, batchId, waiting, uncertain, mayRead, readStatus]);
  async function inspect(item) {
    if (uncertain || !start('inspect')) return;
    setInspections((previous) => { const next = { ...previous }; delete next[item.intentId]; return next; });
    setReconcileAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    setCancelAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    try {
      const result = await apiClient.inspect(item.intentId);
      if (mayRead()) {
        const value = validateHistoricalInspection(result.data, item);
        setInspections((previous) => ({ ...previous, [item.intentId]: value }));
        setReconcileAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    setCancelAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
      }
    } catch (cause) { if (mayRead()) setError(errorMessage(cause, 'Не вдалося перевірити прихований результат.')); }
    finally { finish(); }
  }
  async function reconcile(item) {
    const inspected = inspections[item.intentId];
    if (uncertain || !(isStandardHistorical(item) ? inspected?.canReconcile : inspected?.canConfirm) || !reconcileAcknowledged[item.intentId] || !start('reconcile')) return;
    setInspections((previous) => { const next = { ...previous }; delete next[item.intentId]; return next; });
    setReconcileAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    setCancelAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    try {
      const result = await apiClient.reconcile(item.intentId, isStandardHistorical(item)
        ? { review: inspected.recoveryReview, reviewHash: inspected.recoveryReviewHash, reason: 'Historical decision: explicitly record the verified original delivery result' }
        : inspected.reviewHash);
      if (!ownerCurrent()) return;
      if (!currentAllowed.current) { setUncertain(true); setError(uncertainMessage); return; }
      const returned = result.data;
      if (returned?.intentId !== item.intentId || returned.article !== item.article
        || Number(returned.productId) !== Number(item.productId)) throw new Error('Невідповідне підтвердження локального рішення.');
      const merged = { ...receipt, items: receipt.items.map((previous) => previous.intentId === item.intentId ? returned : previous) };
      acceptReceipt(merged, batchId, attempt.current?.selectedSkus);
    } catch {
      if (ownerCurrent()) { setUncertain(true); setError(uncertainMessage); }
    } finally { finish(); }
  }
  const canReset = !waiting && !uncertain && (!isStandardHistorical(receipt)
    || receipt.items.every((item) => ['completed', 'cancelled'].includes(item.state)));
  async function cancel(item) {
    const inspected = inspections[item.intentId];
    if (!isStandardHistorical(item) || uncertain || !inspected?.canCancel || !cancelAcknowledged[item.intentId] || !start('cancel')) return;
    setInspections((previous) => { const next = { ...previous }; delete next[item.intentId]; return next; });
    setCancelAcknowledged((previous) => ({ ...previous, [item.intentId]: false }));
    try {
      const result = await apiClient.cancel(item.intentId);
      if (!ownerCurrent()) return;
      if (!currentAllowed.current) { setUncertain(true); setError(uncertainMessage); return; }
      const returned = result.data;
      if (returned?.intentId !== item.intentId || returned.article !== item.article || Number(returned.productId) !== Number(item.productId)
        || returned.state !== 'cancelled') throw new Error('Скасування первісного рішення ще не підтверджено.');
      acceptReceipt({ ...receipt, items: receipt.items.map((previous) => previous.intentId === item.intentId ? returned : previous) }, batchId, attempt.current?.selectedSkus);
    } catch { if (ownerCurrent()) { setUncertain(true); setError(uncertainMessage); } }
    finally { finish(); }
  }
  function reset() {
    if (!allowed || busyKind || !canReset) return;
    generation.current++;
    attempt.current = null; setText(''); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    setReceipt(null); setBatchId(null); setInspections({}); setReconcileAcknowledged({}); setError('');
  }
  const expired = Boolean(review && Date.parse(review.reviewExpiresAt) <= clock);
  return {
    allowed, text, review, selected, selectedCreate, cancelAcknowledged, canReset, acknowledged, receipt, batchId, lookupId, inspections,
    reconcileAcknowledged, busyKind, uncertain, error, expired, waiting,
    dirty: Boolean(open && (uncertain || !receipt && text.trim())),
    locked: Boolean(busyKind || uncertain), editText, select, selectCreate, selectEligible, preview, confirm, refresh, inspect, reconcile, cancel, reset,
    setLookupId: (value) => { if (!busyKind && !batchId) setLookupId(value); },
    setAcknowledged: (value) => { if (allowed && !busyKind && !uncertain && !batchId) setAcknowledged(value); },
    setCancelAcknowledged: (id, value) => { if (allowed && !busyKind && !uncertain) setCancelAcknowledged((previous) => ({ ...previous, [id]: value })); },
    setReconcileAcknowledged: (id, value) => { if (allowed && !busyKind && !uncertain) setReconcileAcknowledged((previous) => ({ ...previous, [id]: value })); },
  };
}
