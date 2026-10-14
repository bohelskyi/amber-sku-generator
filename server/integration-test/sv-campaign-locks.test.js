'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./sv-campaign-fixture');
const stages = require('../scripts/sv-campaign-stages');
const outbound = require('../scripts/sv-campaign-outbound');

test('SV campaign retains its real PostgreSQL lane through canonical local stages and outbound with max-four pool', { timeout: 90000 }, async t => {
  const f = await setup(t);
  const item = p => ({ sku: p.sku, productId: p.id, remoteProductId: p.remoteId, category: 'SV' });
  async function verifySavedReceipts(p, records) {
    for (const saved of records.filter(row => row.type === 'receipt')) {
      if (saved.stage === 'handoff') await outbound.verifyReceipt(f.runtime, f.config, item(p), f.scope, saved, f.run);
      else await stages.verifyReceipt(f.runtime, f.config, item(p), f.scope, saved, f.run);
    }
  }
  async function execute(p, { stopAfterNames = false, completedStages = new Set() } = {}) {
    const lane = await outbound.acquireLane(f.runtime, f.config, item(p), f.run), records = [];
    assert.equal(lane.status, 'acquired'); let stopped = false;
    const checkpoint = async record => {
      await f.assertLaneHeld(p);
      const competitor = await outbound.acquireLane(f.runtime, f.config, item(p), { ...f.run });
      assert.equal(competitor.status, 'review'); assert.equal(competitor.reason, 'SV_CAMPAIGN_OUTBOUND_BUSY');
      await competitor.release();
      records.push(record);
      if (stopAfterNames && record.type === 'receipt' && record.stage === 'names') stopped = true;
    };
    const hooks = { checkpoint, authority: f.authority, stopping: () => stopped, completedStages };
    try {
      await f.assertLaneHeld(p);
      if (stopAfterNames) {
        await assert.rejects(stages.advance(f.runtime, f.config, item(p), f.scope, f.run, hooks), { code: 'SV_CAMPAIGN_INTERRUPTED' });
        return { records };
      }
      const advanced = await stages.advance(f.runtime, f.config, item(p), f.scope, f.run, hooks);
      assert.equal(advanced.status, 'ready', JSON.stringify({ reason: advanced.reason, statistics: f.statistics,
        checkpoints: records.map(row => row.type + ':' + row.stage) }));
      await f.assertLaneHeld(p);
      const handed = await outbound.handoff(f.runtime, f.config, item(p), f.scope, f.run, hooks);
      assert.ok(['queued', 'already_pending'].includes(handed.status), JSON.stringify(handed));
      await f.assertLaneHeld(p);
      return { records, advanced, handed };
    } finally { await lane.release(); }
  }
  function assertPoolReleased() {
    assert.equal(f.statistics.active, 0); assert.equal(f.db.waitingCount, 0);
    assert.equal(f.statistics.acquired, f.statistics.released);
    assert.ok(f.statistics.peak <= 4); assert.ok(f.statistics.peakWaiting <= 1, JSON.stringify(f.statistics));
    assert.equal(f.statistics.peakSaturatedWaiting, 0, JSON.stringify(f.statistics));
    t.diagnostic('Canonical pool leases: ' + JSON.stringify(f.statistics));
  }
  await t.test('historical singleton follows real history, names and Manager fields without releasing its lane', async () => {
    const p = f.products[0]; f.reset();
    const before = await f.runtime.first.review(f.config, f.request(p), f.run);
    assert.equal(before.historyReviewAssessment?.legacySnapshotFlag, true);
    const result = await execute(p), receiptStages = result.records.filter(row => row.type === 'receipt').map(row => row.stage);
    assert.deepEqual(receiptStages, ['history', 'names', 'fields', 'handoff']);
    await verifySavedReceipts(p, result.records);
    const progress = await f.fields(p);
    assert.ok(progress.historyAdmissionEventId);
    assert.equal(progress.fields.filter(row => row.target === 'name' && row.state === 'name_received').length, 2);
    assert.deepEqual(progress.fields.filter(row => row.source?.decision).map(row => row.target).sort(), ['decor_weight', 'price']);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
    assertPoolReleased();
  });
  await t.test('pristine first-sync AG-prefixed identity imports names and Manager fields without inventing history admission', async () => {
    const p = f.products[2]; f.reset();
    const before = await f.runtime.first.review(f.config, f.request(p), f.run);
    assert.equal(before.mode, 'first', JSON.stringify(before)); assert.equal(await f.fields(p), null);
    const result = await execute(p);
    assert.deepEqual(result.records.filter(row => row.type === 'receipt').map(row => row.stage), ['names', 'fields', 'handoff']);
    await verifySavedReceipts(p, result.records);
    const progress = await f.fields(p);
    assert.equal(progress.historyAdmissionEventId, null);
    assert.equal(progress.fields.filter(row => row.target === 'name' && row.state === 'name_received').length, 2);
    assertPoolReleased();
  });
  await t.test('resumed exact equality uses canonical zero-choice commit and later ordinary handoff', async () => {
    const p = f.products[1]; f.reset();
    const partial = await execute(p, { stopAfterNames: true });
    assert.deepEqual(partial.records.filter(row => row.type === 'receipt').map(row => row.stage), ['history', 'names']);
    assert.equal((await f.fields(p)).session.completed_at, null);
    const remote = f.remotes.get(p.sku); remote.price = 1700;
    remote.custom_attributes.find(row => row.attribute_code === 'decor_weight').value = '5.400';
    const equal = await execute(p, { completedStages: new Set(['history', 'names']) });
    assert.deepEqual(equal.records.filter(row => row.type === 'receipt').map(row => row.stage), ['equal', 'handoff']);
    assert.equal((await f.runtime.first.review(f.config, f.request(p), f.run)).mode, 'ordinary');
    const ordinary = await execute(p);
    assert.deepEqual(ordinary.records.filter(row => row.type === 'receipt').map(row => row.stage), ['handoff']);
    await verifySavedReceipts(p, [...partial.records, ...equal.records, ...ordinary.records]);
    assertPoolReleased();
  });
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every(call => call.method === 'GET'));
});
