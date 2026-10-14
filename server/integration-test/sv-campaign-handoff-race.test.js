'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Client, Pool } = require('pg');
const { setup } = require('./sv-campaign-fixture');
const controlled = require('../src/services/magento/binding-controlled-actions');
const { APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');

test('different controlled handoff commands race on real PostgreSQL and create exactly one outstanding obligation', { timeout: 90000 }, async t => {
  const f = await setup(t), product = f.products[2];
  const commands = await Promise.all(['campaign reviewed handoff', 'manual reviewed handoff'].map(async reason => {
    const request = { bindingRevisionId: f.binding.id, expectedRevision: f.binding.revision,
      kind: 'broader_resync', productIds: [product.id], reason };
    const preview = await controlled.preview(f.config, request, f.options);
    assert.deepEqual(preview.blockers, []);
    return { ...request, previewToken: preview.previewToken };
  }));
  assert.notEqual(commands[0].previewToken, commands[1].previewToken);
  const pools = [0, 1].map(index => new Pool({ connectionString: f.target, max: 1,
    application_name: 'sv-handoff-race-' + index, connectionTimeoutMillis: 5000, statement_timeout: 10000 }));
  const barrier = new Client({ connectionString: f.target, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  let barrierOpen = false, settled;
  try {
    await barrier.connect();
    const pids = await Promise.all(pools.map(async pool => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    await barrier.query('BEGIN'); barrierOpen = true;
    await barrier.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
    // Independent physical sessions both enter the real canonical transaction.
    // Hold its first lock until PostgreSQL confirms that both are contending.
    settled = Promise.allSettled(commands.map((command, index) => controlled.apply(f.config, command, {
      databasePool: pools[index], mutationContext: { actorUserId: f.actor, requestId: randomUUID() },
    })));
    const deadline = Date.now() + 5000; let contenders = 0;
    do {
      contenders = (await barrier.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock' AND wait_event='advisory'", [pids])).rows[0].n;
      if (contenders === 2) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.equal(contenders, 2, 'Both commands must actually contend in PostgreSQL before releasing the barrier');
    await barrier.query('COMMIT'); barrierOpen = false;
    const results = await settled;
    const winner = results.findIndex(result => result.status === 'fulfilled');
    assert.notEqual(winner, -1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const loser = results[1 - winner];
    assert.equal(loser.status, 'rejected');
    assert.equal(loser.reason.code, 'MAGENTO_CONTROLLED_ACTION_STALE');
    assert.ok(loser.reason.details?.blockers?.some(blocker => blocker.code === 'EXISTING_HANDOFF'), JSON.stringify(loser.reason));
    const receipt = results[winner].value;
    assert.equal(receipt.alreadyApplied, false);
    const replay = await controlled.apply(f.config, commands[winner], {
      databasePool: pools[winner], mutationContext: { actorUserId: f.actor, requestId: randomUUID() },
    });
    assert.deepEqual(replay, { handoffId: receipt.handoffId, alreadyApplied: true });
    const rows = (await f.db.query(`SELECT h.id,h.preview_hash,i.state FROM magento_binding_handoffs h
      JOIN magento_binding_handoff_items i ON i.handoff_id=h.id WHERE i.public_product_identity_id=$1`, [product.publicIdentityId])).rows;
    assert.deepEqual(rows, [{ id: receipt.handoffId, preview_hash: commands[winner].previewToken, state: 'pending' }]);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_binding.broader_resync_reviewed' AND subject_id=$1", [receipt.handoffId])).rows[0].n, 1);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
    t.diagnostic('Two independently connected canonical applies contended; one committed, one was stale; one pending item, one audit, idempotent winner replay, zero Magento jobs.');
  } finally {
    if (barrierOpen) await barrier.query('ROLLBACK');
    if (settled) await settled;
    await Promise.all(pools.map(pool => pool.end()));
    await barrier.end();
  }
});
