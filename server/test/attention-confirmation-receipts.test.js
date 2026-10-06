const test = require('node:test');
const assert = require('node:assert/strict');
const { presentStatus } = require('../src/services/magento/automatic-sync-status');
const { previewView } = require('../src/services/magento/integration-readiness');
const { problemDetail } = require('../src/services/magento/sync-problems');

test('local observation timestamps and old receipts cannot be presented as current delivery confirmation', () => {
  const confirmed = '2026-10-04T20:10:00.000Z';
  for (const state of ['pending', 'syncing', 'needs_attention', 'not_tracked']) {
    const view = presentStatus({ state, observed_at: confirmed, updated_at: confirmed, confirmed_at: confirmed });
    assert.equal(Object.hasOwn(view, 'confirmedAt'), false);
  }
  assert.deepEqual(presentStatus({ state: 'synced', updated_at: confirmed }), { state: 'synced', reason: null });
  assert.deepEqual(presentStatus({ state: 'synced', confirmed_at: confirmed }), { state: 'synced', reason: null, confirmedAt: confirmed });
});

test('a read-only identity diagnosis retains confirmed and observed IDs without presenting a write receipt', () => {
  const identity = { article: 'AG-000042', confirmedMagentoId: 41, observedMagentoId: 42, state: 'found' };
  const report = { mode: 'update', generatedAt: '2026-10-04T20:10:00.000Z', sendable: false,
    identity, amberProduct: { id: 42, publicSku: 'AG-000042', group: 'SV' },
    attributeSet: { routeKey: 'SV:stone', selected: { id: 4 } }, candidatePayload: { product: {} },
    transport: null, attributes: [], categories: { currentKnown: true, current: [], requested: [] },
    diff: [], fieldOwnership: [], blockers: [{ code: 'NAME_REMOTE_IDENTITY_CHANGED' }], warnings: [] };
  const view = previewView(report);
  assert.deepEqual(view.identity, identity);
  assert.equal(view.sendable, false);
  assert.equal(Object.hasOwn(view, 'confirmedAt'), false);
  assert.equal(Object.hasOwn(view, 'receipt'), false);
});

test('a pending deletion hides delivery confirmation in the effective attention state', async () => {
  const result = await problemDetail({ configured: false }, 42, { async query() {
    return { rows: [{ productId: 42, article: 'AG-000042', category: 'SV', state: 'synced',
      deletion_state: 'sealed', reason_code: 'TEST_DELETION_PENDING',
      confirmed_at: '2026-10-04T20:10:00.000Z', observed_at: '2026-10-04T20:11:00.000Z' }] };
  } });
  assert.equal(result.state, 'needs_attention');
  assert.equal(Object.hasOwn(result, 'confirmedAt'), false);
  assert.equal(result.problems[0].code, 'TEST_DELETION_PENDING');
});
