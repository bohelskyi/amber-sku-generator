const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLiveUsdRate } = require('../src/services/currency.service');

test('background NBU transport requests the explicit Kyiv date and propagates cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const rate = await fetchLiveUsdRate({ date: '2026-10-13', signal: controller.signal, rateOverride: null,
    fetchJsonImpl: async (url, options) => {
      calls++;
      const target = new URL(url);
      assert.equal(target.origin, 'https://bank.gov.ua');
      assert.equal(target.searchParams.get('valcode'), 'USD');
      assert.equal(target.searchParams.get('date'), '20261013');
      assert.equal(target.searchParams.has('json'), true);
      assert.equal(options.signal, controller.signal);
      return [{ cc: 'USD', rate: 41.25, exchangedate: '13.10.2026' }];
    } });
  assert.equal(calls, 1);
  assert.equal(rate.rate, 41.25); assert.equal(rate.rateDate, '2026-10-13');
  assert.ok(Number.isFinite(new Date(rate.fetchedAt).getTime()));
});

test('background transport rejects wrong currency, ambiguous payload, malformed and future quote dates', async () => {
  const usd = { cc: 'USD', rate: 41.25, exchangedate: '13.10.2026' };
  for (const payload of [null, [], [usd, usd], [{ ...usd, cc: 'EUR' }], [{ ...usd, rate: 0 }],
    [{ ...usd, rate: 'Infinity' }], [{ ...usd, exchangedate: '31.09.2026' }],
    [{ ...usd, exchangedate: '14.10.2026' }], [{ rate: 41.25 }]]) {
    await assert.rejects(fetchLiveUsdRate({ date: '2026-10-13', rateOverride: null,
      fetchJsonImpl: async () => payload }), { code: 'ERR_INVALID_RATE' });
  }
  for (const date of ['2026-02-30', '13.10.2026']) {
    await assert.rejects(fetchLiveUsdRate({ date, rateOverride: null,
      fetchJsonImpl: () => assert.fail('Invalid date must never reach HTTP') }), { code: 'ERR_INVALID_RATE' });
  }
});

test('an unchanged official weekend quote keeps its real effective date', async () => {
  const rate = await fetchLiveUsdRate({ date: '2026-10-11', rateOverride: null,
    fetchJsonImpl: async () => [{ cc: 'USD', rate: 41.25, exchangedate: '09.10.2026' }] });
  assert.equal(rate.rateDate, '2026-10-09');
});
