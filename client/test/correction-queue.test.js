import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRECTION_QUEUE_POLL_INTERVAL_MS,
  createLatestRequestGate,
  createVisibilityAwarePoller,
  getCorrectionClaimOwnership,
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

test('latest-request gate prevents an older queue response replacing newer state', () => {
  const gate = createLatestRequestGate();
  const older = gate.next();
  const newer = gate.next();
  assert.equal(gate.isLatest(older), false);
  assert.equal(gate.isLatest(newer), true);
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
