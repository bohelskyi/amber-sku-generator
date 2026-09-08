import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildRecountPayload,
  buildRecountPreviewPayload,
  createRecountPreviewGate,
  getRecountPricingDependencyState,
  haveRecountTargetChanged,
} from '../src/lib/product-recount.js';

const hookSource = fs.readFileSync(
  new URL('../src/hooks/useProductRecount.js', import.meta.url),
  'utf8'
);
const dashboardSource = fs.readFileSync(
  new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
  'utf8'
);

const decoded = {
  category: { requires_weight: 1 },
  decodedAnswers: [
    { key: 'size', value_id: 2 },
    { key: 'shape', value_id: 1 },
  ],
  product: {
    weight: 20,
    details: { answers: { size: 2, shape: 1 } },
  },
};

test('live and Continue preview payloads match for the same complete Size target', () => {
  const completeTarget = {
    sourceSku: 'BR-SOURCE',
    answers: {
      raw_type: 1,
      size: 1,
      shape: 2,
      is_calibrated: 0,
    },
    isCalibrated: 0,
    weight: '12.4',
    reason: '',
  };
  const livePayload = buildRecountPayload({
    ...completeTarget,
    manualPriceUah: null,
  });
  const continuePayload = buildRecountPayload({
    ...completeTarget,
    manualPriceUah: '',
  });
  const canonicalPreviewPayload = buildRecountPreviewPayload(completeTarget);

  assert.deepEqual(livePayload, continuePayload);
  assert.deepEqual(canonicalPreviewPayload, continuePayload);
  assert.equal(livePayload.manualPriceUah, null);
  assert.equal(
    hookSource.match(/api\.post\('\/recount\/preview', recountPreviewPayload\)/g)?.length,
    2
  );
});

test('changing size schedules a debounced authoritative recount price update', () => {
  assert.equal(haveRecountTargetChanged(decoded, { size: 3, shape: 1 }, '20'), true);
  assert.equal(hookSource.includes('RECOUNT_PREVIEW_DEBOUNCE_MS'), true);
  assert.equal(hookSource.includes("api.post('/recount/preview'"), true);
  assert.match(hookSource, /useEffect\([\s\S]*?recountAnswers[\s\S]*?recountWeight/);
});

test('changing another pricing-driving option uses the same live authoritative preview path', () => {
  assert.equal(haveRecountTargetChanged(decoded, { size: 2, shape: 2 }, '20'), true);
  assert.equal(hookSource.includes("api.post('/recount/preview'"), true);
});

test('pricing-driving recount questions use authoritative dependency metadata', () => {
  const recountSource = dashboardSource.slice(dashboardSource.indexOf('function RecountPanel'));
  assert.equal(recountSource.includes('dependentKeys'), true);
  assert.equal(recountSource.includes('pricingDependentKeys.has(question.id)'), true);
  assert.equal(recountSource.includes("isPriceDriver ? 'is-price-driver' : ''"), true);
});

test('resolved target dependencies replace rather than merge with original pricing dependencies', () => {
  const recountSource = dashboardSource.slice(dashboardSource.indexOf('function RecountPanel'));
  const currentPricing = {
    dependentKeys: ['quality', 'size'],
    matrixName: 'Некалібровані - 2 сорт',
    usesWeight: true,
  };
  const matrixAPreview = {
    corrected: {
      pricingDetails: {
        dependentKeys: ['quality', 'size'],
        scenario: { name: 'Некалібровані - 2 сорт' },
        usesWeight: true,
      },
    },
  };
  const matrixBPreview = {
    corrected: {
      pricingDetails: {
        dependentKeys: ['execution', 'raw_type'],
        scenario: { name: 'Шамбала - натур' },
        usesWeight: false,
      },
    },
  };

  const initialState = getRecountPricingDependencyState({ currentPricing });
  assert.deepEqual(initialState.dependentKeys, ['quality', 'size']);

  const gate = createRecountPreviewGate();
  const staleMatrixARequest = gate.invalidate();
  const latestMatrixBRequest = gate.invalidate();
  let acceptedPreview = null;
  const acceptPreview = (requestId, preview) => {
    if (gate.isCurrent(requestId)) acceptedPreview = preview;
  };
  acceptPreview(latestMatrixBRequest, matrixBPreview);
  acceptPreview(staleMatrixARequest, matrixAPreview);

  const targetState = getRecountPricingDependencyState({
    currentPricing,
    hasRecountChanges: true,
    recountPreview: acceptedPreview,
  });
  assert.deepEqual(targetState.dependentKeys, ['execution', 'raw_type']);
  assert.equal(targetState.dependentKeys.includes('quality'), false);
  assert.equal(targetState.usesWeight, false);

  assert.match(recountSource, /getRecountPricingDependencyState/);
  assert.doesNotMatch(
    recountSource,
    /\.\.\.\(currentPricing\?\.dependentKeys[\s\S]*\.\.\.\(correctedPricing\?\.pricingDetails\?\.dependentKeys/
  );
});

test('unavailable target pricing clears previously valid dependency highlighting', () => {
  const state = getRecountPricingDependencyState({
    currentPricing: { dependentKeys: ['quality'], usesWeight: true },
    hasRecountChanges: true,
    isRecountPreviewUnavailable: true,
    recountPreview: {
      corrected: {
        pricingDetails: { dependentKeys: ['execution'], usesWeight: false },
      },
    },
  });

  assert.deepEqual(state, { dependentKeys: [], usesWeight: false });
});

test('recount comparison renders UAH and USD for totals and per-gram prices', () => {
  assert.equal(dashboardSource.includes('RecountMoneyValue'), true);
  assert.match(dashboardSource, /currentPricing\?\.totalPrice[\s\S]*?correctedPricing\?\.totalPrice/);
  assert.match(dashboardSource, /currentPricing\?\.pricePerGram[\s\S]*?correctedPricing\?\.pricePerGram/);
});

test('price difference includes authoritative UAH and USD deltas', () => {
  assert.equal(dashboardSource.includes('priceDeltaUah'), true);
  assert.equal(dashboardSource.includes('priceDeltaUsd'), true);
});

test('rapid edits invalidate older recount preview responses', () => {
  const gate = createRecountPreviewGate();
  const olderRequest = gate.invalidate();
  const latestRequest = gate.invalidate();

  assert.equal(gate.isCurrent(olderRequest), false);
  assert.equal(gate.isCurrent(latestRequest), true);
  assert.equal(hookSource.includes('previewRequestIdRef'), true);
  assert.equal(hookSource.includes('requestId !== previewRequestIdRef.current'), true);
});

test('Continue is gated while the latest recount preview is pending', () => {
  assert.match(dashboardSource, /disabled=\{!hasRecountChanges \|\| isRecountLoading \|\| isRecountApplying\}/);
  assert.equal(hookSource.includes('isRecountPreviewCurrent'), true);
});

test('automatic preview failures stay neutral during incomplete editing', () => {
  assert.equal(hookSource.includes('surfaceValidation'), true);
  assert.match(hookSource, /if \(surfaceValidation\)[\s\S]*?showRecountValidationFailure/);
});

test('explicit Continue still surfaces recount blockers', () => {
  assert.match(hookSource, /requestRecountPreview\(\{[\s\S]*?surfaceValidation: true/);
});

test('the recount editor has no explicit Recalculate action', () => {
  const recountSource = dashboardSource.slice(dashboardSource.indexOf('function RecountPanel'));
  assert.equal(recountSource.includes('Перерахувати'), false);
  assert.equal(recountSource.includes('onRecountPreview'), false);
  assert.equal(recountSource.includes("'Продовжити'"), true);
});
