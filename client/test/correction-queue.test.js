import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRECTION_QUEUE_POLL_INTERVAL_MS,
  createLatestRequestGate,
  createVisibilityAwarePoller,
  getCorrectionClaimOwnership,
  getCorrectionRequestsForView,
  isCorrectionClaimConflict,
  orderActiveCorrectionRequests,
  readCorrectionClaims,
  reconcileCorrectionClaims,
  removeCorrectionClaim,
  storeCorrectionClaim,
  writeCorrectionClaims,
} from '../src/lib/correction-queue.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

test('claim capability persists locally and identifies only the matching database claim', () => {
  const storage = createStorage();
  const claimedRequest = {
    id: 17,
    status: 'in_progress',
    claimFingerprint: 'abc123',
  };
  const claims = storeCorrectionClaim({}, claimedRequest, 'raw-secret-token');
  writeCorrectionClaims(claims, storage);

  assert.deepEqual(readCorrectionClaims(storage), claims);
  assert.equal(getCorrectionClaimOwnership(claimedRequest, claims), 'owned');
  assert.equal(getCorrectionClaimOwnership({
    ...claimedRequest,
    claimFingerprint: 'replacement-claim',
  }, claims), 'other');
  assert.equal(getCorrectionClaimOwnership({ ...claimedRequest, status: 'pending' }, claims), 'none');
  assert.deepEqual(removeCorrectionClaim(claims, 17), {});
});

test('queue reconciliation removes a local token after release or force-reclaim', () => {
  const claims = {
    17: { token: 'first-token', fingerprint: 'first-claim' },
    18: { token: 'second-token', fingerprint: 'second-claim' },
  };
  const reconciled = reconcileCorrectionClaims(claims, [
    { id: 17, status: 'pending', claimFingerprint: null },
    { id: 18, status: 'in_progress', claimFingerprint: 'replacement-claim' },
  ]);
  assert.deepEqual(reconciled, {});
});

test('refresh and stale completion errors preserve ownership until a real claim conflict', () => {
  const request = {
    id: 17,
    status: 'in_progress',
    claimFingerprint: 'browser-claim',
  };
  const claims = {
    17: { token: 'raw-browser-token', fingerprint: 'browser-claim' },
  };
  const refreshedClaims = reconcileCorrectionClaims(claims, [{
    ...request,
    updatedAt: '2026-09-07T10:00:00Z',
  }]);
  const staleCompletionError = {
    response: { status: 409, data: { details: { type: 'stale_correction_request' } } },
  };
  const ownershipError = {
    response: { status: 409, data: { details: { type: 'correction_claim_conflict' } } },
  };

  assert.deepEqual(refreshedClaims, claims);
  assert.equal(isCorrectionClaimConflict(staleCompletionError), false);
  assert.equal(isCorrectionClaimConflict(ownershipError), true);
  assert.equal(refreshedClaims[17].token, 'raw-browser-token');
  assert.equal(getCorrectionClaimOwnership(request, refreshedClaims), 'owned');
});

test('latest-request gate prevents an older queue response replacing newer state', () => {
  const gate = createLatestRequestGate();
  const older = gate.next();
  const newer = gate.next();
  assert.equal(gate.isLatest(older), false);
  assert.equal(gate.isLatest(newer), true);
});

test('active queue pins this browser claims and keeps each group oldest-first', () => {
  const requests = [
    { id: 10, status: 'pending', createdAt: '2026-09-01T10:00:00Z' },
    {
      id: 11,
      status: 'in_progress',
      claimFingerprint: 'own-older',
      createdAt: '2026-09-02T10:00:00Z',
    },
    {
      id: 12,
      status: 'in_progress',
      claimFingerprint: 'other-claim',
      createdAt: '2026-09-03T10:00:00Z',
    },
    {
      id: 13,
      status: 'in_progress',
      claimFingerprint: 'own-newer',
      createdAt: '2026-09-04T10:00:00Z',
    },
    { id: 14, status: 'pending', createdAt: '2026-09-05T10:00:00Z' },
  ];
  const claims = {
    11: { token: 'token-11', fingerprint: 'own-older' },
    13: { token: 'token-13', fingerprint: 'own-newer' },
  };

  assert.deepEqual(
    orderActiveCorrectionRequests(requests, claims).map((request) => request.id),
    [11, 13, 10, 12, 14]
  );
});

test('workspace shows own claims first, then pending FIFO, and excludes foreign claims', () => {
  const storage = createStorage();
  const requests = [
    { id: 31, status: 'pending', createdAt: '2026-09-01T10:00:00Z' },
    {
      id: 32,
      status: 'in_progress',
      claimFingerprint: 'own-oldest',
      createdAt: '2026-09-02T10:00:00Z',
    },
    {
      id: 33,
      status: 'in_progress',
      claimFingerprint: 'foreign',
      createdAt: '2026-09-03T10:00:00Z',
    },
    {
      id: 34,
      status: 'in_progress',
      claimFingerprint: 'own-newest',
      createdAt: '2026-09-04T10:00:00Z',
    },
  ];
  writeCorrectionClaims({
    32: { token: 'token-32', fingerprint: 'own-oldest' },
    33: { token: 'stale-token', fingerprint: 'replaced-claim' },
    34: { token: 'token-34', fingerprint: 'own-newest' },
  }, storage);
  const claims = readCorrectionClaims(storage);

  assert.deepEqual(
    getCorrectionRequestsForView(requests, claims, 'workspace').map((request) => request.id),
    [32, 34, 31]
  );
});

