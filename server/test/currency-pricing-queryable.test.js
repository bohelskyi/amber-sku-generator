'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const pool = require('../src/db/pool');
const currency = require('../src/services/currency.service');
const contexts = require('../src/services/pricing/pricing-context');
const characteristics = require('../src/services/product/characteristic-config');
const schemas = require('../src/services/sku-schema.service');

const modules = ['pricing.service', 'product/correction-pricing-decision', 'product.service',
  'product-price-change.service', 'repricing/preview-read-model', 'repricing/custom-usd-basis'];
const clearModules = () => modules.forEach(name => { delete require.cache[require.resolve('../src/services/' + name)]; });
const decision = { mode: 'usd_per_gram', usdPerGram: 2, marketingRoundingEnabled: false };
const NOW = new Date('2026-10-13T10:00:00.000Z');

function fixture(t, { native = true, missing = false } = {}) {
  clearModules(); t.after(clearModules);
  const queries = [], calls = [];
  const globalQuery = t.mock.method(pool, 'query', () => assert.fail('A supplied queryable must not use the global pool'));
  const globalConnect = t.mock.method(pool, 'connect', () => assert.fail('A rate read must not acquire another connection'));
  const http = t.mock.method(https, 'request', () => assert.fail('Pricing must not fetch an exchange rate'));
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Pricing must not fetch an exchange rate'));
  const queryable = { async query(sql) {
    assert.match(sql.trim(), /^SELECT\b/); queries.push(sql);
    if (sql.includes('FROM exchange_rate_cache')) return { rows: missing ? [] : [{
      rate: '40.000000', rate_date: '2026-10-13', fetched_at: '2026-10-13T01:00:00.000Z', last_error: null,
    }] };
    if (sql.includes('FROM public_sku_activation')) return { rows: [{ enabled: native }] };
    if (sql.includes('FROM categories')) return { rows: [{ requires_weight: 1, legacy_sku_separator: '', skip_hidden_sku_questions: 0 }] };
    if (sql.includes('FROM questions q') || sql.includes('FROM sku_registry') || sql.includes('FROM products p')
      || sql.includes('FROM correction_requests')) return { rows: [] };
    assert.fail('Unexpected synthetic SQL: ' + sql);
  }, connect: () => assert.fail('Reuse the queryable instead of leasing a client') };
  // Keep the actual SELECT-only reader and force its DB path even under the CI
  // override, while checking each consumer passes the exact transaction client.
  const actualReader = currency.getUsdUahRateInfo;
  t.mock.method(currency, 'getUsdUahRateInfo', async options => {
    calls.push(options); assert.equal(options?.databasePool, queryable);
    return actualReader({ ...options, rateOverride: null, now: () => NOW });
  });
  const scenario = { id: 1, category_code: 'NM', name: 'Fixture', match_json: {}, axis_x_key: null,
    axis_y_key: null, price_mode: 'per_gram_usd', status: 'active', apply_modifiers: false };
  const context = { categoryCode: 'NM', category: { requires_weight: 1, marketing_rounding_enabled: 0 },
    scenarios: [scenario], matrixByCell: new Map([['1:0:0', { price: '2' }]]), weightBandsByScenario: new Map(), modifiers: [] };
  t.mock.method(contexts, 'loadPricingContext', async (_category, client) => { assert.equal(client, queryable); return context; });
  t.mock.method(contexts, 'loadScenarioPricingContext', async (_id, client) => { assert.equal(client, queryable); return { scenario, context }; });
  t.mock.method(contexts, 'loadPricingContexts', async (_categories, client) => { assert.equal(client, queryable); return new Map([['NM', context]]); });
  t.mock.method(characteristics, 'readCharacteristicConfiguration', async client => {
    assert.equal(client, queryable); return { config_hash: 'fixture', requires_weight: 1, questions: [] };
  });
  t.mock.method(schemas, 'getActiveSchema', async (_category, client) => {
    assert.equal(client, queryable); return { id: 1, category_code: 'NM', marker: '', version: 1, status: 'active', config_hash: 'fixture', questions: [] };
  });
  return { queryable, context, calls, queries,
    load: name => require('../src/services/' + name),
    checkReads(expected = 1) {
      assert.equal(calls.length, expected);
      assert.equal(queries.filter(sql => sql.includes('FROM exchange_rate_cache')).length, expected);
      assert.equal(globalQuery.mock.callCount(), 0); assert.equal(globalConnect.mock.callCount(), 0);
      assert.equal(http.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 0);
    } };
}

