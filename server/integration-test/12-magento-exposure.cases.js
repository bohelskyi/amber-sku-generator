const { test, assert, pool, Pool, TEST_DATABASE_URL, authenticateApplicationSession } = require('./suite-context');
const exposure = require('../src/services/magento/exposure-reconciliation');
const bulk = require('../src/services/magento/exposure-bulk-reconciliation');
const { insertProductFixture } = require('./product-fixture');
const { hash, originHash } = require('../src/services/magento/binding-contract');
const config = { configured: true, baseUrl: 'https://fixture.invalid', consumerKey: 'fake-key', consumerSecret: 'fake-secret',
  accessToken: 'fake-access', accessTokenSecret: 'fake-access-secret' };

test('Magento exact exposure reconciliation preserves ledgers, CAS, audit rollback and real concurrent receipts', async (t) => {
  const admin = await authenticateApplicationSession(); let sequence = 0;
  const get = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    const sku = new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
    return new Response(JSON.stringify({ items: [{ id: 1234, sku }], total_count: 1 }), { headers: { 'content-type': 'application/json' } });
  };
  const options = (databasePool = pool, fetchImpl = get) => ({ databasePool, expectedDatabase: new URL(TEST_DATABASE_URL).pathname.slice(1),
    fetchImpl, mutationContext: { actorUserId: Number(admin.applicationUser.id), requestId: 'exposure-test' } });
  const fixture = async () => {
    const sku = `BR/EXPOSURE-${++sequence}`;
    const row = (await insertProductFixture(pool, `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES ($1,$1,0,'BR',5,1,42,1,42,'{}') RETURNING id`, [sku])).rows[0];
    await pool.query(`UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',
      evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',delivery_version=delivery_version+1 WHERE product_id=$1`, [row.id]);
    return { id: row.id, sku };
  };
  const stored = async (id) => (await pool.query(`SELECT to_jsonb(p) p,to_jsonb(f) f FROM products p
    JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1`, [id])).rows[0];
  const protectedState = async () => {
    const state = {};
    for (const table of ['products','sku_registry','export_state','export_events','export_snapshots','export_snapshot_products',
      'product_export_revisions','price_export_snapshots','magento_sync_jobs','magento_binding_revisions','full_product_export_activation']) {
      state[table] = hash((await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
    }
    return state;
  };
  await t.test('read-only preview, minimal transition, unchanged acknowledgements, idempotent retry and authorization', async () => {
    const f = await fixture(); const before = await stored(f.id); const protectedBefore = await protectedState();
    const plan = await exposure.preview(config, f.sku, options());
    assert.equal(plan.eligible, true, JSON.stringify(plan.blockers)); assert.deepEqual(await stored(f.id), before);
    await assert.rejects(exposure.apply(config, plan, plan.planHash, { ...options(), mutationContext: { actorUserId: 9999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
    const result = await exposure.apply(config, plan, plan.planHash, options());
    assert.equal(result.holdReason, 'prior_exposure'); assert.equal(result.alreadyApplied, false);
    const after = await stored(f.id); assert.deepEqual(after.p, before.p);
    for (const key of ['route','revision','confirmed_revision','cutover_baseline_revision','cutover_baseline_event_id',
      'business_exclusion_state','recount_compatibility_excluded','source_correction_id','repair_manifest_hash']) assert.deepEqual(after.f[key], before.f[key], key);
    assert.equal(after.f.delivery_version, before.f.delivery_version + 1);
    assert.equal(after.f.evidence.origin, 'reconciliation');
    assert.deepEqual(after.f.evidence.priorEvidence, before.f.evidence);
    assert.equal(after.f.evidence.magentoPriorExposure.productId, 1234);
    const repair = await require('../src/services/recount-repair.service').dryRunRepair(pool, options());
    const reviewed = repair.repairEntries.find(e => e.productId === f.id);
    assert.equal(reviewed.action, 'preserve');
    assert.ok(reviewed.reasonCodes.includes('PRESERVE_REVIEWED_LIFECYCLE_DISPOSITION'));
    assert.deepEqual(await protectedState(), protectedBefore);
    assert.equal((await exposure.apply(config, plan, plan.planHash, options(pool, () => assert.fail('completed retry must not GET')))).alreadyApplied, true);
    assert.deepEqual(await stored(f.id), after);
  });
  await t.test('audit failure rolls back state; missing/changed remote and stale product evidence fail closed', async () => {
    const f = await fixture(); const plan = await exposure.preview(config, f.sku, options()); const before = await stored(f.id);
    const failingPool = { connect: async () => { const c = await pool.connect(); return { release: () => c.release(), query: (sql, args) => {
      if (/INSERT INTO audit_events/.test(sql)) throw new Error('audit failed'); return c.query(sql, args);
    } }; } };
    await assert.rejects(exposure.apply(config, plan, plan.planHash, options(failingPool)), /audit failed/);
    assert.deepEqual(await stored(f.id), before);
    const missing = async () => new Response(JSON.stringify({ items: [], total_count: 0 }), { headers: { 'content-type': 'application/json' } });
    assert.equal((await exposure.preview(config, f.sku, options(pool, missing))).eligible, false);
    await assert.rejects(exposure.apply(config, plan, plan.planHash, options(pool, missing)), { code: 'EXPOSURE_REMOTE_CHANGED' });
    const changedId = async () => new Response(JSON.stringify({ items: [{ id: 5678, sku: f.sku }], total_count: 1 }), { headers: { 'content-type': 'application/json' } });
    await assert.rejects(exposure.apply(config, plan, plan.planHash, options(pool, changedId)), { code: 'EXPOSURE_REMOTE_CHANGED' });
    assert.deepEqual(await stored(f.id), before);
    await pool.query('UPDATE products SET weight=weight+1 WHERE id=$1', [f.id]);
    await assert.rejects(exposure.apply(config, plan, plan.planHash, options()), { code: 'EXPOSURE_RECONCILIATION_CONFLICT' });
    assert.equal((await stored(f.id)).f.hold_reason, 'historical_ambiguity');
  });
  await t.test('independent connections contend on real locks; same plan has one mutation and one audit', async () => {
    const f = await fixture(); const plan = await exposure.preview(config, f.sku, options());
    const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }); const b = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const holder = await pool.connect(); const pending = [];
    try {
      const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await holder.query('BEGIN'); await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [f.id]);
      const wait = async pid => { for (let i = 0; i < 600; i++) {
        if ((await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      } assert.fail('writer did not contend'); };
      pending.push(exposure.apply(config, plan, plan.planHash, options(a))); pending[0].catch(() => {}); await wait(apid);
      pending.push(exposure.apply(config, plan, plan.planHash, options(b))); pending[1].catch(() => {}); await wait(bpid);
      await holder.query('COMMIT'); const results = await Promise.all(pending);
      assert.equal(results.filter(r => r.alreadyApplied).length, 1);
      assert.equal((await stored(f.id)).f.delivery_version, Number(plan.deliveryVersion) + 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_prior_exposure_reconciled' AND subject_id=$1", [plan.planHash])).rows[0].n, 1);
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(pending); await a.end(); await b.end(); }
  });
  await t.test('waiting apply rechecks a committed exclusion and leaves it intact without an audit', async () => {
    const f = await fixture(); const plan = await exposure.preview(config, f.sku, options());
    const writer = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const holder = await pool.connect(); let pending;
    try {
      const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [f.id]);
      pending = exposure.apply(config, plan, plan.planHash, options(writer, () => assert.fail('stale state must fail before GET')));
      pending.catch(() => {});
      let blocked = false;
      for (let i = 0; i < 600 && !blocked; i++) {
        blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'writer must contend with independent product transaction');
      await holder.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1", [f.id]);
      await holder.query('COMMIT');
      await assert.rejects(pending, { code: 'EXPOSURE_RECONCILIATION_CONFLICT' });
      const after = await stored(f.id);
      assert.equal(after.f.hold_reason, 'historical_ambiguity');
      assert.equal(after.f.business_exclusion_state, 'excluded');
      assert.equal(after.f.delivery_version, Number(plan.deliveryVersion) + 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_prior_exposure_reconciled' AND subject_id=$1", [plan.planHash])).rows[0].n, 0);
    } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await Promise.allSettled([pending]); await writer.end(); }
  });
  const bulkSource = fixtures => ({ database: options().expectedDatabase, originHash: originHash(config.baseUrl), count: fixtures.length,
    candidates: fixtures.map(f => ({ amberProductId: f.id, sku: f.sku, magentoProductId: f.id })) });
  const bulkGet = fixtures => async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    const sku = new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
    const row = fixtures.find(f => f.sku === sku);
    return new Response(JSON.stringify({ items: row ? [{ id: row.id, sku }] : [], total_count: row ? 1 : 0 }), { headers: { 'content-type': 'application/json' } });
  };
  await t.test('bulk separates successes, skips, conflicts and failures; retry only transitions remaining eligible rows', async () => {
    const fixtures = []; for (let i = 0; i < 6; i++) fixtures.push(await fixture());
    const [a,b,c,d,e,f] = fixtures; const fetchImpl = bulkGet(fixtures);
    await pool.query("UPDATE product_full_export_state SET hold_reason='prior_exposure',delivery_version=delivery_version+1 WHERE product_id=$1", [e.id]);
    const plan = await bulk.preview(config, bulkSource(fixtures), options(pool, fetchImpl));
    assert.deepEqual(plan.summary, { eligible: 5, skipped: 1, conflicted: 0, failed: 0 });
    await pool.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1", [d.id]);
    const before = await protectedState(); const cHash = plan.entries.find(x => x.productId === c.id).plan.planHash;
    const failingPool = { connect: async () => { const client = await pool.connect(); return { release: () => client.release(), query: (sql, args) => {
      if (/INSERT INTO audit_events/.test(sql) && args.includes(cHash)) throw new Error('forced per-product audit failure');
      return client.query(sql, args);
    } }; } };
    const checkpoints = [];
    const first = await bulk.apply(config, plan, plan.planHash, { ...options(failingPool, bulkGet(fixtures.filter(x => x.id !== b.id))),
      checkpoint: async s => checkpoints.push(structuredClone(s)) });
    assert.deepEqual(first.counts, { succeeded: 2, skipped: 1, conflicted: 2, failed: 1, pending: 0 });
    assert.deepEqual(first.ids.succeeded, [a.id,f.id]); assert.deepEqual(first.ids.failed, [c.id]);
    assert.deepEqual(first.ids.conflicted, [b.id,d.id]); assert.equal(checkpoints.length, 7);
    assert.equal((await stored(c.id)).f.hold_reason, 'historical_ambiguity');
    assert.equal((await stored(d.id)).f.business_exclusion_state, 'excluded');
    const fetched = [];
    const retry = await bulk.apply(config, plan, plan.planHash, { ...options(pool, (url, init) => {
      fetched.push(new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]')); return fetchImpl(url,init);
    }), checkpoint: async () => {} });
    assert.deepEqual(retry.counts, { succeeded: 2, skipped: 3, conflicted: 1, failed: 0, pending: 0 });
    assert.deepEqual(fetched, [b.sku,c.sku]);
    assert.deepEqual(await protectedState(), before);
    const fresh = await bulk.preview(config, bulkSource(fixtures), options(pool, fetchImpl));
    assert.equal(fresh.summary.eligible, 0);
  });
  await t.test('bulk survives lost receipt after commit; rerun recovers audit and does not repeat the product GET or mutation', async () => {
    const fixtures = [await fixture(),await fixture()]; const fetchImpl = bulkGet(fixtures);
    const plan = await bulk.preview(config, bulkSource(fixtures), options(pool, fetchImpl)); let checkpoints = 0;
    await assert.rejects(bulk.apply(config, plan, plan.planHash, { ...options(pool, fetchImpl), checkpoint: async () => {
      if (++checkpoints === 2) throw new Error('receipt disk failure after first commit');
    } }), /receipt disk failure/);
    assert.equal((await stored(fixtures[0].id)).f.hold_reason, 'prior_exposure');
    assert.equal((await stored(fixtures[1].id)).f.hold_reason, 'historical_ambiguity');
    const fetched = [];
    const result = await bulk.apply(config, plan, plan.planHash, { ...options(pool, (url, init) => {
      fetched.push(new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]')); return fetchImpl(url,init);
    }), checkpoint: async () => {} });
    assert.deepEqual(result.counts, { succeeded: 1, skipped: 1, conflicted: 0, failed: 0, pending: 0 });
    assert.deepEqual(fetched, [fixtures[1].sku]);
  });
  await t.test('bulk planning detects local drift and remote identity replacement; interruption leaves remaining IDs pending', async () => {
    const fixtures = [await fixture(),await fixture()]; const fetchImpl = bulkGet(fixtures);
    const drift = await bulk.preview(config, bulkSource(fixtures), options(pool, async (url, init) => {
      const sku = new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      if (sku === fixtures[0].sku) await pool.query('UPDATE products SET weight=weight+1 WHERE id=$1', [fixtures[0].id]);
      return fetchImpl(url,init);
    }));
    assert.equal(drift.entries[0].status,'conflicted');
    const changed = bulkSource(fixtures); changed.candidates[0].magentoProductId += 999999;
    const replaced = await bulk.preview(config,changed,options(pool,fetchImpl));
    assert.deepEqual(replaced.entries[0].reasons,['EXPOSURE_CANDIDATE_IDENTITY_CHANGED']);
    const plan = await bulk.preview(config,bulkSource(fixtures),options(pool,fetchImpl)); const controller = new AbortController();
    const result = await bulk.apply(config,plan,plan.planHash,{ ...options(pool,fetchImpl),signal:controller.signal,checkpoint:async r => {
      if(r.counts.succeeded===1) controller.abort();
    } });
    assert.equal(result.complete,false);assert.equal(result.stoppedReason,'EXPOSURE_INTERRUPTED');
    assert.deepEqual(result.ids.pending,[fixtures[1].id]);
    assert.equal((await stored(fixtures[1].id)).f.hold_reason,'historical_ambiguity');
    const interruptGet = new AbortController();
    const aborted = await bulk.apply(config,plan,plan.planHash,{ ...options(pool,async(url,init)=>{
      interruptGet.abort();return fetchImpl(url,init);
    }),signal:interruptGet.signal,checkpoint:async()=>{} });
    assert.equal(aborted.counts.skipped,1);assert.equal(aborted.counts.failed,1);
    assert.equal((await stored(fixtures[1].id)).f.hold_reason,'historical_ambiguity');
  });
  await t.test('concurrent bulk runs use independent connections and real product contention with one audit per product', async () => {
    const fixtures = [await fixture(),await fixture()]; const fetchImpl = bulkGet(fixtures);
    const plan = await bulk.preview(config, bulkSource(fixtures), options(pool, fetchImpl)); const before = await protectedState();
    const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }); const b = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const holder = await pool.connect(); const pending = [];
    try {
      const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid; const bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await holder.query('BEGIN'); await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [fixtures[0].id]);
      const wait = async pid => { for (let i = 0; i < 600; i++) {
        if ((await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      } assert.fail('bulk writer did not contend'); };
      pending.push(bulk.apply(config, plan, plan.planHash, { ...options(a,fetchImpl), checkpoint: async () => {} })); pending[0].catch(() => {}); await wait(apid);
      pending.push(bulk.apply(config, plan, plan.planHash, { ...options(b,fetchImpl), checkpoint: async () => {} })); pending[1].catch(() => {}); await wait(bpid);
      await holder.query('COMMIT'); const results = await Promise.all(pending);
      assert.equal(results.reduce((n,r) => n+r.counts.succeeded,0),2);
      assert.equal(results.reduce((n,r) => n+r.counts.skipped,0),2);
      for (const entry of plan.entries) {
        assert.equal((await stored(entry.productId)).f.delivery_version,Number(entry.plan.deliveryVersion)+1);
        assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_prior_exposure_reconciled' AND subject_id=$1",[entry.plan.planHash])).rows[0].n,1);
      }
      assert.deepEqual(await protectedState(),before);
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(pending); await a.end(); await b.end(); }
  });
});
