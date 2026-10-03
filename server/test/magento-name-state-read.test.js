const test = require('node:test');
const assert = require('node:assert/strict');
const { readNameState, readNameStates, nameStateEvidence } = require('../src/services/magento/name-state');

function database(states = [], jobs = []) {
  const calls = [];
  return { calls, query: async (sql, args) => {
    assert.match(sql, /^SELECT/);
    assert.equal(args[0], 'fixture-origin'); calls.push({ sql, args });
    const ids = (Array.isArray(args[1]) ? args[1] : [args[1]]).map(String);
    if (sql.includes('FROM magento_name_sync_states')) return { rows: states.filter(s => ids.includes(String(s.public_product_identity_id))) };
    assert.match(sql, /FROM magento_sync_jobs/);
    return { rows: jobs.filter(j => ids.includes(String(j.public_product_identity_id))) };
  } };
}
const job = (id, name = 'Confirmed') => ({ public_product_identity_id: String(id), remote_product_id: '1919',
  intent: { operations: [{ domain: 'coreProduct', payload: { product: { name } } }], englishValues: { name: 'Confirmed EN' } } });

test('single and batched name reads share exact acknowledged intent evidence without writing observations', async () => {
  const db = database([], [job(1), job(2, 'Second')]);
  const single = await readNameState(db, 'fixture-origin', 1, { lock: true });
  const batch = await readNameStates(db, 'fixture-origin', [1, 2]);
  assert.deepEqual(nameStateEvidence(batch[0]), nameStateEvidence(single));
  assert.deepEqual(single, { baseline_names: { all: 'Confirmed', en: 'Confirmed EN' }, remote_product_id: '1919', version: '0' });
  assert.equal(batch[1].baseline_names.all, 'Second');
  assert.match(db.calls[0].sql, /FOR SHARE$/);
  assert.equal(db.calls.length, 4, 'one observation and one fallback query per read, independent of batch size');
  for (const call of db.calls.filter(c => c.sql.includes('FROM magento_sync_jobs'))) {
    assert.match(call.sql, /state='succeeded'/); assert.match(call.sql, /acknowledged_at IS NOT NULL/);
    assert.match(call.sql, /remote_product_id IS NOT NULL/);
    assert.match(call.sql, /ORDER BY public_product_identity_id,acknowledged_at DESC,created_at DESC/);
  }
});

test('observed conflict or missing baseline remains authoritative over historical succeeded jobs', async () => {
  const observed = { public_product_identity_id: '1', baseline_names: null, state: 'conflict', version: '7', remote_product_id: 2000 };
  const db = database([observed], [job(1), job(2)]);
  assert.deepEqual(await readNameState(db, 'fixture-origin', 1), observed);
  const batch = await readNameStates(db, 'fixture-origin', [1, 2]);
  assert.deepEqual(batch[0], observed); assert.equal(batch[1].version, '0');
  assert.deepEqual(db.calls.at(-1).args[1], [2], 'fallback is restricted to identities without observation rows');
});

test('absent confirmed evidence and latest acknowledged intent without a base name supply no baseline', async () => {
  const latest = job(1); latest.intent = {};
  const db = database([], [latest]);
  assert.equal(await readNameState(db, 'fixture-origin', 1), null);
  assert.deepEqual(await readNameStates(db, 'fixture-origin', [1, 2]), []);
  assert.match(db.calls.at(-1).sql, /DISTINCT ON \(public_product_identity_id\)/, 'latest job is selected before inspecting names');
  const empty = database(); assert.deepEqual(await readNameStates(empty, 'fixture-origin', []), []);
  assert.equal(empty.calls.length, 0);
});
