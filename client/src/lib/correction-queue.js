export const CORRECTION_QUEUE_POLL_INTERVAL_MS = 5000;
const CLAIM_STORAGE_KEY = 'amber.correction-request-claims';

function normalizeClaimRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const token = typeof record.token === 'string' ? record.token : '';
  const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint : '';
  return token && fingerprint ? { token, fingerprint } : null;
}

export function readCorrectionClaims(storage = globalThis.localStorage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(CLAIM_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([requestId, record]) => [requestId, normalizeClaimRecord(record)])
        .filter(([requestId, record]) => Number(requestId) > 0 && record)
    );
  } catch {
    return {};
  }
}

export function writeCorrectionClaims(claims, storage = globalThis.localStorage) {
  if (!storage) return;
  try {
    storage.setItem(CLAIM_STORAGE_KEY, JSON.stringify(claims || {}));
  } catch {
    // Keep the in-memory claim usable when storage is unavailable.
  }
}

export function storeCorrectionClaim(claims, request, claimToken) {
  if (!request?.id || !request.claimFingerprint || !claimToken) return claims;
  return {
    ...claims,
    [request.id]: {
      token: claimToken,
      fingerprint: request.claimFingerprint,
    },
  };
}

export function removeCorrectionClaim(claims, requestId) {
  const nextClaims = { ...claims };
  delete nextClaims[requestId];
  return nextClaims;
}

export function getCorrectionClaimOwnership(request, claims = {}) {
  if (request?.status !== 'in_progress') return 'none';
  const claim = normalizeClaimRecord(claims[request.id]);
  return claim && claim.fingerprint === request.claimFingerprint ? 'owned' : 'other';
}

export function reconcileCorrectionClaims(claims = {}, requests = []) {
  const nextClaims = { ...claims };
  for (const request of requests) {
    if (!Object.prototype.hasOwnProperty.call(nextClaims, request.id)) continue;
    if (getCorrectionClaimOwnership(request, nextClaims) !== 'owned') {
      delete nextClaims[request.id];
    }
  }
  return nextClaims;
}

export function createLatestRequestGate() {
  let latestRequestId = 0;
  return {
    next() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isLatest(requestId) {
      return requestId === latestRequestId;
    },
  };
}

export function createVisibilityAwarePoller({
  poll,
  intervalMs = CORRECTION_QUEUE_POLL_INTERVAL_MS,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
}) {
  let active = true;
  let inFlight = false;
  let timer = null;

  const isVisible = () => !documentObject || documentObject.visibilityState !== 'hidden';
  const clearTimer = () => {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (active) timer = setTimeoutFn(run, intervalMs);
  };
  const run = async () => {
    clearTimer();
    if (!active || inFlight || !isVisible()) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
      schedule();
    }
  };
  const refreshWhenVisible = () => {
    if (!active || !isVisible()) return;
    clearTimer();
    void run();
  };

  documentObject?.addEventListener?.('visibilitychange', refreshWhenVisible);
  windowObject?.addEventListener?.('focus', refreshWhenVisible);
  schedule();

  return () => {
    active = false;
    clearTimer();
    documentObject?.removeEventListener?.('visibilitychange', refreshWhenVisible);
    windowObject?.removeEventListener?.('focus', refreshWhenVisible);
  };
}
