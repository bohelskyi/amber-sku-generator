const suite = require('./suite-context');
const { insertProductFixture } = require('./product-fixture');
const service = require('../src/services/magento/external-delivery-acknowledgement');
const deliveryCutover = require('../src/services/magento/delivery-cutover.service');
const lifecycleGate = require('../src/services/full-product-cutover-gate');
const { advanceFullProductRevision } = require('../src/services/full-product-export.service');
const { hash } = require('../src/services/magento/binding-contract');

const config = { configured: true, baseUrl: 'https://external-delivery.invalid',
  consumerKey: 'fake-key', consumerSecret: 'fake-secret', accessToken: 'fake-access', accessTokenSecret: 'fake-secret' };

suite.test('migration 048 is atomic from checkpoint 047, repeatable and preserves an active lifecycle gate', async () => {
  const { assert, Pool, crypto, fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_external_delivery_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-external-delivery-047-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url,
    `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
      .filter((file) => file.endsWith('.sql') && file < '048')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    await db.query("INSERT INTO categories(code,name) VALUES('ZX','External migration')");
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZX-EXTERNAL','ZX',100) RETURNING id`)).rows[0];
    await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
    const actor = (await db.query("INSERT INTO application_users(status,display_name,activated_at) VALUES('active','Migration 048 actor',CURRENT_TIMESTAMP) RETURNING id")).rows[0];
    const event = async (key) => (await db.query(`INSERT INTO audit_events
      (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Migration 048 actor","preferredUsername":null}'::jsonb,
        'cutover','singleton',$3) RETURNING id`, [key, actor.id, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_maintenance='on'");
    await db.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1 WHERE singleton");
    await db.query(`UPDATE full_product_export_activation SET manifest_hash=$1,approval_event_id=$2,generation=generation+1 WHERE singleton`,
      ['a'.repeat(64), await event('full_product_cutover.approved')]);
    await db.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,activation_event_id=$1,generation=generation+1 WHERE singleton`,
      [await event('full_product_cutover.activated')]);
    await db.query('COMMIT');
    const before = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const migration = '048_external_magento_delivery_acknowledgement.sql';
    const sql = await fs.readFile(path.join(serverRoot, 'migrations', migration), 'utf8');
    await fs.writeFile(path.join(directory, migration), `${sql}\nSELECT 1/0;`);
    await assert.rejects(migrate(), /division by zero/);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, before);
    assert.equal((await db.query(`SELECT count(*)::int count FROM information_schema.columns
      WHERE table_name='product_full_export_state' AND column_name='externally_delivered_revision'`)).rows[0].count, 0);
    await fs.writeFile(path.join(directory, migration), sql); await migrate(); await migrate();
    assert.deepEqual((await db.query(`SELECT externally_delivered_revision,externally_delivered_event_id
      FROM product_full_export_state WHERE product_id=$1`, [product.id])).rows[0],
    { externally_delivered_revision: '0', externally_delivered_event_id: null });
    assert.equal((await db.query('SELECT phase FROM full_product_export_activation WHERE singleton')).rows[0].phase, 'active');
    assert.match((await db.query(`SELECT pg_get_indexdef(indexrelid) definition FROM pg_index
      WHERE indexrelid='product_full_export_state_pending_idx'::regclass`)).rows[0].definition, /externally_delivered_revision/);
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

suite.test('external Magento delivery acknowledgement is exact, audited, fail-closed and creates no delivery side effects', async (t) => {
  const { assert, crypto, pool, TEST_DATABASE_URL, authenticateApplicationSession } = suite;
  const admin = await authenticateApplicationSession(); const actorUserId = Number(admin.applicationUser.id);
  const database = new URL(TEST_DATABASE_URL).pathname.slice(1); let sequence = 0;
  assert.equal((await pool.query(`SELECT count(*)::int count FROM information_schema.columns
    WHERE table_name='product_full_export_state' AND column_name='externally_delivered_revision'`)).rows[0].count, 1,
  'fresh shared schema includes migration 048');

  if ((await pool.query('SELECT phase FROM full_product_export_activation WHERE singleton')).rows[0].phase !== 'active') {
    const event = async (key) => (await pool.query(`INSERT INTO audit_events
      (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      SELECT $1,$2,jsonb_build_object('displayName',display_name,'preferredUsername',preferred_username),
        'cutover','singleton',$3 FROM application_users WHERE id=$2 RETURNING id`,
    [key, actorUserId, crypto.randomUUID()])).rows[0].id;
    await pool.query('BEGIN');
    await pool.query("SET LOCAL amber.lifecycle_maintenance='on'");
    await pool.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1 WHERE singleton");
    await pool.query(`UPDATE full_product_export_activation SET manifest_hash=$1,approval_event_id=$2,generation=generation+1 WHERE singleton`,
      ['b'.repeat(64), await event('full_product_cutover.approved')]);
    await pool.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,activation_event_id=$1,generation=generation+1 WHERE singleton`,
      [await event('full_product_cutover.activated')]);
    await pool.query('COMMIT');
  }

  async function fixture(route = 'normal') {
    const internalSku = `BR-EXTERNAL-${++sequence}`;
    const client = await pool.connect(); let product;
    try {
      await lifecycleGate.begin(client, 'BEGIN');
      product = (await insertProductFixture(client, `INSERT INTO products
        (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
        VALUES($1,$1,0,'BR',5,1,42,1,42,'{}') RETURNING id,full_sku,public_product_identity_id`, [internalSku])).rows[0];
      await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
      if (route !== 'normal') await client.query(`UPDATE product_full_export_state SET route=$2,
        delivery_version=delivery_version+1 WHERE product_id=$1`, [product.id, route]);
      await lifecycleGate.commit(client);
    } finally { await lifecycleGate.release(client); client.release(); }
    const publicSku = (await pool.query('SELECT public_sku FROM public_product_identities WHERE id=$1',
      [product.public_product_identity_id])).rows[0].public_sku;
    return { id: product.id, internalSku, publicSku, magentoProductId: 800000 + product.id };
  }
  const fetchFor = (fixtures, override = {}) => async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    const requested = new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
    if (override[requested]) return override[requested](requested);
    const row = fixtures.find((item) => item.publicSku === requested);
    return new Response(JSON.stringify({ items: row ? [{ id: row.magentoProductId, sku: requested }] : [], total_count: row ? 1 : 0 }),
      { headers: { 'content-type': 'application/json' } });
  };
  const candidate = (row, suffix = row.id) => ({ productId: row.id, internalSku: row.internalSku,
    publicSku: row.publicSku, magentoProductId: row.magentoProductId,
    resolutionKey: `external-delivery-test-${suffix}`, reason: 'Reviewed pre-cutover external Magento delivery',
    evidence: `Exact Magento inventory evidence for product ${row.id}` });
  const source = (rows) => ({ format: service.CANDIDATE_FORMAT, database, entries: rows.map((row) => candidate(row)) });
  const options = (fetchImpl, databasePool = pool) => ({ databasePool, expectedDatabase: database, fetchImpl,
    mutationContext: { actorUserId, requestId: 'external-delivery-integration' }, checkpoint: async () => {} });
  const state = async (id) => (await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [id])).rows[0];
  const mutate = async (operation) => {
    const client = await pool.connect();
    try {
      await lifecycleGate.begin(client, 'BEGIN');
      await operation(client);
      await lifecycleGate.commit(client);
    } catch (cause) { await lifecycleGate.rollback(client); throw cause; }
    finally { await lifecycleGate.release(client); client.release(); }
  };
  const csvPending = async (id) => (await pool.query(`SELECT revision>GREATEST(confirmed_revision,cutover_baseline_revision,
    externally_delivered_revision,csv_retired_revision) pending FROM product_full_export_state WHERE product_id=$1`, [id])).rows[0].pending;
  const protectedEvidence = async (ids) => ({
    snapshots: (await pool.query('SELECT count(*)::int count FROM export_snapshots')).rows[0].count,
    members: (await pool.query('SELECT count(*)::int count FROM export_snapshot_products WHERE product_id=ANY($1::int[])', [ids])).rows[0].count,
    cursor: (await pool.query('SELECT to_jsonb(s) value FROM export_state s')).rows,
    prices: (await pool.query('SELECT to_jsonb(r) value FROM product_export_revisions r WHERE product_id=ANY($1::int[]) ORDER BY product_id', [ids])).rows,
    jobs: (await pool.query('SELECT count(*)::int count FROM magento_sync_jobs WHERE product_id=ANY($1::int[])', [ids])).rows[0].count,
    requests: (await pool.query('SELECT count(*)::int count FROM magento_product_sync_requests WHERE product_id=ANY($1::int[])', [ids])).rows[0].count,
  });

  const normal = await fixture(); const replacement = await fixture('replacement');
  const reviewed = [normal, replacement]; const fetchImpl = fetchFor(reviewed);
  const beforeProtected = await protectedEvidence(reviewed.map((row) => row.id));
  const cutoverInput = { expectedDatabase: database, installationKey: 'external-test', actorUserId,
    origin: config.baseUrl };
  const pendingBefore = (await deliveryCutover.preflight(cutoverInput, { databasePool: pool })).plan.legacy;
  const candidates = source(reviewed);
  delete candidates.entries[0].magentoProductId;
  const plan = await service.preview(config, candidates, options(fetchImpl));
  assert.deepEqual(plan.summary, { eligible: 2, skipped: 0, conflicted: 0, failed: 0 });
  assert.equal(Object.hasOwn(plan.entries[0].candidate, 'magentoProductId'), false);
  assert.equal(plan.entries[0].remote.id, normal.magentoProductId);
  assert.equal(plan.entries[1].candidate.magentoProductId, replacement.magentoProductId);
  service.verify(JSON.parse(JSON.stringify(plan)), plan.planHash, config, database);
  assert.equal((await state(normal.id)).externally_delivered_revision, '0', 'preview is read-only');
  const result = await service.apply(config, plan, plan.planHash, options(fetchImpl));
  assert.deepEqual(result.counts, { succeeded: 2, skipped: 0, conflicted: 0, failed: 0, pending: 0 });
  const normalAfter = await state(normal.id); const replacementAfter = await state(replacement.id);
  assert.equal(normalAfter.externally_delivered_revision, '1'); assert.equal(normalAfter.confirmed_revision, '0');
  assert.equal(normalAfter.cutover_baseline_revision, '0'); assert.equal(normalAfter.csv_retired_revision, '0');
  assert.equal(normalAfter.route, 'normal'); assert.equal(normalAfter.delivery_version, plan.entries[0].state.lifecycle.delivery_version);
  assert.equal(replacementAfter.externally_delivered_revision, '1'); assert.equal(replacementAfter.confirmed_revision, '0');
  assert.equal(replacementAfter.route, 'normal');
  assert.equal(BigInt(replacementAfter.delivery_version), BigInt(plan.entries[1].state.lifecycle.delivery_version) + 1n);
  assert.deepEqual(replacementAfter.evidence, plan.entries[1].state.lifecycle.evidence,
    'replacement acknowledgement preserves lineage evidence');
  assert.equal(await csvPending(normal.id), false); assert.equal(await csvPending(replacement.id), false);
  assert.deepEqual(await protectedEvidence(reviewed.map((row) => row.id)), beforeProtected,
    'acknowledgement creates no snapshot, membership, cursor, price, automatic request or job');
  const events = (await pool.query(`SELECT event_key,subject_id,details FROM audit_events
    WHERE event_key='product.external_delivery_acknowledged' AND subject_id=ANY($1::text[]) ORDER BY subject_id`,
  [reviewed.map((row) => String(row.id))])).rows;
  assert.equal(events.length, 2); assert.ok(events.every((event) => event.details.externalDeliverySemantic === true
    && event.details.snapshotConfirmationClaimed === false && event.details.payloadEqualityClaimed === false));
  const pendingAfter = (await deliveryCutover.preflight(cutoverInput, { databasePool: pool })).plan.legacy;
  assert.equal(pendingBefore.pendingNormal + pendingBefore.pendingReplacement
    - pendingAfter.pendingNormal - pendingAfter.pendingReplacement, 2,
  'delivery cutover preflight consumes the explicit external floor');

  await t.test('a later pre-cutover full revision becomes pending again', async () => {
    const later = await fixture(); const remote = fetchFor([later]);
    const laterPlan = await service.preview(config, source([later]), options(remote));
    const acknowledged = await service.apply(config, laterPlan, laterPlan.planHash, options(remote));
    assert.equal(acknowledged.counts.succeeded, 1); assert.equal(await csvPending(later.id), false);
    await mutate(async (client) => {
      await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [later.id]);
      await advanceFullProductRevision(client, later.id, '1');
    });
    const laterState = await state(later.id);
    assert.equal(laterState.revision, '2'); assert.equal(laterState.externally_delivered_revision, '1');
    assert.equal(await csvPending(later.id), true);
  });

  await t.test('same key retries idempotently and changed reuse conflicts', async () => {
    const fetched = [];
    const retry = await service.apply(config, plan, plan.planHash, options(async (url) => {
      fetched.push(url); throw new Error('completed retry must not GET');
    }));
    assert.equal(retry.counts.skipped, 2); assert.deepEqual(fetched, []);
    const changed = structuredClone(plan); changed.entries = [changed.entries[0]];
    changed.entries[0].candidate.reason = 'Changed attempted reuse';
    const approved = { candidate: changed.entries[0].candidate,
      beforeFingerprint: changed.entries[0].beforeFingerprint, state: changed.entries[0].state,
      remote: changed.entries[0].remote };
    changed.entries[0].entryHash = hash(approved); changed.summary = { eligible: 1, skipped: 0, conflicted: 0, failed: 0 };
    delete changed.planHash; changed.planHash = hash(changed);
    const conflict = await service.apply(config, changed, changed.planHash, options(fetchImpl));
    assert.equal(conflict.counts.conflicted, 1);
    assert.deepEqual(conflict.outcomes[0].reasons, ['EXTERNAL_DELIVERY_KEY_CONFLICT']);
  });

  await t.test('remote mismatch, missing, ambiguous, held, excluded and identity conflict stay ineligible', async () => {
    const wrong = await fixture(); const missing = await fixture(); const ambiguous = await fixture();
    const held = await fixture(); const excluded = await fixture(); const identity = await fixture(); const other = await fixture();
    await mutate(async (client) => {
      await client.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',delivery_version=delivery_version+1 WHERE product_id=$1", [held.id]);
      await client.query("UPDATE products SET exclude_from_export=1 WHERE id=$1", [excluded.id]);
      await client.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1", [excluded.id]);
    });
    await pool.query('UPDATE sku_registry SET first_product_id=$2 WHERE full_sku=$1', [identity.internalSku, other.id]);
    const rows = [wrong, missing, ambiguous, held, excluded, identity];
    const candidateSource = source(rows); candidateSource.entries[0].magentoProductId += 999999;
    const remote = fetchFor(rows, {
      [missing.publicSku]: () => new Response(JSON.stringify({ items: [], total_count: 0 }), { headers: { 'content-type': 'application/json' } }),
      [ambiguous.publicSku]: (requested) => new Response(JSON.stringify({ items: [
        { id: ambiguous.magentoProductId, sku: requested }, { id: ambiguous.magentoProductId + 1, sku: requested }], total_count: 2 }),
      { headers: { 'content-type': 'application/json' } }),
    });
    const blocked = await service.preview(config, candidateSource, options(remote));
    assert.equal(blocked.summary.eligible, 0); assert.equal(blocked.summary.skipped, rows.length);
    assert.ok(blocked.entries[0].reasons.includes('MAGENTO_IDENTITY_MISMATCH'));
    assert.ok(blocked.entries[1].reasons.includes('MAGENTO_PRODUCT_NOT_FOUND'));
    assert.ok(blocked.entries[2].reasons.includes('MAGENTO_PRODUCT_AMBIGUOUS'));
    assert.ok(blocked.entries[3].reasons.includes('ROUTE_NOT_ACKNOWLEDGEABLE'));
    assert.ok(blocked.entries[4].reasons.includes('PRODUCT_EXCLUDED_OR_HELD'));
    assert.ok(blocked.entries[5].reasons.includes('PRODUCT_IDENTITY_CONFLICT'));
    await pool.query('UPDATE sku_registry SET first_product_id=$2 WHERE full_sku=$1', [identity.internalSku, identity.id]);
  });

  await t.test('stale delivery state and audit failure roll back without remote or lifecycle credit', async () => {
    const stale = await fixture(); const rollback = await fixture(); const rows = [stale, rollback]; const remote = fetchFor(rows);
    const stalePlan = await service.preview(config, source([stale]), options(remote));
    await mutate((client) => client.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1', [stale.id]));
    const staleFetches = [];
    const staleResult = await service.apply(config, stalePlan, stalePlan.planHash, options(async (url) => {
      staleFetches.push(url); return remote(url, { method: 'GET' });
    }));
    assert.equal(staleResult.counts.conflicted, 1); assert.deepEqual(staleFetches, []);
    const rollbackPlan = await service.preview(config, source([rollback]), options(remote));
    const before = await state(rollback.id);
    const failingPool = { connect: async () => { const client = await pool.connect(); return { release: () => client.release(),
      query: (sql, args) => { if (/INSERT INTO audit_events/.test(sql)) throw new Error('forced audit failure'); return client.query(sql, args); } }; } };
    const failed = await service.apply(config, rollbackPlan, rollbackPlan.planHash, options(remote, failingPool));
    assert.equal(failed.counts.failed, 1); assert.deepEqual(await state(rollback.id), before);
  });

  await t.test('a later API-era mutation is requested automatically and never revives CSV delivery', async () => {
    const auditEvent = async (key, subjectType) => (await pool.query(`INSERT INTO audit_events
      (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      SELECT $1,$2,jsonb_build_object('displayName',display_name,'preferredUsername',preferred_username),
        $3,'singleton',$4 FROM application_users WHERE id=$2 RETURNING id`,
    [key, actorUserId, subjectType, crypto.randomUUID()])).rows[0].id;
    await pool.query('BEGIN');
    await pool.query("SET LOCAL amber.public_sku_activation='on'");
    await pool.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
      activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`,
    [actorUserId, await auditEvent('public_sku.activated', 'public_sku_activation')]);
    await pool.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await pool.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='external-test',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`,
    [actorUserId, await auditEvent('magento_delivery.cutover', 'magento_delivery')]);
    await pool.query('COMMIT');
    const client = await pool.connect();
    try {
      await lifecycleGate.begin(client, 'BEGIN');
      await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [normal.id]);
      await client.query("UPDATE products SET magento_name_subject_ua='API era mutation',magento_name_subject_en='API era mutation' WHERE id=$1", [normal.id]);
      await advanceFullProductRevision(client, normal.id, '1');
      await lifecycleGate.commit(client);
    } finally { await lifecycleGate.release(client); client.release(); }
    const after = await state(normal.id);
    assert.equal(after.revision, '2'); assert.equal(after.externally_delivered_revision, '1');
    assert.equal(after.csv_retired_revision, '2'); assert.equal(await csvPending(normal.id), false);
    assert.equal((await pool.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1', [normal.id])).rows[0].desired_generation, '1');
    assert.equal((await pool.query('SELECT count(*)::int count FROM magento_sync_jobs WHERE product_id=$1', [normal.id])).rows[0].count, 0);
    // Repeat the name regression after the real permanent activation boundary:
    // names and unresolved conflicts follow the same public identity.
    await require('./11-full-product-lifecycle.cases').assertRecountExactNames();
  });
});
