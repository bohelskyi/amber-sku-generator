import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialRepricingControllerState,
  repricingControllerReducer,
} from '../src/hooks/repricing/useRepricingControllerState.js';

test('repricing controller applies draft and resolution transitions atomically', () => {
  const withDraft = repricingControllerReducer(initialRepricingControllerState, {
    type: 'draftPayloadLoaded',
    draft: { id: 12, reviewedProductIds: [7] },
    preview: { summary: { errorCount: 0 } },
    manualPrices: { 44: '125.50' },
    automaticProductIds: [45],
    reviewedProductIds: [7],
    conflicts: [],
    sync: null,
    uiState: {},
  });
  const withAutomaticPrice = repricingControllerReducer(withDraft, {
    type: 'automaticPriceSelected',
    productId: 44,
  });

  assert.equal(initialRepricingControllerState.activeDraft, null);
  assert.deepEqual(withDraft.manualPrices, { 44: '125.50' });
  assert.deepEqual(withAutomaticPrice.activeDraft, { id: 12, reviewedProductIds: [7] });
  assert.deepEqual(withAutomaticPrice.manualPrices, {});
  assert.deepEqual(withAutomaticPrice.automaticProductIds, [44, 45]);
  assert.deepEqual(withAutomaticPrice.reviewedProductIds, [7, 44]);
});

test('repricing controller resets dependent workflow state when the scenario changes', () => {
  const populated = {
    ...initialRepricingControllerState,
    activeDraft: { id: 12 },
    appliedBatch: { id: 3 },
    automaticProductIds: [44],
    draftConflicts: [{ productId: 45 }],
    manualPrices: { 44: '125.50' },
    preview: { previewToken: 'old-token' },
    previewing: true,
    reviewedProductIds: [44],
  };
  const selected = repricingControllerReducer(populated, {
    type: 'scenarioSelected',
    scenarioId: '22',
  });

  assert.equal(selected.scenarioId, '22');
  assert.equal(selected.preview, null);
  assert.equal(selected.activeDraft, null);
  assert.equal(selected.appliedBatch, null);
  assert.equal(selected.previewing, false);
  assert.deepEqual(selected.manualPrices, {});
  assert.deepEqual(selected.automaticProductIds, []);
  assert.deepEqual(selected.reviewedProductIds, []);
});

test('repricing controller ignores unknown actions and non-editable fields', () => {
  assert.equal(
    repricingControllerReducer(initialRepricingControllerState, { type: 'unknown' }),
    initialRepricingControllerState
  );
  assert.equal(
    repricingControllerReducer(initialRepricingControllerState, {
      type: 'edit',
      field: 'activeDraft',
      value: true,
    }),
    initialRepricingControllerState
  );
});
