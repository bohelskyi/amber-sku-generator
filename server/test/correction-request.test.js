const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertClaimOwnership,
  canTransitionCorrectionRequest,
  getClaimTokenHash,
  getCorrectionPreviewSignature,
  haveSameRequestAnswers,
  normalizeRequestStatusFilter,
  previewCorrectionRequest,
} = require('../src/services/correction-request.service');
const { getCorrectionDecisionSignature } = require('../src/services/product/product-signatures');
const {
  calculateDecisionPricing,
  decisionFromRequest,
  normalizePricingDecision,
} = require('../src/services/product/correction-pricing-decision');
const { normalizePriceChangeDecision } = require('../src/services/product-price-change.service');

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
      weight: 10,
      targetValidityFingerprint: 'target-a',
      pricingContextFingerprint: 'context-a',
      uahRate: 40,
      uahRateDate: '2026-09-14',
      answers: { quality: 2, processing: 2 },
      ...overrides.corrected,
    },
  };
}

test('correction pricing decisions validate strict mode-specific fields', () => {
  assert.deepEqual(normalizePricingDecision({ mode: 'system_auto' }), { mode: 'system_auto' });
  assert.deepEqual(normalizePricingDecision({
    mode: 'usd_per_gram', usdPerGram: '10.05', marketingRoundingEnabled: false,
  }), { mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: false });
  assert.deepEqual(normalizePricingDecision({ mode: 'manual_uah', manualPriceUah: '4020.25' }), {
    mode: 'manual_uah', manualPriceUah: 4020.25,
  });
  assert.throws(() => normalizePricingDecision({
    mode: 'usd_per_gram', usdPerGram: 0, marketingRoundingEnabled: false,
  }), /додатним/);
  assert.throws(() => normalizePricingDecision({
    mode: 'manual_uah', manualPriceUah: 10, marketingRoundingEnabled: true,
  }), /не відповідають/);
});

test('price-change requests preserve explicit Manual UAH rounding without weakening recount', () => {
  assert.deepEqual(normalizePriceChangeDecision({
    mode: 'manual_uah', manualPriceUah: '4020.25', marketingRoundingEnabled: true,
  }), {
    mode: 'manual_uah', manualPriceUah: 4020.25, marketingRoundingEnabled: true,
  });
  assert.deepEqual(decisionFromRequest({
    request_type: 'price_change', pricing_mode: 'manual_uah',
    pricing_manual_uah: '4020.25', pricing_rounding_enabled: 1,
  }), {
    mode: 'manual_uah', manualPriceUah: 4020.25, marketingRoundingEnabled: true,
  });
  assert.deepEqual(decisionFromRequest({
    request_type: 'recount', pricing_mode: 'manual_uah',
    pricing_manual_uah: '4020.25', pricing_rounding_enabled: null,
  }), { mode: 'manual_uah', manualPriceUah: 4020.25 });
});

test('correction create permission alone cannot authorize a pricing override', async () => {
  await assert.rejects(previewCorrectionRequest({
    pricingDecision: {
      mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: false,
    },
  }, { canOverride: false }), (error) => error.statusCode === 403);
});

test('custom USD per gram bypasses matrices and applies only its explicit rounding choice', async () => {
  const rateInfo = { rate: 40, source: 'test', rateDate: '2026-09-14' };
  const exact = await calculateDecisionPricing({
    mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: false,
  }, 10, rateInfo);
  const rounded = await calculateDecisionPricing({
    mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: true,
  }, 10, rateInfo);
  assert.equal(exact.currencyPayload.calculatedPriceUah, 4020);
  assert.equal(exact.currencyPayload.totalPriceUah, 4020);
  assert.equal(rounded.currencyPayload.calculatedPriceUah, 4020);
  assert.equal(rounded.currencyPayload.totalPriceUah, 4000);
  assert.equal(exact.pricingDetails.matrix, null);
});

test('exact manual UAH pricing does not use rounding or an exchange rate', async () => {
  const pricing = await calculateDecisionPricing({
    mode: 'manual_uah', manualPriceUah: 4020.25,
  }, 10);
  assert.equal(pricing.currencyPayload.totalPriceUah, 4020.25);
  assert.equal(pricing.currencyPayload.calculatedPriceUah, null);
  assert.equal(pricing.currencyPayload.uahRate, null);
});