test('visible queue polling observes another client claim without overlapping requests', async () => {
  const documentObject = createEventTarget({ visibilityState: 'visible' });
  const windowObject = createEventTarget();
  let scheduled = null;
  const setTimeoutFn = (callback, delay) => {
    scheduled = { callback, delay };
    return scheduled;
  };
  const clearTimeoutFn = (timer) => {
    if (scheduled === timer) scheduled = null;
  };
  let sharedStatus = 'pending';
  let displayedStatus = 'pending';
  let pollCount = 0;
  let resolvePoll;
  const stop = createVisibilityAwarePoller({
    documentObject,
    windowObject,
    setTimeoutFn,
    clearTimeoutFn,
    poll: async () => {
      pollCount += 1;
      displayedStatus = sharedStatus;
      await new Promise((resolve) => { resolvePoll = resolve; });
    },
  });

  assert.equal(scheduled.delay, CORRECTION_QUEUE_POLL_INTERVAL_MS);
  sharedStatus = 'in_progress';
  const scheduledPoll = scheduled.callback();
  assert.equal(displayedStatus, 'in_progress');
  windowObject.dispatch('focus');
  assert.equal(pollCount, 1, 'a focus event must not overlap the running poll');
  resolvePoll();
  await scheduledPoll;
  assert.equal(scheduled.delay, CORRECTION_QUEUE_POLL_INTERVAL_MS);

  documentObject.visibilityState = 'hidden';
  await scheduled.callback();
  assert.equal(pollCount, 1, 'hidden tabs must not poll');
  documentObject.visibilityState = 'visible';
  documentObject.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(pollCount, 2, 'becoming visible must refresh immediately');
  resolvePoll();
  await Promise.resolve();
  stop();
  assert.equal(scheduled, null);
});

test('polling, claim, release, completion, and foreign claims keep workspace current', async () => {
  const documentObject = createEventTarget({ visibilityState: 'visible' });
  const windowObject = createEventTarget();
  let scheduled = null;
  const setTimeoutFn = (callback) => {
    scheduled = callback;
    return callback;
  };
  const clearTimeoutFn = (timer) => {
    if (scheduled === timer) scheduled = null;
  };
  let claims = {};
  let responseItems = [
    { id: 21, status: 'pending', createdAt: '2026-09-01T10:00:00Z' },
    { id: 22, status: 'pending', createdAt: '2026-09-02T10:00:00Z' },
    {
      id: 23,
      status: 'in_progress',
      claimFingerprint: 'foreign-claim',
      createdAt: '2026-09-03T10:00:00Z',
    },
  ];
  let displayedIds = [];
  const stop = createVisibilityAwarePoller({
    documentObject,
    windowObject,
    setTimeoutFn,
    clearTimeoutFn,
    poll: async () => {
      displayedIds = getCorrectionRequestsForView(responseItems, claims, 'workspace')
        .map((request) => request.id);
    },
  });

  await scheduled();
  assert.deepEqual(displayedIds, [21, 22], 'pending FIFO is available; foreign claims are hidden');

  responseItems[1] = {
    ...responseItems[1],
    status: 'in_progress',
    claimFingerprint: 'own-22',
  };
  claims = storeCorrectionClaim(claims, responseItems[1], 'token-22');
  await scheduled();
  assert.deepEqual(displayedIds, [22, 21], 'a successful claim moves into the leading owned group');

  claims = removeCorrectionClaim(claims, 22);
  responseItems = [
    responseItems[0],
    { ...responseItems[1], status: 'pending', claimFingerprint: null },
    responseItems[2],
  ];
  await scheduled();
  assert.deepEqual(displayedIds, [21, 22], 'release returns the request to available FIFO');

  responseItems[1] = {
    ...responseItems[1],
    status: 'in_progress',
    claimFingerprint: 'own-22-again',
  };
  claims = storeCorrectionClaim(claims, responseItems[1], 'token-22-again');
  await scheduled();
  assert.deepEqual(displayedIds, [22, 21]);

  claims = removeCorrectionClaim(claims, 22);
  responseItems = responseItems.filter((request) => request.id !== 22);
  await scheduled();
  assert.deepEqual(displayedIds, [21], 'completion removes the request from the workspace');

  responseItems[0] = {
    ...responseItems[0],
    status: 'in_progress',
    claimFingerprint: 'another-worker',
  };
  await scheduled();
  assert.deepEqual(displayedIds, [], 'polling removes a request claimed by another worker');

  responseItems[0] = {
    ...responseItems[0],
    status: 'pending',
    claimFingerprint: null,
  };
  await scheduled();
  assert.deepEqual(displayedIds, [21], 'a foreign release restores the request to FIFO availability');
  stop();
});
