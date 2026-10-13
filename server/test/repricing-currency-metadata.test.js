const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const pricing = require('../src/services/pricing.service');
const pricingContext = require('../src/services/pricing/pricing-context');
const currency = require('../src/services/currency.service');
const {
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
} = require('../src/services/repricing/tokens');
const {
  applyManualOverridesToPreview,
  getApplicationToken,
} = require('../src/services/repricing/resolutions');

const currentRate = {
  rate: 41.25,
  rateDate: '2026-10-12',
  fetchedAt: '2026-10-12T07:00:00.000Z',
  source: 'nbu',
  stale: false,
};
const staleRate = {
  ...currentRate,
  source: 'last_known_good',
  stale: true,
  error: 'NBU request timed out',
  ageMs: 86400000,
};

function fixture(t, { rateInfo = staleRate, providerError, manual = false, fixed = false, custom = false } = {}) {
  const scenario = {
    id: 17,
    category_code: 'NM',
    name: 'Amber',
    match_json: {},
    axis_x_key: 'color',
    price_mode: fixed ? 'fixed_uah' : 'per_gram_usd',
    apply_modifiers: false,
  };
  const context = {
    categoryCode: 'NM',
    category: { requires_weight: 1, marketing_rounding_enabled: 1 },
    scenarios: [scenario],
    matrixByCell: new Map(),
    weightBandsByScenario: new Map(),
    modifiers: [],
  };
  const products = [{
    id: 1,
    full_sku: 'NM1',
    public_sku: 'AG-000001',
    category: 'NM',
    weight: '10',
    total_price: '10',
    total_price_uah: '400',
    price_per_gram: '1',
    uah_rate: '40',
    status: 'active',
    details: {
      answers: { color: 1 },
      ...(manual ? { manualPriceUah: 400 } : {}),
      ...(custom ? { customUsdPerGramBasis: { usdPerGram: 2, marketingRoundingEnabled: false } } : {}),
    },
  }];
  const originalProducts = structuredClone(products);
  const reads = [];
  let draftRow;
  const queryable = {
    async query(sql) {
      reads.push(sql);
      assert.match(sql.trim(), /^SELECT\b/, 'preview and draft reads must never apply prices');
      if (sql.includes('FROM repricing_drafts') && draftRow) return { rows: [draftRow] };
      if (sql.includes('FROM products p')) return { rows: products };
      if (sql.includes('FROM correction_requests')) return { rows: [] };
      assert.fail(`Unexpected query: ${sql}`);
    },
  };
  t.mock.method(pool, 'query', async () => assert.fail('Real database query is forbidden'));
  t.mock.method(pool, 'connect', async () => assert.fail('Preview must not open a write transaction'));
  t.mock.method(pricingContext, 'loadScenarioPricingContext', async () => ({ scenario, context }));
  t.mock.method(pricingContext, 'loadPricingContexts', async () => new Map([['NM', context]]));
  const provider = t.mock.method(currency, 'getUsdUahRateInfo', async () => {
    if (providerError) throw providerError;
    return rateInfo;
  });
  const calculator = t.mock.method(pricing, 'calculatePricing', async (category, answers, weight, calibrated, options) => {
    if (!fixed && !options.rateInfo?.rate) throw new Error('Exchange rate unavailable');
    const amount = fixed ? 450 : options.rateInfo.rate * Number(weight);
    return {
      priceMode: scenario.price_mode,
      pricePerGram: 1,
      totalPrice: Number(weight),
      currencyPayload: {
        uahRate: options.rateInfo?.rate ?? null,
        calculatedPriceUah: amount,
        totalPriceUah: amount,
      },
      pricingDetails: { scenario, matrix: { price: 1 } },
    };
  });
  const previewPath = require.resolve('../src/services/repricing/preview-read-model');
  const servicePath = require.resolve('../src/services/repricing.service');
  const customPath = require.resolve('../src/services/repricing/custom-usd-basis');
  const decisionPath = require.resolve('../src/services/product/correction-pricing-decision');
  delete require.cache[previewPath];
  delete require.cache[servicePath];
  // Keep the real custom-basis calculator while capturing this test's provider
  // mock rather than a destructured provider left over from an earlier fixture.
  delete require.cache[customPath];
  delete require.cache[decisionPath];
  const previews = require(previewPath);
  t.after(() => {
    delete require.cache[previewPath];
    delete require.cache[servicePath];
    delete require.cache[customPath];
    delete require.cache[decisionPath];
    assert.deepEqual(products, originalProducts, 'Preview must not mutate stored product state');
  });
  return {
    reads,
    provider,
    calculator,
    async preview(scope, observation) {
      const options = { queryable, ...(observation ? { rateObservation: observation } : {}) };
      return scope === 'global'
        ? previews.buildGlobalRepricingPreview(options)
        : previews.buildRepricingPreview(scenario.id, options);
    },
    async reopenDraft(scope, storedPreview, observation) {
      draftRow = {
        id: 3,
        scope,
        scenario_id: scope === 'global' ? null : scenario.id,
        status: 'draft',
        preview_snapshot: getRepricingPreviewSnapshot(storedPreview),
        manual_overrides: [],
        reviewed_product_ids: [1],
      };
      return require(servicePath).getRepricingDraft(3, { queryable, rateObservation: observation });
    },
  };
}

