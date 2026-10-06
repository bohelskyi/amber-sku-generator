import { UUID_PATTERN, validateHistoricalPreview, validateHistoricalReceipt } from './historical-reactivation.js';
export const OPERATION_FORMAT = 'historical-review-operation-v1';
export const operationPending = (value) => Boolean(value && !['ready', 'failed'].includes(value.state));
const invalid = () => { throw new Error('Неповний результат перевірки. Прочитайте стан цієї самої операції за її номером.'); };
export function validateReviewOperation(value, expected) {
  if (value?.format !== OPERATION_FORMAT || !UUID_PATTERN.test(value.operationId)
    || expected && (value.operationId !== expected.operationId || expected.kind != null && value.kind !== expected.kind)
    || !['preview', 'confirm'].includes(value.kind) || !['queued', 'running', 'ready', 'failed'].includes(value.state)
    || !Array.isArray(value.skus) || !value.skus.length || value.skus.length > 100 || value.skus.some(s => typeof s !== 'string' || !s.trim())
    || !value.progress || !Number.isSafeInteger(value.progress.completed) || !Number.isSafeInteger(value.progress.total)
    || value.progress.total !== value.skus.length || value.progress.completed < 0 || value.progress.completed > value.progress.total
    || !Number.isFinite(Date.parse(value.deadlineAt))) invalid();
  if (value.state === 'ready') {
    if (value.kind === 'preview') {
      const review = validateHistoricalPreview(value.result);
      if (JSON.stringify(review.skus) !== JSON.stringify(value.skus)) invalid();
    } else {
      const receipt = validateHistoricalReceipt(value.result, value.operationId);
      if (!Array.isArray(value.selectedSkus) || !value.selectedSkus.length || receipt.items.length !== value.selectedSkus.length
        || receipt.items.some(item => !value.selectedSkus.includes(item.article))) invalid();
    }
  } else if (value.result != null) invalid();
  if (value.state === 'failed' && (typeof value.failureCode !== 'string' || !/^[A-Z_]+$/.test(value.failureCode))) invalid();
  return value;
}
export function operationStorageKey(actor) {
  const id = Number(actor);
  return Number.isSafeInteger(id) && id > 0 ? `amber:historical-review:${id}` : null;
}
// Only an opaque ID and operation kind. Review tokens, selections and CSRF/session
// credentials stay out of browser storage; the authorized server owns recovery.
export function readStoredOperation(key) {
  if (!key) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key));
    return value && UUID_PATTERN.test(value.operationId) && ['preview', 'confirm'].includes(value.kind)
      ? { operationId: value.operationId, kind: value.kind, state: 'unknown' } : null;
  } catch { return null; }
}
export function storeOperation(key, value) {
  if (!key) return;
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify({ operationId: value.operationId, kind: value.kind }));
    else sessionStorage.removeItem(key);
  } catch { /* The visible immutable ID still supports manual recovery. */ }
}