test('automatic pricing reads its stored rate through the exact supplied transaction queryable', async t => {
  const f = fixture(t);
  const result = await f.load('pricing.service').calculatePricing('NM', {}, 5, 0, { queryable: f.queryable, context: f.context });
  assert.equal(result.currencyPayload.totalPriceUah, 400); assert.equal(result.currencyPayload.uahRate, 40); f.checkReads();
});

test('custom USD pricing reuses its optional fifth queryable without another pool lease', async t => {
  const f = fixture(t);
  const result = await f.load('product/correction-pricing-decision').calculateDecisionPricing(decision, 5, null, undefined, f.queryable);
  assert.equal(result.currencyPayload.totalPriceUah, 400); assert.equal(result.currencyPayload.uahRate, 40); f.checkReads();
});

test('in-place custom USD price change forwards the existing queryable into its rate reader', async t => {
  const f = fixture(t);
  const result = await f.load('product-price-change.service').calculatePriceChange({
    id: 1, category: 'NM', weight: 5, details: {}, total_price_uah: 200,
  }, decision, f.queryable);
  assert.equal(result.totalPriceUah, 400); assert.equal(result.uahRate, 40); f.checkReads();
});

for (const native of [true, false]) test(`${native ? 'native' : 'legacy'} product preview forwards the borrowed queryable for custom USD pricing`, async t => {
  const f = fixture(t, { native });
  const result = await f.load('product.service').buildProductPreview({ categoryCode: 'NM', answers: {}, weight: 5 },
    { queryable: f.queryable, pricingDecision: decision });
  assert.equal(result.totalPriceUah, 400); assert.equal(result.uahRate, 40); f.checkReads();
});

for (const scope of ['scenario', 'global']) test(`${scope} repricing obtains its single stored rate through the supplied queryable`, async t => {
  const f = fixture(t), preview = f.load('repricing/preview-read-model');
  const result = scope === 'scenario' ? await preview.buildRepricingPreview(1, { queryable: f.queryable })
    : await preview.buildGlobalRepricingPreview({ queryable: f.queryable });
  assert.equal(result.currency.rate, 40); assert.equal(result.currency.stale, false); f.checkReads();
});

test('provided quote and captured observation avoid a second read even with a supplied queryable', async t => {
  const f = fixture(t), pricing = f.load('pricing.service'), custom = f.load('product/correction-pricing-decision');
  const quote = { rate: 39, fetchedAt: new Date().toISOString(), rateDate: '2026-10-13', source: 'nbu', stale: false };
  const result = await pricing.calculatePricing('NM', {}, 5, 0, { queryable: f.queryable, context: f.context, rateInfo: quote });
  assert.equal(result.currencyPayload.totalPriceUah, 390);
  const observed = await custom.calculateDecisionPricing(decision, 5, null, { rateInfo: quote }, f.queryable);
  assert.equal(observed.currencyPayload.totalPriceUah, 390); f.checkReads(0);
});

test('a missing stored rate stays unavailable for USD pricing and cannot escape to the global pool', async t => {
  const f = fixture(t, { missing: true });
  await assert.rejects(f.load('product/correction-pricing-decision').calculateDecisionPricing(decision, 5, null, undefined, f.queryable),
    { statusCode: 422 });
  f.checkReads();
});

