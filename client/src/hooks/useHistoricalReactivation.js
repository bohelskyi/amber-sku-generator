import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { notifyExportReviewChanged } from '../lib/export-review-events.js';
import { historicalReactivationApi } from '../api/historical-reactivation-api.js';
import { OPERATION_FORMAT, operationPending, operationStorageKey, readStoredOperation, storeOperation, validateReviewOperation } from '../lib/historical-review-operation.js';
import {
  canUseHistoricalReactivation, historicalConfirmation, historicalInput, historicalPending,
  isStandardHistorical, UUID_PATTERN, validateHistoricalInspection, validateHistoricalPreview, validateHistoricalReceipt,
} from '../lib/historical-reactivation.js';

import { historicalNameRepairRequest, validateHistoricalNames, validateHistoricalNameReceipt } from '../lib/historical-name-review.js';
import { historicalManualNameRequest, validateHistoricalManualNames, validateHistoricalManualNameReceipt } from '../lib/historical-manual-name-review.js';

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
const operationNotFoundMessage = 'Операцію за цим номером ще не знайдено. Повторне підтвердження не надсилатиметься.';

export function useHistoricalReactivation({
  auth, config, open, apiClient = historicalReactivationApi, createRequestId = createUuid, onReceipt,
}) {
  const allowed = canUseHistoricalReactivation(auth, config);
  const canReviewNames = Boolean(allowed && auth.permissions?.includes('exports.create'));
  const currentNamesAllowed = useRef(canReviewNames);
  const [nameReview, setNameReview] = useState(null);
  const [nameNotice, setNameNotice] = useState('');
  const storageKey = operationStorageKey(auth.applicationUser?.id);
  const [operation, setOperation] = useState(() => readStoredOperation(storageKey));
  const operationRef = useRef(operation);
  const pendingOperation = operationPending(operation);
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
  const previousStorageKey = useRef(storageKey);
  const lifetime = auth.principalLifetime;
  const currentLifetime = useRef(lifetime), currentAllowed = useRef(allowed), currentOpen = useRef(open);
  useLayoutEffect(() => {
    currentLifetime.current = lifetime; currentAllowed.current = allowed; currentOpen.current = open; currentNamesAllowed.current = canReviewNames;
    operationRef.current = operation;
  }, [lifetime, allowed, open, operation, canReviewNames]);
  const ownerCurrent = useCallback(() => mounted.current && currentLifetime.current === lifetime
    && (!lifetime || lifetime.valid !== false), [lifetime]);
  const mayRead = useCallback(() => ownerCurrent() && currentAllowed.current, [ownerCurrent]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (previousStorageKey.current === storageKey) return;
    previousStorageKey.current = storageKey; generation.current++; flight.current = false; attempt.current = null;
    const own = readStoredOperation(storageKey); operationRef.current = own; setOperation(own);
    setText(''); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    setReceipt(null); setBatchId(null); setInspections({}); setReconcileAcknowledged({}); setCancelAcknowledged({});
    setBusyKind(''); setUncertain(false); setError(''); setNameReview(null); setNameNotice('');
  }, [storageKey]);
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
    setReceipt(next); setNameNotice(''); setBatchId(next.batchId); setUncertain(false); setError('');
    const activated = next.items.filter((item) => item.localActivatedAt && !notified.current.has(item.intentId));
    if (activated.length) {
      activated.forEach((item) => notified.current.add(item.intentId));
      notifyExportReviewChanged({ kind: 'product' });
      onReceipt?.(next);
    }
    return next;
  }, [onReceipt, receipt, review]);
  const rememberOperation = useCallback((value) => {
    operationRef.current = value; setOperation(value); storeOperation(storageKey, value);
  }, [storageKey]);
  const acceptOperation = useCallback((value, expected) => {
    const next = validateReviewOperation(value, expected);
    rememberOperation(next); setUncertain(false); setError('');
    if (next.state === 'ready') {
      if (next.kind === 'preview') {
        setReview(next.result); setText(next.skus.join('\n')); setSelected([]); setSelectedCreate([]); setAcknowledged(false); setClock(Date.now());
      } else {
        attempt.current ||= { idempotencyKey: next.operationId, selectedSkus: Object.freeze([...next.selectedSkus]) };
        acceptReceipt(next.result, next.operationId, next.selectedSkus);
      }
    } else if (next.state === 'failed') {
      if (next.kind === 'confirm') { attempt.current = null; setBatchId(null); }
      setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
      setError('Перевірку завершено без нового рішення: ' + next.failureCode + '. Оновіть дані та явно почніть нову перевірку.');
    } else if (next.kind === 'confirm') setBatchId(next.operationId);
    return next;
  }, [acceptReceipt, rememberOperation]);
  const readOperation = useCallback(async (expected, signal) => {
    const ticket = generation.current;
    const result = await apiClient.operation(expected.operationId, signal ? { signal } : {});
    if (mayRead() && !signal?.aborted && ticket === generation.current) return acceptOperation(result.data, expected);
    return null;
  }, [apiClient, mayRead, acceptOperation]);
  function start(kind) {
    if (!mayRead() || flight.current) return false;
    flight.current = true; setBusyKind(kind); setError(''); return true;
  }
  function finish() {
    flight.current = false;
    if (ownerCurrent()) setBusyKind('');
  }
  function editText(next) {
    if (!allowed || flight.current || uncertain || batchId || pendingOperation || nameReview) return;
    generation.current++;
    setText(next); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false); setError(''); setNameNotice('');
  }
  function select(article, checked) {
    if (!allowed || flight.current || uncertain || batchId || pendingOperation || nameReview
      || !review?.items.some((item) => item.article === article && item.disposition === 'eligible')) return;
    setSelected((previous) => checked ? [...new Set([...previous, article])] : previous.filter((sku) => sku !== article));
    setSelectedCreate((previous) => previous.filter((sku) => sku !== article));
    setAcknowledged(false);
  }
  function selectCreate(article, checked) {
    if (!allowed || flight.current || uncertain || batchId || pendingOperation || nameReview || !selected.includes(article)
      || !review?.items.some((item) => item.article === article && item.deliveryMode === 'create' && item.disposition === 'eligible')) return;
    setSelectedCreate((previous) => checked ? [...new Set([...previous, article])] : previous.filter((sku) => sku !== article));
    setAcknowledged(false);
  }
  function selectEligible() {
    if (!allowed || flight.current || uncertain || batchId || pendingOperation || nameReview || !review) return;
    setSelectedCreate([]);
    setSelected(review.items.filter((item) => item.disposition === 'eligible').map((item) => item.article));
    setAcknowledged(false);
  }
  async function preview(afterNameReview = false) {
    if (nameReview && afterNameReview !== true || uncertain || batchId || pendingOperation || !start('preview')) return;
    const ticket = ++generation.current;
    let submitted;
    setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    try {
      const skus = historicalInput(text, config.historicalReactivation.maxItems);
      if (apiClient.operation) {
        submitted = { operationId: createRequestId(), kind: 'preview', state: 'unknown' };
        if (!UUID_PATTERN.test(submitted.operationId)) throw new Error('Некоректний номер перевірки.');
        rememberOperation(submitted);
      }
      const result = submitted ? await apiClient.preview(skus, submitted.operationId) : await apiClient.preview(skus);
      if (mayRead() && ticket === generation.current) {
        if (result.data?.format === OPERATION_FORMAT) { acceptOperation(result.data, submitted); return; }
        if (submitted) throw new Error('Сервер не підтвердив номер перевірки. Прочитайте її стан.');
        setReview(validateHistoricalPreview(result.data)); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
        setClock(Date.now());
      }
    } catch (cause) {
      if (mayRead()) {
        if (submitted && cause.response?.status >= 400 && cause.response?.status < 500) rememberOperation(null);
        setError(errorMessage(cause, submitted ? 'Відповідь втрачено. Прочитайте стан цієї самої перевірки.' : 'Не вдалося перевірити перелік.'));
      }
    }
    finally { finish(); }
  }
  async function confirm() {
    if (!review || nameReview || !acknowledged || uncertain || pendingOperation || attempt.current || !start('confirm')) return;
    let submitted;
    try {
      submitted = historicalConfirmation(review, selected, createRequestId(), Date.now(), selectedCreate);
      attempt.current = submitted; setBatchId(submitted.idempotencyKey);
      if (apiClient.operation) rememberOperation({ operationId: submitted.idempotencyKey, kind: 'confirm', state: 'unknown' });
      const result = await apiClient.confirm(submitted);
      if (!ownerCurrent()) return;
      if (!currentAllowed.current) { setUncertain(true); setError(uncertainMessage); return; }
      if (result.data?.format === OPERATION_FORMAT) acceptOperation(result.data, { operationId: submitted.idempotencyKey, kind: 'confirm' });
      else acceptReceipt(result.data, submitted.idempotencyKey, submitted.selectedSkus);
    } catch (cause) {
      if (!ownerCurrent()) return;
      if (!submitted || noAcceptanceCodes.has(cause.response?.data?.code)) {
        if (apiClient.operation) rememberOperation(null);
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
      try { return acceptReceipt(result.data, id, attempt.current?.idempotencyKey === id ? attempt.current.selectedSkus
        : receipt?.batchId === id ? receipt.items.map(item => item.article) : null); }
      catch (cause) { setUncertain(true); throw cause; }
    }
    return null;
  }, [apiClient, mayRead, acceptReceipt, receipt]);
  async function refresh() {
    if (operation && (pendingOperation || operation.kind === 'confirm' && !receipt && operation.state !== 'failed')) {
      if (!start('status')) return;
      try { await readOperation(operation); }
      catch (cause) { if (mayRead()) setError(cause.response?.status === 404
        ? operationNotFoundMessage
        : errorMessage(cause, 'Не вдалося прочитати стан цієї самої операції.')); }
      finally { finish(); }
      return;
    }
    const id = batchId || lookupId.trim();
    if (!UUID_PATTERN.test(id)) { setError('Введіть точний номер операції UUID.'); return; }
    if (!start('status')) return;
    try {
      if (apiClient.operation && !batchId) {
        try { await readOperation({ operationId: id }); return; }
        catch (cause) { if (cause.response?.status !== 404) throw cause; }
      }
      await readStatus(id);
    }
    catch (cause) {
      if (mayRead()) setError(cause.response?.status === 404
        ? 'Операцію за цим номером ще не знайдено. Це не підтверджує відсутність змін. Підтвердження не буде надіслано повторно.'
        : errorMessage(cause, 'Не вдалося прочитати стан. Збережіть номер та повторіть лише перевірку стану.'));
    } finally { finish(); }
  }
  const acceptNameResponse = ticket => mayRead() && currentNamesAllowed.current && currentOpen.current && ticket === generation.current;
  async function readNameReview(request = nameReview?.request) {
    const manual = request?.intent === 'historical-create', readNames = manual ? apiClient.previewManualNames : apiClient.previewNames;
    if (!canReviewNames || !request || batchId || pendingOperation || uncertain || !readNames || !start('name_read')) return;
    const ticket = generation.current;
    setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    setNameReview({ request, preview: null, acknowledged: false, uncertain: Boolean(nameReview?.uncertain) });
    try {
      const response = await readNames(request);
      if (acceptNameResponse(ticket)) {
        const next = manual ? validateHistoricalManualNames(response.data, request) : validateHistoricalNames(response.data, request);
        setNameReview({ request, preview: next, acknowledged: false, uncertain: false,
          ...(manual ? { subjectUa: next.subjectUa || '', subjectEn: next.subjectEn || '' } : {}) });
      }
    } catch (cause) {
      if (acceptNameResponse(ticket)) setError(errorMessage(cause, 'Не вдалося перевірити назви цього самого товару. Повторіть лише читання.'));
    } finally { if (ticket === generation.current) finish(); }
  }
  async function reviewNames(item) {
    const request = historicalNameRepairRequest(item);
    if (request) await readNameReview(request);
  }
  async function completeManualNames(item) {
    const request = historicalManualNameRequest(item);
    if (request) await readNameReview(request);
  }
  function editManualSubject(key, value) {
    if (!canReviewNames || flight.current || nameReview?.request.intent !== 'historical-create' || nameReview.uncertain
      || !['subjectUa', 'subjectEn'].includes(key) || value.length > 200) return;
    setNameReview(previous => ({ ...previous, [key]: value, preview: null, acknowledged: false }));
  }
  async function previewManualNames() {
    const current = nameReview;
    if (!canReviewNames || current?.request.intent !== 'historical-create' || current.uncertain || !apiClient.previewManualNames
      || !current.subjectUa?.trim() || !current.subjectEn?.trim() || batchId || pendingOperation || uncertain || !start('name_read')) return;
    const ticket = generation.current, subjects = { subjectUa: current.subjectUa, subjectEn: current.subjectEn };
    setNameReview({ ...current, preview: null, acknowledged: false });
    try {
      const response = await apiClient.previewManualNames({ ...current.request, ...subjects });
      if (acceptNameResponse(ticket)) {
        const next = validateHistoricalManualNames(response.data, current.request, subjects);
        setNameReview({ ...current, preview: next, subjectUa: next.subjectUa, subjectEn: next.subjectEn, acknowledged: false });
      }
    } catch (cause) {
      if (acceptNameResponse(ticket)) setError(errorMessage(cause, 'Не вдалося перевірити введені назви.'));
    } finally { if (ticket === generation.current) finish(); }
  }
  async function repeatAfterNames() {
    if (!mayRead() || flight.current || pendingOperation || batchId || uncertain) return;
    setNameReview(null); rememberOperation(null); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    await preview(true);
  }
  async function saveNames() {
    const current = nameReview, manual = current?.request.intent === 'historical-create';
    const applyNames = manual ? apiClient.saveManualNames : apiClient.acceptNames;
    if (!canReviewNames || !current?.acknowledged || !current.preview || current.uncertain || current.preview.alreadyAccepted || current.preview.alreadyCompleted
      || pendingOperation || batchId || uncertain || !applyNames) return;
    try {
      if (manual) validateHistoricalManualNames(current.preview, current.request, { subjectUa: current.subjectUa, subjectEn: current.subjectEn });
      else validateHistoricalNames(current.preview, current.request);
    }
    catch (cause) { setNameReview({ ...current, preview: null, acknowledged: false }); setError(cause.message); return; }
    if (!start('name_save')) return;
    const ticket = generation.current; let saved = false;
    try {
      const response = await applyNames({ ...current.request, previewToken: current.preview.previewToken, reviewExpiresAt: current.preview.reviewExpiresAt,
        ...(manual ? { subjectUa: current.preview.subjectUa, subjectEn: current.preview.subjectEn } : {}) });
      if (ownerCurrent() && ticket === generation.current && !acceptNameResponse(ticket)) {
        setNameReview({ request: current.request, preview: null, acknowledged: false, uncertain: true });
      }
      if (acceptNameResponse(ticket)) {
        if (manual) validateHistoricalManualNameReceipt(response.data, current.request, current.preview);
        else validateHistoricalNameReceipt(response.data, current.request);
        setNameNotice(manual ? 'Ручну UA/EN пару збережено. Товар залишається архівованим; перевірку відновлення повторено.'
          : 'Чинні назви Magento збережено в менеджері. Товар залишається архівованим; перевірку відновлення повторено.');
        saved = true;
      }
    } catch (cause) {
      if (ownerCurrent() && ticket === generation.current && !acceptNameResponse(ticket)) {
        setNameReview({ request: current.request, preview: null, acknowledged: false, uncertain: true });
      }
      if (acceptNameResponse(ticket)) {
        const unknown = !(cause.response?.status >= 400 && cause.response.status < 500);
        setNameReview({ request: current.request, preview: null, acknowledged: false, uncertain: unknown });
        setError(errorMessage(cause, unknown ? 'Відповідь збереження назв втрачено. Повторіть лише перевірку назв цього самого товару.' : 'Назви не збережено. Перевірте їх ще раз.'));
      }
    } finally { if (ticket === generation.current) finish(); }
    if (saved && acceptNameResponse(ticket)) await repeatAfterNames();
  }
  function cancelNameReview() {
    if (!flight.current) { setNameReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false); setError(''); }
  }
  const waiting = historicalPending(receipt);
  const operationId = operation?.operationId, operationState = operation?.state, operationKind = operation?.kind;
  useEffect(() => {
    if (!open || !allowed || !operationId || operationState === 'failed' || receipt || !apiClient.operation) return undefined;
    // Also recover a ready preview once after reload. No POST is issued by this effect.
    if (operationState === 'ready' && operationKind === 'preview' && review) return undefined;
    const controller = new AbortController(); let stopped = false, timer;
    async function poll() {
      if (!flight.current && mayRead() && currentOpen.current) {
        const ticket = generation.current;
        flight.current = true; setBusyKind('status');
        try { await readOperation(operationRef.current, controller.signal); }
        catch (cause) { if (!stopped && mayRead() && ticket === generation.current) setError(cause.response?.status === 404
          ? operationNotFoundMessage
          : errorMessage(cause, 'Не вдалося прочитати прогрес. Повторюємо лише читання стану.')); }
        finally {
          if (ticket === generation.current) {
            flight.current = false;
            if (ownerCurrent()) setBusyKind('');
          }
        }
      }
      if (!stopped && mayRead()) timer = setTimeout(poll, 5000);
    }
    timer = setTimeout(poll, operationState === 'unknown' ? 0 : 1000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [open, allowed, operationId, operationState, operationKind, receipt, review, apiClient, ownerCurrent, mayRead, readOperation]);
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
    if (!allowed || busyKind || pendingOperation || !canReset) return;
    generation.current++;
    attempt.current = null; setText(''); setReview(null); setSelected([]); setSelectedCreate([]); setAcknowledged(false);
    rememberOperation(null);
    setReceipt(null); setBatchId(null); setInspections({}); setReconcileAcknowledged({}); setError(''); setNameReview(null); setNameNotice('');
  }
  const expired = Boolean(review && Date.parse(review.reviewExpiresAt) <= clock);
  return {
    canReviewNames, nameReview, nameNotice, reviewNames, readNameReview, saveNames, repeatAfterNames, cancelNameReview,
    completeManualNames, editManualSubject, previewManualNames,
    namesExpired: Boolean(nameReview?.preview && Date.parse(nameReview.preview.reviewExpiresAt) <= clock),
    acknowledgeNames: value => { if (canReviewNames && !flight.current && !nameReview?.uncertain) setNameReview(previous => previous ? { ...previous, acknowledged: value } : null); },
    allowed, text, review, selected, selectedCreate, cancelAcknowledged, canReset, acknowledged, receipt, batchId, lookupId, inspections,
    reconcileAcknowledged, busyKind, uncertain, error, expired, waiting, operation, pendingOperation,
    dirty: Boolean(open && (uncertain || !receipt && text.trim())),
    locked: Boolean(busyKind || uncertain), editText, select, selectCreate, selectEligible, preview, confirm, refresh, inspect, reconcile, cancel, reset,
    setLookupId: (value) => { if (!busyKind && !batchId && !pendingOperation) setLookupId(value); },
    setAcknowledged: (value) => { if (allowed && !flight.current && !nameReview && !uncertain && !batchId && !pendingOperation) setAcknowledged(value); },
    setCancelAcknowledged: (id, value) => { if (allowed && !busyKind && !uncertain) setCancelAcknowledged((previous) => ({ ...previous, [id]: value })); },
    setReconcileAcknowledged: (id, value) => { if (allowed && !busyKind && !uncertain) setReconcileAcknowledged((previous) => ({ ...previous, [id]: value })); },
  };
}