for (const scope of ['scenario', 'global']) {
  test(`${scope} preview exposes the actual stale rate and its date/error as explicit metadata`, async (t) => {
    const f = fixture(t);
    const preview = await f.preview(scope);
    assert.deepEqual(JSON.parse(JSON.stringify(preview)).currency, {
      rate: 41.25,
      rateDate: '2026-10-12',
      fetchedAt: '2026-10-12T07:00:00.000Z',
      source: 'last_known_good',
      stale: true,
      error: 'NBU request timed out',
    });
    assert.equal(preview.items[0].newPriceUah, 412.5);
    assert.equal(preview.items[0].uahRate, preview.currency.rate);
    assert.equal(f.provider.mock.callCount(), 1);
  });

  test(`${scope} preview reports unavailable provider metadata without applying prices`, async (t) => {
    const f = fixture(t, { providerError: new Error('NBU unavailable') });
    const preview = await f.preview(scope);
    assert.deepEqual(preview.currency, {
      rate: null,
      rateDate: null,
      fetchedAt: null,
      source: 'unavailable',
      stale: false,
      error: 'NBU unavailable',
    });
    assert.equal(preview.summary.changedCount, 0);
    assert.equal(preview.items[0].status, 'error');
    assert.equal(preview.items[0].errorCode, 'calculation_failed');
  });

  test(`${scope} observed-rate metadata has nullable fields and a boolean stale flag`, async (t) => {
    const f = fixture(t);
    const preview = await f.preview(scope, { rateInfo: { rate: 41.25 } });
    assert.deepEqual(preview.currency, {
      rate: 41.25,
      rateDate: null,
      fetchedAt: null,
      source: null,
      stale: false,
      error: null,
    });
    assert.equal(f.provider.mock.callCount(), 0);
  });

  test(`${scope} failed rate observation preserves fixed-UAH preview availability`, async (t) => {
    const f = fixture(t, { fixed: true });
    const preview = await f.preview(scope, { rateInfo: null, rateError: 'NBU observation failed' });
    assert.deepEqual(preview.currency, {
      rate: null,
      rateDate: null,
      fetchedAt: null,
      source: 'unavailable',
      stale: false,
      error: 'NBU observation failed',
    });
    assert.equal(preview.items[0].newPriceUah, 450);
    assert.equal(preview.summary.errorCount, 0);
    assert.equal(f.provider.mock.callCount(), 0);
  });

  test(`${scope} custom USD basis keeps a failed captured observation without reading another rate`, async (t) => {
    const f = fixture(t, { custom: true, rateInfo: { ...currentRate, rate: 99 } });
    const preview = await f.preview(scope, { rateInfo: null, rateError: 'NBU observation failed' });
    assert.equal(preview.currency.rate, null);
    assert.equal(preview.currency.error, 'NBU observation failed');
    assert.equal(preview.items.length, 1);
    assert.equal(preview.items[0].status, 'error');
    assert.equal(preview.items[0].errorCode, 'calculation_failed');
    assert.match(preview.items[0].message, /Авторитетний курс USD\/UAH недоступний/);
    assert.equal(preview.summary.changedCount, 0);
    assert.equal(preview.summary.errorCount, 1);
    assert.equal(f.provider.mock.callCount(), 0, 'a failed observation must not cause a second provider read');
    assert.equal(f.calculator.mock.callCount(), 0, 'custom USD must use the real decision calculator');
  });

  test(`${scope} presentation metadata preserves tokens, resolutions and reopened draft validity`, async (t) => {
    const f = fixture(t);
    const fresh = await f.preview(scope, { rateInfo: currentRate });
    const stale = await f.preview(scope, { rateInfo: staleRate });
    assert.deepEqual(stale.items, fresh.items);
    assert.equal(stale.previewToken, fresh.previewToken);
    assert.equal(getRepricingPreviewFingerprint(stale), getRepricingPreviewFingerprint(fresh));
    const resolutions = [{ productId: 1, newPriceUah: 450 }];
    const resolved = applyManualOverridesToPreview(stale, resolutions);
    assert.deepEqual(resolved.currency, stale.currency);
    assert.equal(getApplicationToken(stale.previewToken, resolutions), getApplicationToken(fresh.previewToken, resolutions));
    const reopened = await f.reopenDraft(scope, fresh, { rateInfo: staleRate });
    assert.deepEqual(reopened.preview.currency, stale.currency);
    assert.equal(reopened.sync.hasChanges, false);
    assert.deepEqual(reopened.draft.reviewedProductIds, [1]);

    const changedRate = await f.preview(scope, { rateInfo: { ...staleRate, rate: 42 } });
    assert.notEqual(changedRate.previewToken, fresh.previewToken);
    assert.notEqual(getRepricingPreviewFingerprint(changedRate), getRepricingPreviewFingerprint(fresh));
    assert.ok(f.reads.every((sql) => /^SELECT\b/.test(sql.trim())));
  });
}

test('stale currency metadata leaves a global manual price unchanged until explicit resolution', async (t) => {
  const f = fixture(t, { manual: true });
  const preview = await f.preview('global');
  assert.equal(preview.currency.stale, true);
  assert.equal(preview.items[0].newPriceUah, 400);
  assert.equal(preview.items[0].manualPreserved, true);
  assert.equal(preview.summary.changedCount, 0);
  const resolved = applyManualOverridesToPreview(preview, [], [1]);
  assert.deepEqual(resolved.currency, preview.currency);
  assert.equal(resolved.items[0].newPriceUah, 412.5);
  assert.equal(resolved.items[0].useAutomatic, true);
});

test('failed rate observation preserves a global manual price without automatic resolution', async (t) => {
  const f = fixture(t, { manual: true });
  const preview = await f.preview('global', { rateInfo: null, rateError: 'NBU observation failed' });
  assert.equal(preview.currency.error, 'NBU observation failed');
  assert.equal(preview.items[0].newPriceUah, 400);
  assert.equal(preview.items[0].manualPreserved, true);
  assert.equal(preview.summary.changedCount, 0);
  assert.equal(preview.summary.errorCount, 0);
  assert.equal(f.provider.mock.callCount(), 0);
});