function clockSkewFixture(t, skewMs) {
  clearModules(); t.after(clearModules);
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const guard = message => () => assert.fail(message);
  const globalQuery = t.mock.method(pool, 'query', guard('Observed pricing must not query the global pool'));
  const globalConnect = t.mock.method(pool, 'connect', guard('Observed pricing must not lease another connection'));
  const http = t.mock.method(https, 'request', guard('Observed pricing must not call NBU'));
  const fetch = t.mock.method(globalThis, 'fetch', guard('Observed pricing must not call HTTP'));
  const dbNow = new Date(NOW.getTime() + skewMs), fetchedAt = new Date(dbNow.getTime() - 100);
  const queries = [];
  const queryable = { async query(sql) {
    assert.match(sql, /^SELECT\b/); assert.match(sql, /clock_timestamp\(\)\s+AS\s+observed_at/i);
    queries.push(sql);
    return { rows: [{ rate: '40.000000', rate_date: currency.getKyivDateString(dbNow),
      fetched_at: fetchedAt, observed_at: dbNow, last_error: null }] };
  } };
  const context = { categoryCode: 'NM', category: { requires_weight: 1, marketing_rounding_enabled: 0 },
    scenarios: [{ id: 1, category_code: 'NM', name: 'Fixture', match_json: {}, axis_x_key: null,
      axis_y_key: null, price_mode: 'per_gram_usd', status: 'active', apply_modifiers: false }],
    matrixByCell: new Map([['1:0:0', { price: '2' }]]), weightBandsByScenario: new Map(), modifiers: [] };
  const pricing = require('../src/services/pricing.service');
  const custom = require('../src/services/product/correction-pricing-decision');
  const repricing = require('../src/services/repricing/custom-usd-basis');
  return { fetchedAt, queries,
    // No mocked provider, injected reader clock or public provenance: the real
    // reader validates the synthetic DB result and hands its own object onward.
    observe: () => currency.observeUsdRate({ databasePool: queryable, rateOverride: null }),
    automatic: observation => pricing.calculatePricing('NM', {}, 5, 0, { queryable, context, rateObservation: observation }),
    custom: observation => custom.calculateDecisionPricing(decision, 5, null, observation, queryable),
    repricing: observation => repricing.buildCustomUsdRepricingItem({ id: 1, full_sku: 'NM1', category: 'NM',
      weight: 5, total_price_uah: 200, price_per_gram: 2, uah_rate: 40 },
    { customUsdPerGramBasis: { usdPerGram: 2, marketingRoundingEnabled: false } }, {}, observation.rateInfo),
    check() {
      assert.equal(queries.length, 1, 'All consumers must retain the single captured observation');
      for (const method of [globalQuery, globalConnect, http, fetch]) assert.equal(method.mock.callCount(), 0);
    } };
}

for (const skewMs of [1000, 60000, -1000, -60000]) {
  test(`actual pricing callers retain a DB-proven observation with DB/app skew ${skewMs}ms`, async t => {
    const f = clockSkewFixture(t, skewMs), observation = await f.observe();
    assert.equal(observation.rateError, null); assert.equal(observation.rateInfo.rate, 40);
    assert.equal(observation.rateInfo.ageMs, 100); assert.equal(observation.rateInfo.stale, false);
    assert.equal(observation.rateInfo.fetchedAt, f.fetchedAt.toISOString());
    const captured = structuredClone(observation);
    for (const caller of ['automatic', 'custom', 'repricing']) await t.test(caller, async () => {
      const result = await f[caller](observation);
      assert.equal(caller === 'repricing' ? result.newPriceUah : result.currencyPayload.totalPriceUah, 400);
      assert.equal(caller === 'repricing' ? result.uahRate : result.currencyPayload.uahRate, 40);
      assert.deepEqual(observation, captured, 'Validation must not change captured values or timestamps');
    });
    f.check();
  });
}

test('copying a DB-proven future-to-app observation cannot transfer its private clock authority', async t => {
  const f = clockSkewFixture(t, 60000), observation = await f.observe();
  assert.equal(observation.rateError, null);
  const copied = structuredClone(observation);
  const automatic = await f.automatic(copied);
  assert.equal(automatic.currencyPayload.totalPriceUah, null);
  assert.ok(automatic.currencyPayload.uahRateError);
  await assert.rejects(f.custom(copied), { statusCode: 422 });
  await assert.rejects(f.repricing(copied), { statusCode: 422 });
  assert.equal((await f.custom(observation)).currencyPayload.totalPriceUah, 400,
    'The original reader-owned rate object must remain usable without a new lookup');
  f.check();
});
