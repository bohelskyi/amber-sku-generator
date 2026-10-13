const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const pricing = require('../src/services/pricing.service');
const decode = require('../src/services/product/product-decode');
const characteristics = require('../src/services/product/characteristic-config');
const recountEvidence = require('../src/services/product/recount-evidence');

function fixture(t) {
  const product = {
    id: 1,
    category: 'NM',
    status: 'active',
    weight: 10,
    total_price: 10,
    total_price_uah: 400,
    price_per_gram: 1,
    uah_rate: 40,
    details: { answers: { kind: 1 } },
  };
  const originalProduct = structuredClone(product);
  t.mock.method(pool, 'query', async () => assert.fail('Real database query is forbidden'));
  t.mock.method(pool, 'connect', async () => assert.fail('Unexpected database connection'));
  t.mock.method(decode, 'decodeSku', async () => ({
    existsInDb: true,
    sku: 'AG-000001',
    publicSku: 'AG-000001',
    internalSku: null,
    category: { code: 'NM' },
    decodedAnswers: [],
    product,
  }));
  t.mock.method(characteristics, 'readCharacteristicConfiguration', async () => ({
    config_hash: 'current-characteristics',
    requires_weight: 1,
    questions: [{ key: 'kind', label: 'Kind', input_type: 'options', required: 1,
      options: [{ value_id: 1 }, { value_id: 2 }] }],
  }));
  t.mock.method(pricing, 'loadPricingContext', async () => ({ categoryCode: 'NM' }));
  t.mock.method(pricing, 'calculatePricing', async (category, answers, weight, calibrated, options) => ({
    weightVal: weight,
    pricePerGram: 1,
    priceMode: 'per_gram_usd',
    usesWeight: true,
    totalPrice: '10.00',
    currencyPayload: {
      uahRate: 41.25,
      uahRateDate: '2026-10-12',
      ...options.rateObservation.metadata,
      calculatedPriceUah: 412.5,
      totalPriceUah: 412.5,
    },
  }));
  t.mock.method(recountEvidence, 'buildRecountEvidence', async () => ({
    signature: 'unchanged-source-evidence',
    binding: { version: 5 },
    names: {},
    delivery: {},
  }));
  const servicePath = require.resolve('../src/services/product.service');
  delete require.cache[servicePath];
  const service = require(servicePath);
  t.after(() => {
    delete require.cache[servicePath];
    assert.deepEqual(product, originalProduct);
  });
  const queryable = {
    async query(sql) {
      assert.match(sql, /^SELECT enabled FROM public_sku_activation/);
      return { rows: [{ enabled: true }] };
    },
  };
  return (metadata) => service.buildProductRecountPreview({
    sourceSku: 'AG-000001',
    answers: { kind: 2 },
    pricingDecision: { mode: 'system_auto' },
  }, { queryable, rateObservation: { metadata } });
}

test('recount exposes live stale-rate metadata without changing decision signatures or prices', async (t) => {
  const preview = fixture(t);
  const fresh = await preview({ uahRateSource: 'nbu', uahRateFetchedAt: '2026-10-12T07:00:00.000Z', uahRateStale: false });
  const stale = await preview({ uahRateSource: 'last_known_good', uahRateFetchedAt: '2026-10-12T08:00:00.000Z', uahRateStale: true });
  assert.equal(stale.corrected.uahRate, 41.25);
  assert.equal(stale.corrected.uahRateDate, '2026-10-12');
  assert.equal(stale.corrected.uahRateSource, 'last_known_good');
  assert.equal(stale.corrected.uahRateFetchedAt, '2026-10-12T08:00:00.000Z');
  assert.equal(stale.corrected.uahRateStale, true);
  assert.equal(stale.corrected.totalPriceUah, fresh.corrected.totalPriceUah);
  assert.equal(stale.corrected.pricingContextFingerprint, fresh.corrected.pricingContextFingerprint);
  assert.equal(stale.previewToken, fresh.previewToken);
  assert.equal(stale.source.stateSignature, fresh.source.stateSignature);
});

test('recount returns explicit nullable rate metadata when presentation evidence is absent', async (t) => {
  const preview = await fixture(t)({});
  assert.equal(preview.corrected.uahRateSource, null);
  assert.equal(preview.corrected.uahRateFetchedAt, null);
  assert.equal(preview.corrected.uahRateStale, false);
});
