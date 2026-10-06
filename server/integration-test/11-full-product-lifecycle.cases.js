const { test, assert, pool, Pool, TEST_DATABASE_URL, crypto, authenticateApplicationSession } = require('./suite-context');
const products = require('../src/services/product.service');
const exportsService = require('../src/services/export.service');
const full = require('../src/services/full-product-export.service');
const prices = require('../src/services/product-price-change.service');
const { installSouvenirFixture } = require('./11-export-recount-exclusion.cases');
let actor;
const opts = (databasePool = pool) => ({ databasePool, mutationContext: {
  actorUserId: actor.applicationUser.id, requestId: 'phase-1-lifecycle' } });
const answers = { material: 2, color: 3, souvenir: 1, statuette: 5, weight: 1260, size: '23/6/30' };
const names = { magento_name_subject_ua: 'Фігура', magento_name_subject_en: 'Figurine' };
async function setup() {
  actor = await authenticateApplicationSession();
  const gate = require('../src/services/full-product-cutover-gate'); const client = await pool.connect();
  try {
    await gate.begin(client, 'BEGIN');
    await installSouvenirFixture(client, { ensureSchemas: false });
    await gate.commit(client);
  } catch (error) { await gate.rollback(client); throw error; }
  finally { await gate.release(client); client.release(); }
  await require('../src/services/sku-schema.service').ensureLegacySkuSchemas();
}
async function save() {
  const preview = await products.buildNewProductPreview({ categoryCode: 'SV', answers, weight: 1260, ...names });
  const saved = await products.saveProduct({ category: 'SV', answers, weight: 1260, manualPriceUah: 21700, ...names,
    skuSchemaVersionId: preview.skuSchemaVersionId, characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken }, opts());
  return (await pool.query('SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1', [saved.id])).rows[0];
}
async function recountInput(p, patch = { size: '24/6/30' }) {
  const input = { sourceSku: p.full_sku || p.public_sku, answers: patch, manualPriceUah: 21700, reason: 'Phase 1 fixture' };
  if (patch.weight !== undefined) input.weight = patch.weight;
  const preview = await products.buildProductRecountPreview(input);
  return { ...input, sourceStateSignature: preview.source.stateSignature };
}
const range = (p) => ({ fromSku: p.full_sku, toSku: p.full_sku });
const create = (p, options = opts(), extra = {}) => exportsService.createExportSnapshot({ ...range(p), idempotencyKey: crypto.randomUUID(), ...extra }, options);
const state = async (id) => (await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [id])).rows[0];
const auditCount = async (eventKey, id) => (await pool.query('SELECT count(*)::int n FROM audit_events WHERE event_key=$1 AND subject_id=$2', [eventKey, String(id)])).rows[0].n;
const cursor = async () => Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);
const artifactBytes = async (id) => (await pool.query('SELECT group_code,csv_content FROM magento_export_artifacts WHERE snapshot_id=$1 ORDER BY group_code', [id])).rows;
async function assertCapturedState(p, snap, bytes, confirmed) {
  const snapshot = (await pool.query('SELECT * FROM export_snapshots WHERE id=$1', [snap.id])).rows[0];
  assert.equal(snapshot.status, confirmed ? 'confirmed' : 'generated');
  assert.equal(snapshot.csv_content, snap.csv_content);
  assert.equal(snapshot.created_by_user_id, String(actor.applicationUser.id));
  if (confirmed) assert.equal(snapshot.confirmed_by_user_id, String(actor.applicationUser.id));
  const members = (await pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1', [snap.id])).rows;
  assert.equal(members.length, 1); assert.equal(members[0].product_id, p.id);
  assert.equal(members[0].sku_at_capture, p.full_sku); assert.equal(members[0].full_revision, '1');
  assert.equal(members[0].delivery_version, '1'); assert.equal(members[0].capture_kind, 'full_product');
  assert.deepEqual(await artifactBytes(snap.id), bytes);
  assert.deepEqual((await pool.query('SELECT revision,confirmed_revision,has_product_snapshot FROM product_export_revisions WHERE product_id=$1', [p.id])).rows,
    [{ revision: '0', confirmed_revision: '0', has_product_snapshot: true }]);
  assert.equal(await auditCount('export_snapshot.created', snap.id), 1);
  assert.equal(await auditCount('export_snapshot.confirmed', snap.id), confirmed ? 1 : 0);
}
async function footprint() {
  const result = {};
  for (const table of ['products','sku_registry','product_corrections','product_full_export_state','export_snapshot_products',
    'export_snapshots','magento_export_artifacts','product_export_revisions','export_state','audit_events']) {
    result[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}
async function failInsert(table, work) {
  assert.ok(['product_full_export_state','export_snapshot_products','magento_export_artifacts'].includes(table));
  await pool.query(`CREATE FUNCTION phase1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase1 injected failure'; END $$;
    CREATE TRIGGER phase1_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION phase1_fail()`);
  try { await work(); } finally { await pool.query(`DROP TRIGGER phase1_fail ON ${table}; DROP FUNCTION phase1_fail()`); }
}
async function advance(p) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
    await full.advanceFullProductRevision(client, p.id, '1'); await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
}

test('full lifecycle ordinary save and recount commit independent pending obligations, names and lineage atomically', async () => {
  await setup(); const p = await save();
  assert.equal((await pool.query('SELECT * FROM sku_registry WHERE full_sku=$1', [p.full_sku])).rows.length, 1);
  assert.equal(await auditCount('product.created', p.id), 1);
  assert.deepEqual([(await state(p.id)).revision, (await state(p.id)).confirmed_revision, (await state(p.id)).route], ['1','0','normal']);
  const result = await products.applyProductRecount(await recountInput(p), opts());
  const successor = (await pool.query('SELECT * FROM products WHERE id=$1', [result.correctedProductId])).rows[0];
  assert.equal((await state(p.id)).route, 'retired');
  assert.equal((await state(successor.id)).route, 'normal');
  assert.equal((await state(successor.id)).confirmed_revision, '0');
  assert.equal(successor.exclude_from_export, 1);
  assert.deepEqual([successor.magento_name_subject_ua, successor.magento_name_subject_en, successor.magento_name_review_required], ['Фігура','Figurine',false]);
  assert.equal(await auditCount('product.recounted', p.id), 1);
  const second = await products.applyProductRecount(await recountInput(successor, { size: '25/6/30' }), opts());
  assert.equal((await state(second.correctedProductId)).route, 'normal');
  assert.deepEqual((await state(second.correctedProductId)).evidence.ancestorProductIds, [p.id, successor.id]);
});

test('full lifecycle failures roll back ordinary save and entire recount including reservations and audit', async () => {
  await setup(); const p = await save(); const input = await recountInput(p);
  const preview = await products.buildNewProductPreview({ categoryCode: 'SV', answers, weight: 1260, ...names });
  const before = await footprint();
  await failInsert('product_full_export_state', async () => {
    await assert.rejects(products.saveProduct({ category: 'SV', answers, weight: 1260, manualPriceUah: 21700, ...names,
      skuSchemaVersionId: preview.skuSchemaVersionId, characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken }, opts()), /phase1 injected failure/);
    await assert.rejects(products.applyProductRecount(input, opts()), /phase1 injected failure/);
  });
  assert.deepEqual(await footprint(), before);
});

test('full lifecycle inherits name subjects without review and stale or missing source evidence refreshes', async () => {
  await setup(); const p = await save(); const stale = await recountInput(p);
  await pool.query("UPDATE products SET magento_name_subject_en='Updated figurine' WHERE id=$1", [p.id]);
  await assert.rejects(products.applyProductRecount(stale, opts()), /назви змінилися/);
  await assert.rejects(products.applyProductRecount({ ...stale, sourceStateSignature: undefined }, opts()), /Оновіть preview/);
  const unknown = await recountInput(p, { weight: 1261 });
  const changed = await products.applyProductRecount(unknown, opts());
  const row = (await pool.query('SELECT * FROM products WHERE id=$1', [changed.correctedProductId])).rows[0];
  assert.equal(row.magento_name_subject_en, 'Updated figurine');
  assert.equal(row.magento_name_review_required, false);
  const semanticSource = await save();
  const semantic = await products.applyProductRecount(await recountInput(semanticSource, { symbolic_stat: 1 }), opts());
  const semanticRow = (await pool.query('SELECT * FROM products WHERE id=$1', [semantic.correctedProductId])).rows[0];
  assert.equal(semanticRow.details.answers.symbolic_stat, 1);
  assert.equal(semanticRow.magento_name_review_required, false);
  assert.equal(semantic.corrected.nameInheritance.reviewRequired, false);
});

async function assertRecountExactNames() {
  await setup();
  const activation = (await pool.query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0];
  const config = { configured: true, baseUrl: 'https://recount-names.example.invalid' };
  const nameService = require('../src/services/magento/product-names.service');
  const nameState = require('../src/services/magento/name-state');
  const origin = require('../src/services/magento/binding-contract').originHash(config.baseUrl);
  const previewOptions = { magentoConfig: config };
  const applyOptions = { ...opts(), magentoConfig: config, authorizedNameChange: true };
  const previewFor = (p, nameChange) => products.buildProductRecountPreview({ sourceSku: p.full_sku || p.public_sku,
    answers: { symbolic_stat: 1 }, manualPriceUah: 21700, ...(nameChange ? { nameChange } : {}) }, previewOptions);
  const apply = (p, preview, nameChange) => products.applyProductRecount({ sourceSku: p.full_sku || p.public_sku,
    answers: { symbolic_stat: 1 }, manualPriceUah: 21700, sourceStateSignature: preview.source.stateSignature,
    ...(nameChange ? { nameChange } : {}) }, applyOptions);
  const source = await save(); const original = (await nameService.read(source.id, { config })).names;
  const baseline = { ...original };
  await nameState.saveObservation(pool, origin, source, 5794, { action: 'confirm', amber: original, remote: original }, baseline);
  const inherited = await previewFor(source); assert.equal(inherited.nameChanges, null);
  const successor = await apply(source, inherited);
  if (activation.enabled) assert.equal(successor.corrected.publicSku,
    (await pool.query('SELECT public_sku FROM public_product_identities WHERE id=$1', [source.public_product_identity_id])).rows[0].public_sku);
  assert.deepEqual((await nameService.read(successor.correctedProductId, { config })).names, original);
  const row = (await pool.query('SELECT * FROM products WHERE id=$1', [successor.correctedProductId])).rows[0];
  assert.deepEqual([row.magento_name_subject_ua, row.magento_name_subject_en, row.magento_name_review_required], ['Фігура', 'Figurine', false]);
  const editedSource = await save(); const editedOriginal = (await nameService.read(editedSource.id, { config })).names;
  await nameState.saveObservation(pool, origin, editedSource, 5795, { action: 'confirm', amber: editedOriginal, remote: editedOriginal }, editedOriginal);
  const edited = { all: 'Довільна точна назва українською', en: 'Exact arbitrary English name' };
  const reviewed = await previewFor(editedSource, edited);
  assert.deepEqual(reviewed.nameChanges, { from: editedOriginal, to: edited });
  const before = await footprint();
  await pool.query('UPDATE magento_name_sync_states SET version=version+1 WHERE public_product_identity_id=$1', [editedSource.public_product_identity_id]);
  await assert.rejects(apply(editedSource, reviewed, edited), /назви|назв|preview/);
  assert.deepEqual(await footprint(), before, 'stale names leave the entire recount untouched');
  const fresh = await previewFor(editedSource, edited);
  let raced = false;
  const racingPool = { connect: async () => {
    const connection = await pool.connect(); const query = connection.query.bind(connection); const release = connection.release.bind(connection);
    connection.query = async (sql, values) => {
      if (!raced && sql.includes('FOR UPDATE') && sql.includes('p.full_sku')) {
        raced = true;
        await pool.query('UPDATE magento_name_sync_states SET version=version+1 WHERE public_product_identity_id=$1', [editedSource.public_product_identity_id]);
      }
      return query(sql, values);
    };
    connection.release = () => { connection.query = query; connection.release = release; release(); };
    return connection;
  } };
  const raceBefore = await footprint();
  await assert.rejects(products.applyProductRecount({ sourceSku: editedSource.full_sku || editedSource.public_sku, answers: { symbolic_stat: 1 }, manualPriceUah: 21700,
    nameChange: edited, sourceStateSignature: fresh.source.stateSignature }, { ...applyOptions, databasePool: racingPool }), /назв|назви|preview/);
  assert.equal(raced, true); assert.deepEqual(await footprint(), raceBefore);
  const reviewedAgain = await previewFor(editedSource, edited);
  const changed = await apply(editedSource, reviewedAgain, edited);
  assert.deepEqual((await nameService.read(changed.correctedProductId, { config })).names, edited);
  const changedRow = (await pool.query('SELECT * FROM products WHERE id=$1', [changed.correctedProductId])).rows[0];
  assert.deepEqual(changedRow.magento_name_override.values, edited);
  assert.deepEqual([changedRow.magento_name_subject_ua, changedRow.magento_name_subject_en, changedRow.magento_name_review_required], ['Фігура', 'Figurine', false]);
  assert.deepEqual((await pool.query('SELECT baseline_names FROM magento_name_sync_states WHERE public_product_identity_id=$1', [editedSource.public_product_identity_id])).rows[0].baseline_names, editedOriginal);
  const conflicting = await save(); const conflictOriginal = (await nameService.read(conflicting.id, { config })).names;
  await nameState.saveObservation(pool, origin, conflicting, 5796,
    { action: 'conflict', amber: conflictOriginal, remote: { ...conflictOriginal, all: 'Remote conflict' } }, conflictOriginal);
  assert.equal((await nameService.read(conflicting.id, { config })).nameConflict, true);
  await assert.rejects(previewFor(conflicting, edited), { code: 'RECOUNT_NAME_CONFLICT' });
  const safe = await previewFor(conflicting); const conflictSuccessor = await apply(conflicting, safe);
  if (activation.enabled) assert.equal((await nameService.read(conflictSuccessor.correctedProductId, { config })).nameConflict, true);
  assert.equal((await pool.query('SELECT state FROM magento_name_sync_states WHERE public_product_identity_id=$1', [conflicting.public_product_identity_id])).rows[0].state, 'conflict');
}
test('full lifecycle recount exact names inherit, change atomically, reject shared-state drift and preserve conflicts', assertRecountExactNames);
module.exports = { assertRecountExactNames };

test('full lifecycle successor holds preserve generated/confirmed ancestors, historical ambiguity and independent exclusion', async () => {
  await setup();
  for (const reason of ['generated','confirmed','historical','excluded']) {
    const p = await save();
    if (reason === 'generated' || reason === 'confirmed') {
      const snapshot = await create(p);
      if (reason === 'confirmed') await exportsService.confirmExportSnapshot(snapshot.id, opts());
    } else if (reason === 'historical') {
      await pool.query(`UPDATE product_full_export_state SET route='hold', hold_reason='historical_ambiguity',
        evidence='{"origin":"migration_039"}', delivery_version=delivery_version+1 WHERE product_id=$1`, [p.id]);
    } else await pool.query('UPDATE products SET exclude_from_export=1 WHERE id=$1', [p.id]);
    const result = await products.applyProductRecount(await recountInput(p), opts());
    const expected = { generated: 'prior_exposure', confirmed: 'prior_exposure', historical: 'historical_ambiguity', excluded: 'intentional_exclusion' }[reason];
    assert.equal((await state(result.correctedProductId)).hold_reason, expected);
    const successor = (await pool.query('SELECT * FROM products WHERE id=$1', [result.correctedProductId])).rows[0];
    const second = await products.applyProductRecount(await recountInput(successor, { size: 'next' }), opts());
    assert.equal((await state(second.correctedProductId)).hold_reason, expected);
  }
});

test('full lifecycle snapshot membership is exact, immutable, atomic and one per Main/EN product', async () => {
  await setup(); const p = await save();
  const before = await footprint();
  for (const table of ['export_snapshot_products','magento_export_artifacts']) {
    await failInsert(table, () => assert.rejects(create(p), /phase1 injected failure/));
    assert.deepEqual(await footprint(), before);
  }
  const preview = await exportsService.previewExport(range(p), opts());
  const snapshot = await create(p, opts(), { previewExpectation: preview.previewExpectation });
  assert.equal(snapshot.full_product_lifecycle_version, 1);
  const members = (await pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1', [snapshot.id])).rows;
  assert.equal(members.length, 1); assert.equal(members[0].sku_at_capture, p.full_sku);
  assert.equal(members[0].full_revision, '1'); assert.equal(members[0].delivery_version, '1');
  assert.equal(members[0].capture_kind, 'full_product'); assert.equal(members[0].evidence_origin, 'live_capture');
  assert.equal((await pool.query('SELECT row_count FROM magento_export_artifacts WHERE snapshot_id=$1', [snapshot.id])).rows[0].row_count, 2);
  for (const sql of ['UPDATE export_snapshot_products SET full_revision=2 WHERE snapshot_id=$1',
    'DELETE FROM export_snapshot_products WHERE snapshot_id=$1']) await assert.rejects(pool.query(sql, [snapshot.id]), /immutable/);
  await assert.rejects(pool.query('TRUNCATE export_snapshot_products'), /immutable/);
  await assert.rejects(pool.query('UPDATE export_snapshots SET full_product_lifecycle_version=NULL WHERE id=$1', [snapshot.id]), /immutable/);
  await advance(p);
  await assert.rejects(create(p, opts(), { previewExpectation: preview.previewExpectation }), (e) => e.code === 'EXPORT_PREVIEW_STALE');
  const retry = await exportsService.createExportSnapshot({ ...range(p), idempotencyKey: snapshot.idempotency_key,
    previewExpectation: preview.previewExpectation }, opts());
  assert.equal(retry.csv_content, snapshot.csv_content); assert.equal(retry.id, snapshot.id);
});

test('full lifecycle confirmation acknowledges only captured revisions; price stream, history and compatibility stay independent', async () => {
  await setup(); const p = await save(); const old = await create(p);
  await advance(p);
  const newer = await create(p);
  const decision = { mode: 'manual_uah', manualPriceUah: 22000, marketingRoundingEnabled: false };
  const pricePreview = await prices.previewProductPriceChange({ productId: p.id, pricingDecision: decision });
  await prices.applyProductPriceChange({ productId: p.id, pricingDecision: decision, previewToken: pricePreview.previewToken }, opts());
  await exportsService.confirmExportSnapshot(old.id, opts());
  assert.equal((await state(p.id)).revision, '2'); assert.equal((await state(p.id)).confirmed_revision, '1');
  await exportsService.confirmExportSnapshot(newer.id, opts());
  await exportsService.confirmExportSnapshot(old.id, opts());
  assert.equal((await state(p.id)).confirmed_revision, '2');
  assert.equal(await auditCount('export_snapshot.confirmed', old.id), 1);
  assert.deepEqual((await pool.query('SELECT revision,confirmed_revision FROM product_export_revisions WHERE product_id=$1', [p.id])).rows,
    [{ revision: '1', confirmed_revision: '0' }]);
  const p2 = await save(); const internal = await create(p2, opts(), { profile: 'internal-legacy' });
  await exportsService.confirmExportSnapshot(internal.id, opts());
  assert.equal((await state(p2.id)).confirmed_revision, '0');
  assert.equal((await pool.query('SELECT capture_kind,full_revision FROM export_snapshot_products WHERE snapshot_id=$1', [internal.id])).rows[0].capture_kind, 'legacy_compatibility');
  const historical = crypto.randomUUID();
  await pool.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content)
    VALUES($1,$1,$2,$2,$3,1,'historical.csv',$4)`, [historical, p2.full_sku, p2.id, `sku,price_uah,size\n${p2.full_sku},21700,`]);
  await exportsService.confirmExportSnapshot(historical, opts());
  assert.equal((await state(p2.id)).confirmed_revision, '0');
  assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1', [historical])).rows.length, 0);
  const outOfOrder = await save(); const firstFile = await create(outOfOrder);
  await advance(outOfOrder); const secondFile = await create(outOfOrder);
  await exportsService.confirmExportSnapshot(secondFile.id, opts());
  await exportsService.confirmExportSnapshot(firstFile.id, opts());
  assert.equal((await state(outOfOrder.id)).confirmed_revision, '2');
  assert.equal(await auditCount('export_snapshot.confirmed', firstFile.id), 1);
  assert.equal(await auditCount('export_snapshot.confirmed', secondFile.id), 1);
  const successor = await products.applyProductRecount(await recountInput(p), opts());
  await exportsService.confirmExportSnapshot(old.id, opts());
  assert.equal((await state(successor.correctedProductId)).confirmed_revision, '0');
  assert.equal((await state(successor.correctedProductId)).hold_reason, 'prior_exposure');
  assert.equal((await pool.query('SELECT csv_content FROM export_snapshots WHERE id=$1', [old.id])).rows[0].csv_content, old.csv_content);
});

// Each operation owns a distinct PostgreSQL connection. A query gate pauses the
// winner after acquiring its real locks; pg_blocking_pids proves actual overlap.
async function worker() {
  const db = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  return { db, pid: (await db.query('SELECT pg_backend_pid() pid')).rows[0].pid };
}
function gate(db, pattern) {
  let arrived; let release; let once = false;
  const reached = new Promise((r) => { arrived = r; });
  const held = new Promise((r) => { release = r; });
  return { reached, release, db: { query: (...args) => db.query(...args), connect: async () => {
    const client = await db.connect();
    return { release: () => client.release(), query: async (...args) => {
      const result = await client.query(...args);
      if (!once && pattern.test(args[0])) { once = true; arrived(); await held; }
      return result;
    } };
  } } };
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
async function reached(g) {
  let timer;
  try { await Promise.race([g.reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gate not reached')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function assertRecountResult(p, id, route) {
  const pair = (await pool.query('SELECT * FROM products WHERE id=ANY($1::int[]) ORDER BY id', [[p.id,id]])).rows;
  assert.equal(pair[0].corrected_to_product_id, id); assert.equal(pair[0].status, 'corrected');
  assert.equal(pair[1].corrected_from_product_id, p.id); assert.equal(pair[1].exclude_from_export, 1);
  assert.equal((await state(p.id)).route, 'retired'); assert.equal((await state(id)).route, route);
  assert.equal((await state(id)).confirmed_revision, '0'); assert.equal((await state(id)).revision, '1');
  assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 1);
  assert.equal(await auditCount('product.recounted', p.id), 1);
  assert.equal((await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [id])).rows.length, 0);
  assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE product_id=$1', [id])).rows.length, 0);
  assert.equal((await pool.query('SELECT * FROM sku_registry WHERE full_sku=ANY($1::text[])', [[p.full_sku,pair[1].full_sku]])).rows.length, 2);
}
for (const captureWins of [true, false]) test(`full lifecycle real race recount vs capture: ${captureWins ? 'capture' : 'recount'} wins`, async () => {
  await setup(); const p = await save(); const input = await recountInput(p);
  const beforeCursor = await cursor();
  const preview = await exportsService.previewExport(range(p), opts());
  const a = await worker(); const b = await worker(); assert.notEqual(a.pid, b.pid);
  const g = gate(a.db, captureWins ? /FOR SHARE OF p/ : /FROM products[\s\S]*FOR UPDATE/);
  let first; let second;
  try {
    first = settled(captureWins ? create(p, opts(g.db)) : products.applyProductRecount(input, opts(g.db)));
    await reached(g);
    second = settled(captureWins ? products.applyProductRecount(input, opts(b.db)) : create(p, opts(b.db)));
    await blocked(b.pid, a.pid); g.release();
    const [one, two] = await Promise.all([first, second]); assert.ifError(one.error);
    // Phase 2 binds the reviewed exposure: a capture winner requires refresh,
    // rather than silently applying a different successor delivery outcome.
    const recount = captureWins ? two : one;
    if (captureWins) {
      assert.equal(recount.error?.publicCode, 'RECOUNT_REFRESH_REQUIRED');
      assert.equal((await state(p.id)).route, 'normal');
      assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 0);
      recount.value = await products.applyProductRecount(await recountInput(p), opts());
    } else assert.ifError(recount.error);
    await assertRecountResult(p, recount.value.correctedProductId, captureWins ? 'hold' : 'normal');
    assert.equal(await cursor(), beforeCursor);
    if (captureWins) {
      const snap = one.value;
      assert.equal((await state(p.id)).confirmed_revision, '0');
      await assertCapturedState(p, snap, preview.artifacts.map((a) => ({ group_code: a.groupCode, csv_content: a.csvContent })), false);
    } else {
      assert.equal(two.error?.code, 'EXPORT_PREVIEW_STALE');
      assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE product_id=$1', [p.id])).rows.length, 0);
      assert.equal((await pool.query('SELECT * FROM export_snapshots WHERE from_sku=$1', [p.full_sku])).rows.length, 0);
      assert.equal((await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [p.id])).rows.length, 0);
    }
  } finally { g.release(); await Promise.all([first, second]); await a.db.end(); await b.db.end(); }
});

for (const confirmWins of [true, false]) test(`full lifecycle real race recount vs confirmation: ${confirmWins ? 'confirmation' : 'recount'} wins`, async () => {
  await setup(); const p = await save(); const snap = await create(p); const input = await recountInput(p);
  const bytes = await artifactBytes(snap.id);
  const a = await worker(); const b = await worker();
  const g = gate(a.db, /SELECT \* FROM product_full_export_state[\s\S]*FOR UPDATE/);
  let first; let second;
  try {
    first = settled(confirmWins ? exportsService.confirmExportSnapshot(snap.id, opts(g.db)) : products.applyProductRecount(input, opts(g.db)));
    await reached(g);
    second = settled(confirmWins ? products.applyProductRecount(input, opts(b.db)) : exportsService.confirmExportSnapshot(snap.id, opts(b.db)));
    await blocked(b.pid, a.pid); g.release();
    const [one, two] = await Promise.all([first, second]); assert.ifError(one.error);
    if (confirmWins) {
      assert.equal(two.error?.publicCode, 'RECOUNT_REFRESH_REQUIRED');
      assert.equal((await state(p.id)).route, 'normal');
      assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 0);
      two.value = await products.applyProductRecount(await recountInput(p), opts());
    } else assert.ifError(two.error);
    await assertRecountResult(p, (confirmWins ? two : one).value.correctedProductId, 'hold');
    assert.equal((await state(p.id)).confirmed_revision, '1');
    await assertCapturedState(p, snap, bytes, true);
    assert.equal(await cursor(), p.id);
  } finally { g.release(); await Promise.all([first, second]); await a.db.end(); await b.db.end(); }
});

for (const firstIndex of [0, 1]) test(`full lifecycle real race duplicate recount: worker ${firstIndex + 1} wins`, async () => {
  await setup(); const p = await save(); const input = await recountInput(p);
  const beforeCursor = await cursor();
  const workers = [await worker(), await worker()]; const a = workers[firstIndex]; const b = workers[1-firstIndex];
  const g = gate(a.db, /FROM products[\s\S]*FOR UPDATE/); let first; let second;
  try {
    first = settled(products.applyProductRecount(input, opts(g.db))); await reached(g);
    second = settled(products.applyProductRecount(input, opts(b.db))); await blocked(b.pid, a.pid); g.release();
    const [one,two] = await Promise.all([first,second]); assert.ifError(one.error); assert.equal(two.error?.statusCode, 409);
    await assertRecountResult(p, one.value.correctedProductId, 'normal');
    assert.equal(await cursor(), beforeCursor);
    assert.equal((await pool.query('SELECT * FROM export_snapshots WHERE from_sku=$1', [p.full_sku])).rows.length, 0);
    assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE product_id=$1', [p.id])).rows.length, 0);
    assert.equal((await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [p.id])).rows.length, 0);
  } finally { g.release(); await Promise.all([first, second]); await a.db.end(); await b.db.end(); }
});

for (const confirmWins of [true, false]) test(`full lifecycle real race confirmation vs later full revision: ${confirmWins ? 'confirmation' : 'revision'} wins`, async () => {
  await setup(); const p = await save(); const snap = await create(p);
  const bytes = await artifactBytes(snap.id);
  const a = await worker(); const b = await worker(); const g = gate(a.db, /SELECT \* FROM product_full_export_state[\s\S]*FOR UPDATE/);
  const update = async (db) => {
    const client = await db.connect();
    try { await client.query('BEGIN'); await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      await full.advanceFullProductRevision(client, p.id, '1'); await client.query('COMMIT'); }
    finally { await client.query('ROLLBACK'); client.release(); }
  };
  let first; let second;
  try {
    first = settled(confirmWins ? exportsService.confirmExportSnapshot(snap.id, opts(g.db)) : update(g.db)); await reached(g);
    second = settled(confirmWins ? update(b.db) : exportsService.confirmExportSnapshot(snap.id, opts(b.db)));
    await blocked(b.pid,a.pid); g.release();
    const [one,two] = await Promise.all([first,second]); assert.ifError(one.error); assert.ifError(two.error);
    assert.equal((await state(p.id)).revision, '2'); assert.equal((await state(p.id)).confirmed_revision, '1');
    assert.equal((await state(p.id)).route, 'normal');
    assert.deepEqual((await pool.query('SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1', [p.id])).rows[0], p);
    assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 0);
    await assertCapturedState(p, snap, bytes, true);
    assert.equal(await cursor(), p.id);
  } finally { g.release(); await Promise.all([first, second]); await a.db.end(); await b.db.end(); }
});

 test('acceptance direct recount accepts normalized supported pricing choices with stale binding and atomic revalidation', async () => {
  await setup();
  for (const pricingDecision of [{ mode: 'manual_uah', manualPriceUah: 1200 },
    { mode: 'usd_per_gram', usdPerGram: 2, marketingRoundingEnabled: false }]) {
    const p = await save(); const input = { sourceSku: p.full_sku || p.public_sku, answers: { size: 'changed' }, pricingDecision };
    const preview = await products.buildProductRecountPreview(input);
    const payload = { ...input, sourceStateSignature: preview.source.stateSignature, previewToken: preview.previewToken };
    await assert.rejects(products.applyProductRecount(payload, opts()), { statusCode: 403 });
    await assert.rejects(products.applyProductRecount({ ...payload, pricingDecision: { mode: 'manual_uah', manualPriceUah: 1 } },
      { ...opts(), authorizedDirectDecision: true }), { publicCode: 'RECOUNT_PREVIEW_STALE' });
    const applied = await products.applyProductRecount(payload, { ...opts(), authorizedDirectDecision: true });
    const successor = (await pool.query('SELECT * FROM products WHERE id=$1', [applied.correctedProductId])).rows[0];
    assert.equal(Number(successor.total_price_uah), Number(preview.corrected.totalPriceUah));
    assert.equal(successor.magento_name_review_required, false);
    if (pricingDecision.mode === 'manual_uah') assert.equal(successor.details.manualPriceUah, 1200);
    else assert.deepEqual(successor.details.customUsdPerGramBasis, { usdPerGram: 2, marketingRoundingEnabled: false });
  }
  const p = await save();
  await assert.rejects(products.applyProductRecount({ sourceSku: p.full_sku || p.public_sku, answers: { size: 'changed' },
    pricingDecision: { mode: 'manual_uah', manualPriceUah: -1 } }, { ...opts(), authorizedDirectDecision: true }), { statusCode: 422 });
});
