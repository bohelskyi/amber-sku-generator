const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canTransitionCorrectionRequest,
  getCorrectionPreviewSignature,
  haveSameRequestAnswers,
  normalizeRequestStatusFilter,
} = require('../src/services/correction-request.service');

function buildPreview(overrides = {}) {
  return {
    source: {
      productId: 17,
      sku: 'NM111',
      totalPriceUah: 500,
      answers: { quality: 1, processing: 2 },
      ...overrides.source,
    },
    corrected: {
      fullSku: 'NM211',
      proposedFullSku: 'NM211',
      totalPriceUah: 600,
      answers: { quality: 2, processing: 2 },
      ...overrides.corrected,
    },
  };
}

test('correction request signature is stable for reordered answers', () => {
  const first = buildPreview();
  const second = buildPreview({
    source: { answers: { processing: 2, quality: 1 } },
    corrected: { answers: { processing: 2, quality: 2 } },
  });

  assert.equal(getCorrectionPreviewSignature(first), getCorrectionPreviewSignature(second));
  assert.equal(haveSameRequestAnswers(
    { quality: 2, processing: 2 },
    { processing: 2, quality: 2 }
  ), true);
});

test('correction request signature changes with SKU, price, or parameters', () => {
  const signature = getCorrectionPreviewSignature(buildPreview());

  assert.notEqual(
    signature,
    getCorrectionPreviewSignature(buildPreview({ corrected: { totalPriceUah: 700 } }))
  );
  assert.notEqual(
    signature,
    getCorrectionPreviewSignature(buildPreview({ corrected: { fullSku: 'NM211-1' } }))
  );
  assert.notEqual(
    signature,
    getCorrectionPreviewSignature(buildPreview({ source: { answers: { quality: 3 } } }))
  );
});

test('correction request status transitions protect completed requests', () => {
  assert.equal(canTransitionCorrectionRequest('pending', 'in_progress'), true);
  assert.equal(canTransitionCorrectionRequest('pending', 'rejected'), true);
  assert.equal(canTransitionCorrectionRequest('in_progress', 'pending'), true);
  assert.equal(canTransitionCorrectionRequest('rejected', 'pending'), true);
  assert.equal(canTransitionCorrectionRequest('completed', 'pending'), false);
  assert.equal(canTransitionCorrectionRequest('pending', 'completed'), false);
});

test('correction request status filter falls back to active requests', () => {
  assert.equal(normalizeRequestStatusFilter('completed'), 'completed');
  assert.equal(normalizeRequestStatusFilter('all'), 'all');
  assert.equal(normalizeRequestStatusFilter('unexpected'), 'active');
  assert.equal(normalizeRequestStatusFilter(), 'active');
});
