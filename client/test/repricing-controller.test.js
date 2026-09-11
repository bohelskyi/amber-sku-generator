import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialRepricingControllerState,
  repricingControllerReducer,
} from '../src/hooks/repricing/useRepricingControllerState.js';

test('repricing controller applies value and updater actions without mutating prior state', () => {
  const withDraft = repricingControllerReducer(initialRepricingControllerState, {
    type: 'set',
    field: 'activeDraft',
    value: { id: 12 },
  });
  const withManualPrice = repricingControllerReducer(withDraft, {
    type: 'set',
    field: 'manualPrices',
    value: (prices) => ({ ...prices, 44: '125.50' }),
  });

  assert.equal(initialRepricingControllerState.activeDraft, null);
  assert.deepEqual(withManualPrice.activeDraft, { id: 12 });
  assert.deepEqual(withManualPrice.manualPrices, { 44: '125.50' });
});

test('repricing controller ignores unknown actions and fields', () => {
  assert.equal(
    repricingControllerReducer(initialRepricingControllerState, { type: 'unknown' }),
    initialRepricingControllerState
  );
  assert.equal(
    repricingControllerReducer(initialRepricingControllerState, {
      type: 'set',
      field: 'unsafeField',
      value: true,
    }),
    initialRepricingControllerState
  );
});
