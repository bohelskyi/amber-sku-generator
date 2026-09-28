const test = require('node:test');
const assert = require('node:assert/strict');
const { blockers, observe, apply } = require('../src/services/magento/exposure-reconciliation');
const { parseArguments } = require('../scripts/magento-reconcile-exposure');
const state = () => ({ product: { id: 7, status: 'active', exclude_from_export: 0 },
  lifecycle: { route: 'hold', hold_reason: 'historical_ambiguity', business_exclusion_state: 'none', evidence: {} },
  reservation: { first_product_id: 7 }, gate: { phase: 'legacy' } });
const config = { configured: true, baseUrl: 'https://fixture.invalid', consumerKey: 'fake-key', consumerSecret: 'fake-secret',
  accessToken: 'fake-access', accessTokenSecret: 'fake-access-secret' };
test('exposure reconciliation refuses exclusions, correction lineage, noncurrent states and reservation conflicts', () => {
  assert.deepEqual(blockers(state()), []);
  for (const change of [s => { s.product.status = 'archived'; }, s => { s.product.corrected_from_product_id = 3; },
    s => { s.product.corrected_to_product_id = 8; }, s => { s.correction = true; }, s => { s.linked = true; },
    s => { s.active_request = true; }, s => { s.lifecycle.source_correction_id = 1; },
    s => { s.lifecycle.business_exclusion_state = 'unknown'; }, s => { s.lifecycle.business_exclusion_state = 'excluded'; },
    s => { s.product.exclude_from_export = 1; }, s => { s.lifecycle.recount_compatibility_excluded = true; },
    s => { s.lifecycle.evidence.independentExclusion = true; }, s => { s.lifecycle.evidence.exclusionProvenance = 'unknown'; },
    s => { s.lifecycle.hold_reason = 'intentional_exclusion'; }, s => { s.lifecycle.route = 'normal'; },
    s => { s.reservation.first_product_id = 3; }, s => { s.gate.phase = 'preparing'; }]) {
    const s = state(); change(s); assert.ok(blockers(s).length);
  }
});
test('remote evidence uses exact query GET and distinguishes absent, malformed and errors without leaking bodies', async () => {
  for (const [items, count, expected] of [[[{ id: 19, sku: 'BR/EXACT' }], 1, 'found'], [[], 0, 'not_found'],
    [[{ id: 19, sku: 'OTHER' }], 1, 'lookup_error'], [[{ id: 0, sku: 'BR/EXACT' }], 1, 'lookup_error']]) {
    const result = await observe(config, 'BR/EXACT', { fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), 'BR/EXACT');
      return new Response(JSON.stringify({ items, total_count: count }), { headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(result.status, expected);
  }
});
test('CLI defaults to preview, requires explicit single-product apply evidence and rejects bulk/implicit apply', () => {
  const base = ['--expected-database', 'amber', '--output', 'new.json'];
  assert.equal(parseArguments([...base, '--sku', 'BR/EXACT']).apply, undefined);
  assert.equal(parseArguments([...base, '--apply', '--plan', 'review.json', '--expected-hash', 'a'.repeat(64), '--actor-user-id', '1']).apply, true);
  for (const args of [[...base, '--apply'], [...base, '--sku', 'A', '--apply'], [...base, '--group', 'BR'],
    [...base, '--sku', 'A', '--plan', 'review.json'], [...base, '--sku', 'A', '--sku', 'B']]) assert.throws(() => parseArguments(args));
});
test('apply rejects fabricated preview before opening a transaction', async () => {
  await assert.rejects(apply(config, {}, 'a'.repeat(64), { expectedDatabase: 'amber', databasePool: {
    connect() { assert.fail('invalid evidence must not open transaction'); },
  } }));
});