test('correction decision signatures bind only dependencies of their pricing mode', () => {
  const usdDecision = {
    mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: false,
  };
  const manualDecision = { mode: 'manual_uah', manualPriceUah: 4020.25 };
  const systemDecision = { mode: 'system_auto' };
  const preview = buildPreview();

  assert.notEqual(
    getCorrectionDecisionSignature(preview, systemDecision),
    getCorrectionDecisionSignature(buildPreview({ corrected: {
      pricingContextFingerprint: 'context-b',
    } }), systemDecision)
  );
  assert.equal(
    getCorrectionDecisionSignature(preview, usdDecision),
    getCorrectionDecisionSignature(buildPreview({ corrected: {
      pricingContextFingerprint: 'unrelated-context', totalPriceUah: 9999,
    } }), usdDecision)
  );
  assert.notEqual(
    getCorrectionDecisionSignature(preview, usdDecision),
    getCorrectionDecisionSignature(buildPreview({ corrected: {
      uahRate: 41, totalPriceUah: 600,
    } }), usdDecision)
  );
  assert.equal(
    getCorrectionDecisionSignature(preview, manualDecision),
    getCorrectionDecisionSignature(buildPreview({ corrected: {
      pricingContextFingerprint: 'unrelated-context', uahRate: 41,
      uahRateDate: '2026-09-15', totalPriceUah: 9999,
    } }), manualDecision)
  );
  assert.notEqual(
    getCorrectionDecisionSignature(preview, manualDecision),
    getCorrectionDecisionSignature(preview, { ...manualDecision, manualPriceUah: 4021.25 })
  );
  assert.notEqual(
    getCorrectionDecisionSignature(preview, manualDecision),
    getCorrectionDecisionSignature(buildPreview({ corrected: {
      targetValidityFingerprint: 'target-b',
    } }), manualDecision)
  );
});

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
    getCorrectionPreviewSignature(buildPreview({ corrected: { totalPriceUah: 99.4 } })),
    getCorrectionPreviewSignature(buildPreview({ corrected: { totalPriceUah: 99.6 } }))
  );
  assert.notEqual(
    getCorrectionPreviewSignature(buildPreview({
      corrected: { calculatedPriceUah: 1113, autoPriceUah: 1100, totalPriceUah: 1100 },
    })),
    getCorrectionPreviewSignature(buildPreview({
      corrected: { calculatedPriceUah: 1114, autoPriceUah: 1100, totalPriceUah: 1100 },
    }))
  );
  assert.notEqual(
    signature,
    getCorrectionPreviewSignature(buildPreview({ corrected: { fullSku: 'NM211-1' } }))
  );
  assert.notEqual(
    signature,
    getCorrectionPreviewSignature(buildPreview({ source: { answers: { quality: 3 } } }))
  );
  assert.notEqual(
    getCorrectionPreviewSignature(buildPreview({ corrected: { pricingContextFingerprint: 'enabled' } })),
    getCorrectionPreviewSignature(buildPreview({ corrected: { pricingContextFingerprint: 'disabled' } }))
  );
});

test('legacy correction signature omits only the new context binding', () => {
  const preview = buildPreview({ corrected: { pricingContextFingerprint: 'default-enabled' } });
  const legacySignature = getCorrectionPreviewSignature(
    preview, { legacyDefaultRounding: true }
  );
  assert.equal(legacySignature, getCorrectionPreviewSignature(
    buildPreview(), { legacyDefaultRounding: true }
  ));
  assert.notEqual(legacySignature, getCorrectionPreviewSignature(preview));
  assert.notEqual(legacySignature, getCorrectionPreviewSignature(buildPreview({
    corrected: { totalPriceUah: 601 },
  }), { legacyDefaultRounding: true }));
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

test('application-user correction ownership ignores tokens but requires the current epoch', () => {
  const row = {
    status: 'in_progress',
    claimed_by_user_id: '17',
    claim_token_hash: getClaimTokenHash('x'.repeat(43)),
    claim_version: '4',
  };

  assert.deepEqual(assertClaimOwnership(row, 17, 4, 'wrong-token'.repeat(4)), {
    claimVersion: 4,
    legacyTokenHash: null,
    legacyAdopted: false,
  });
  assert.throws(() => assertClaimOwnership(row, 18, 4), /іншому працівнику/);
  assert.throws(() => assertClaimOwnership(row, 17, 3), /Призначення.*змінилося/);
  assert.throws(() => assertClaimOwnership(row, 17, undefined), /Версія призначення/);
});

test('only a matching capability can authorize one-time legacy claim adoption', () => {
  const token = 'legacy-claim-token-'.repeat(3);
  const row = {
    status: 'in_progress',
    claimed_by_user_id: null,
    claim_token_hash: getClaimTokenHash(token),
    claim_version: '0',
  };

  assert.deepEqual(assertClaimOwnership(row, 17, 0, token), {
    claimVersion: 0,
    legacyTokenHash: getClaimTokenHash(token),
    legacyAdopted: true,
  });
  assert.throws(() => assertClaimOwnership(row, 17, 0, 'wrong-token'.repeat(4)), /іншому працівнику/);
});
