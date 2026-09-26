const { test, assert, pool, Pool, TEST_DATABASE_URL } = require('./suite-context');
const f = require('./11-phase2-parity.cases');
const requests = require('../src/services/correction-request.service');
const names = require('../src/services/product-magento-name.service');
const information = require('../src/services/product-information.service');

async function worker() {
  const db = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  return { db, pid: (await db.query('SELECT pg_backend_pid() pid')).rows[0].pid };
}
function gate(db, pattern) {
  let arrived; let release; let once = false;
  const reached = new Promise((r) => { arrived = r; }); const held = new Promise((r) => { release = r; });
  return { reached, release, db: { query: (...args) => db.query(...args), connect: async () => {
    const client = await db.connect();
    return { release: () => client.release(), query: async (...args) => {
      const result = await client.query(...args);
      if (!once && pattern.test(args[0])) { once = true; arrived(); await held; }
      return result;
    } };
  } } };
}
async function reached(g) {
  let timer;
  try { await Promise.race([g.reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gate not reached')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function blocked(pid, by) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) yes', [pid, by])).rows[0].yes) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Backend ${pid} did not block on ${by}`);
}
const settled = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const productLock = /FROM products[\s\S]*FOR UPDATE/;
const lifecycleLock = /SELECT \* FROM product_full_export_state[\s\S]*FOR UPDATE/;
async function race(pattern, first, second, verify) {
  const a = await worker(); const b = await worker(); assert.notEqual(a.pid, b.pid);
  const g = gate(a.db, pattern); let one; let two;
  try {
    one = settled(first(g.db)); await reached(g);
    two = settled(second(b.db)); await blocked(b.pid, a.pid); g.release();
    await verify(...await Promise.all([one, two]));
  } finally { g.release(); await Promise.all([one, two]); await a.db.end(); await b.db.end(); }
}
async function assertSourceOnly(p, r) {
  assert.equal((await f.product(p.id)).status, 'active'); assert.equal((await f.requestRow(r.id)).status, 'in_progress');
  assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 0);
  assert.equal((await f.audits('correction_request.completed', r.id)).length, 0);
  assert.equal((await f.audits('product.recounted', p.id)).length, 0);
}
async function assertSuccess(p, r, id, route) {
  const successor = await f.product(id);
  assert.equal((await f.product(p.id)).corrected_to_product_id, id); assert.equal(successor.corrected_from_product_id, p.id);
  assert.equal((await f.state(p.id)).route, 'retired'); assert.equal((await f.state(id)).route, route);
  assert.deepEqual(f.counters(await f.state(id)), ['1','0','1']);
  assert.equal(successor.exclude_from_export, 1); assert.equal((await f.requestRow(r.id)).status, 'completed');
  assert.equal((await f.audits('correction_request.completed', r.id)).length, 1);
  assert.equal((await f.audits('product.recounted', p.id)).length, 1);
  assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 1);
  assert.equal((await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [id])).rows.length, 0);
}

for (const editFirst of [false, true]) test(`phase2 real race refresh vs information: ${editFirst ? 'information' : 'refresh'} locks first`, async () => {
  await f.setup(); const p = await f.save(); const input = await f.infoInput(p); const r = await f.claimed(p);
  const edit = (db) => information.applyProductInformation(input, f.opts(db)); const refresh = (db) => f.refresh(r, db);
  await race(productLock, editFirst ? edit : refresh, editFirst ? refresh : edit, async (one, two) => {
    const edited = editFirst ? one : two; const refreshed = editFirst ? two : one;
    assert.equal(edited.error?.publicCode, 'ACTIVE_CORRECTION_REQUEST'); assert.ifError(refreshed.error);
    assert.deepEqual(await f.product(p.id), p); assert.deepEqual(f.counters(await f.state(p.id)), ['1','0','1']);
    assert.equal((await f.audits('product_information.updated', p.id)).length, 0);
    assert.equal((await f.requestRow(r.id)).proposed_payload.recountEvidence.lifecycle[0].revision, '1');
    await assertSourceOnly(p, r);
  });
});

for (const editFirst of [false, true]) test(`phase2 real race refresh vs names: ${editFirst ? 'names' : 'refresh'} wins`, async () => {
  await f.setup(); const p = await f.save(); const input = await f.nameInput(p); const r = await f.claimed(p);
  const edit = (db) => names.applyProductMagentoName(input, f.opts(db)); const refresh = (db) => f.refresh(r, db);
  await race(productLock, editFirst ? edit : refresh, editFirst ? refresh : edit, async (one, two) => {
    assert.ifError(one.error); assert.ifError(two.error);
    assert.equal((await f.product(p.id)).magento_name_subject_en, 'New figurine');
    assert.deepEqual(f.counters(await f.state(p.id)), ['2','0','1']);
    assert.equal((await f.audits('product_magento_name.updated', p.id)).length, 1);
    const binding = (await f.requestRow(r.id)).proposed_payload.recountEvidence;
    assert.equal(binding.lifecycle[0].revision, editFirst ? '2' : '1');
    assert.equal(binding.names.en, editFirst ? 'New figurine' : 'Figurine');
    if (editFirst) { const done = await f.complete(r); await assertSuccess(p, r, done.recount.correctedProductId, 'normal'); }
    else { await assert.rejects(f.complete(r), (e) => e.details?.refreshRequired === true); await assertSourceOnly(p, r); }
  });
});

for (const editFirst of [false, true]) test(`phase2 real race completion vs names: ${editFirst ? 'names' : 'completion'} wins`, async () => {
  await f.setup(); const p = await f.save(); const input = await f.nameInput(p); const r = await f.claimed(p);
  const edit = (db) => names.applyProductMagentoName(input, f.opts(db)); const complete = (db) => f.complete(r, db);
  await race(productLock, editFirst ? edit : complete, editFirst ? complete : edit, async (one, two) => {
    assert.ifError(one.error); assert.equal(two.error?.statusCode, 409);
    if (editFirst) {
      await assertSourceOnly(p, r); assert.deepEqual(f.counters(await f.state(p.id)), ['2','0','1']);
      assert.equal((await f.product(p.id)).magento_name_subject_en, 'New figurine');
      assert.equal((await f.audits('product_magento_name.updated', p.id)).length, 1);
    } else {
      await assertSuccess(p, r, one.value.recount.correctedProductId, 'normal');
      assert.equal((await f.product(one.value.recount.correctedProductId)).magento_name_subject_en, 'Figurine');
      assert.equal((await f.audits('product_magento_name.updated', p.id)).length, 0);
    }
  });
});

for (const exportFirst of [false, true]) test(`phase2 real race completion vs snapshot generation: ${exportFirst ? 'capture' : 'completion'} wins`, async () => {
  await f.setup(); const p = await f.save(); const r = await f.claimed(p);
  const capture = (db) => f.capture(p, db); const complete = (db) => f.complete(r, db);
  await race(exportFirst ? /FOR SHARE OF p/ : productLock, exportFirst ? capture : complete, exportFirst ? complete : capture, async (one, two) => {
    assert.ifError(one.error); assert.equal(two.error?.statusCode, 409);
    if (exportFirst) {
      await assertSourceOnly(p, r);
      assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1', [one.value.id])).rows.length, 1);
      assert.deepEqual(f.counters(await f.state(p.id)), ['1','0','1']);
      const updated = (await f.refresh(r)).request; assert.equal(updated.delivery.holdReason, 'prior_exposure');
      const done = await f.complete(updated); await assertSuccess(p, r, done.recount.correctedProductId, 'hold');
    } else {
      await assertSuccess(p, r, one.value.recount.correctedProductId, 'normal');
      assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE product_id=$1', [p.id])).rows.length, 0);
    }
  });
});

for (const exportFirst of [false, true]) test(`phase2 real race completion vs snapshot confirmation: ${exportFirst ? 'confirmation' : 'completion'} wins`, async () => {
  await f.setup(); const p = await f.save(); const s = await f.capture(p); const r = await f.claimed(p);
  const before = (await pool.query('SELECT csv_content FROM magento_export_artifacts WHERE snapshot_id=$1', [s.id])).rows;
  const confirm = (db) => f.confirm(s, db); const complete = (db) => f.complete(r, db);
  await race(lifecycleLock, exportFirst ? confirm : complete, exportFirst ? complete : confirm, async (one, two) => {
    assert.ifError(one.error);
    if (exportFirst) { assert.equal(two.error?.statusCode, 409); await assertSourceOnly(p, r); }
    else { assert.ifError(two.error); await assertSuccess(p, r, one.value.recount.correctedProductId, 'hold'); }
    assert.equal((await f.state(p.id)).confirmed_revision, '1');
    assert.equal((await pool.query('SELECT status FROM export_snapshots WHERE id=$1', [s.id])).rows[0].status, 'confirmed');
    assert.deepEqual((await pool.query('SELECT csv_content FROM magento_export_artifacts WHERE snapshot_id=$1', [s.id])).rows, before);
    assert.equal((await f.audits('export_snapshot.confirmed', s.id)).length, 1);
  });
});

test('phase2 real race release and reclaim invalidate an already-running completion epoch', async () => {
  await f.setup(); const p = await f.save(); const r = await f.claimed(p);
  const a = await worker(); const b = await worker(); const g = gate(a.db, productLock);
  let completion; let reclaim;
  try {
    completion = settled(f.complete(r, g.db)); await reached(g);
    await requests.releaseCorrectionRequest(r.id, r.claimVersion, null, f.opts(b.db));
    // Claim commits first, then its mandatory post-claim refresh waits on source.
    reclaim = settled(requests.claimCorrectionRequest(r.id, f.opts(b.db)));
    await blocked(b.pid, a.pid);
    assert.equal(Number((await f.requestRow(r.id)).claim_version), r.claimVersion + 2);
    g.release(); const [done, reclaimed] = await Promise.all([completion, reclaim]);
    assert.equal(done.error?.statusCode, 409); assert.ifError(reclaimed.error);
    await assertSourceOnly(p, reclaimed.value.request);
    assert.deepEqual(f.counters(await f.state(p.id)), ['1','0','1']);
    const fresh = await f.complete(reclaimed.value.request);
    await assertSuccess(p, reclaimed.value.request, fresh.recount.correctedProductId, 'normal');
  } finally { g.release(); await Promise.all([completion, reclaim]); await a.db.end(); await b.db.end(); }
});

test('phase2 real race completion wins request finalization before release/reclaim', async () => {
  await f.setup(); const p = await f.save(); const r = await f.claimed(p);
  await race(/SELECT id FROM correction_requests[\s\S]*FOR UPDATE/, (db) => f.complete(r, db),
    (db) => requests.releaseCorrectionRequest(r.id, r.claimVersion, null, f.opts(db)), async (one, two) => {
      assert.ifError(one.error); assert.equal(two.error?.statusCode, 409);
      await assertSuccess(p, r, one.value.recount.correctedProductId, 'normal');
      await assert.rejects(requests.claimCorrectionRequest(r.id, f.opts()), (e) => e.statusCode === 409);
      assert.equal((await f.complete(r)).alreadyCompleted, true);
    });
});
