const suite = require('./suite-context');
const { insertProductFixture } = require('./product-fixture');
const repair = require('../src/services/legacy-sku-repair.service');
const exportsService = require('../src/services/export.service');
const fullSelection = require('../src/services/full-product-selection');
const publicSkuActivation = require('../src/services/public-sku-activation.service');
const deliveryCutover = require('../src/services/magento/delivery-cutover.service');
const { readPreviewProduct } = require('../src/services/magento/sync-preview-db');
const { syncEligibility } = require('../src/services/magento/sync-eligibility');
const contract = require('../src/services/magento/binding-contract');
const productQueries = require('../src/services/product/product-queries');

async function copyMigrationsBefore046(directory) {
  const { fs, path, serverRoot } = suite;
  for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
    .filter((name) => name.endsWith('.sql') && name < '046')) {
    await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
  }
}

async function copyMigration(directory, name) {
  const { fs, path, serverRoot } = suite;
  await fs.copyFile(path.join(serverRoot, 'migrations', name), path.join(directory, name));
}

function migrationRunner(url, directory) {
  return suite.runNodeInDatabase(url,
    `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
}

async function createActor(db) {
  const actor = (await db.query(`INSERT INTO application_users(status,display_name,activated_at)
    VALUES('active','Legacy SKU repair operator',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
  await db.query(`INSERT INTO user_role_assignments(application_user_id,role_id)
    SELECT $1,id FROM roles WHERE role_key='administrator' AND is_system=TRUE`, [actor.id]);
  return Number(actor.id);
}

async function audit(db, actorId, eventKey) {
  return Number((await db.query(`INSERT INTO audit_events
    (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
    VALUES($1,$2,'{"displayName":"Legacy SKU repair operator","preferredUsername":null}'::jsonb,
      'cutover','singleton',$3) RETURNING id`, [eventKey, actorId, suite.crypto.randomUUID()])).rows[0].id);
}

async function publishPublicBinding(db, actorId, installationKey, origin) {
  const templateId = suite.crypto.randomUUID();
  const versionId = suite.crypto.randomUUID();
  const bindingId = suite.crypto.randomUUID();
  const definition = { formatVersion: 1, evaluatorVersion: 'magento-declarative-3',
    outputContract: 'magento-products-v1', sourceContractVersion: 'public-product-identity-v1' };
  const definitionHash = contract.hash(definition);
  await db.query(`INSERT INTO export_templates(id,template_key,display_name,created_by_user_id)
    VALUES($1,$2,'Legacy repair public binding',$3)`, [templateId, `repair-${templateId}`, actorId]);
  await db.query(`INSERT INTO export_template_drafts(template_id,definition,modified_by_user_id)
    VALUES($1,$2::jsonb,$3)`, [templateId, JSON.stringify(definition), actorId]);
  await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,
      definition_hash,format_version,evaluator_version,output_contract,published_by_user_id)
    VALUES($1,$2,1,1,$3::jsonb,$4,1,'magento-declarative-3','magento-products-v1',$5)`,
  [versionId, templateId, JSON.stringify(definition), definitionHash, actorId]);
  await db.query(`INSERT INTO magento_binding_revisions(id,installation_key,origin_hash,template_id,template_version_id,
      template_definition_hash,evaluator_version,output_contract,format_version,schema_fingerprint,topology_fingerprint,
      observed_at,observation_store_code,created_by_user_id,modified_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,'magento-declarative-3','magento-products-v1',1,$7,$7,CURRENT_TIMESTAMP,'all',$8,$8)`,
  [bindingId, installationKey, contract.originHash(origin), templateId, versionId, definitionHash, '0'.repeat(64), actorId]);
  await db.query(`UPDATE magento_binding_revisions SET state='published',revision=2,version_number=1,
    published_by_user_id=$2,published_at=CURRENT_TIMESTAMP,modified_by_user_id=$2,modified_at=CURRENT_TIMESTAMP WHERE id=$1`,
  [bindingId, actorId]);
  return bindingId;
}

async function activateLifecycle(db, actorId) {
  await db.query(`UPDATE product_full_export_state SET business_exclusion_state='none',
    delivery_version=delivery_version+1 WHERE route<>'retired'`);
  const approval = await audit(db, actorId, 'full_product_cutover.approved');
  const activation = await audit(db, actorId, 'full_product_cutover.activated');
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL amber.lifecycle_maintenance='on'");
    await db.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1 WHERE singleton");
    await db.query(`UPDATE full_product_export_activation SET manifest_hash=$1,approval_event_id=$2,
      generation=generation+1 WHERE singleton`, ['b'.repeat(64), approval]);
    await db.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,
      activation_event_id=$1,generation=generation+1 WHERE singleton`, [activation]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

async function insertProduct(db, sku, { weight = 5, price = 100, answers = { kind: 1 } } = {}) {
  return (await insertProductFixture(db, `INSERT INTO products
    (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,details)
    VALUES($1,$1,0,'ZZ',$2,$3,$3,$4::jsonb) RETURNING id`,
  [sku, weight, price, JSON.stringify({ answers })])).rows[0];
}

async function insertDuplicate(db, sourceId) {
  return (await insertProductFixture(db, `INSERT INTO products
    (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,
      price_per_gram,uah_rate,details,status,exclude_from_export,corrected_from_product_id,
      corrected_to_product_id,correction_reason,sku_schema_version_id,created_by_user_id,
      archived_by_user_id,magento_name_subject_ua,magento_name_subject_en,magento_name_review_required)
    SELECT full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,
      price_per_gram,uah_rate,details,status,exclude_from_export,corrected_from_product_id,
      corrected_to_product_id,correction_reason,sku_schema_version_id,created_by_user_id,
      archived_by_user_id,magento_name_subject_ua,magento_name_subject_en,magento_name_review_required
    FROM products WHERE id=$1 RETURNING id`, [sourceId])).rows[0];
}

async function withSkuTriggerDisabled(db, operation) {
  await db.query('ALTER TABLE products DISABLE TRIGGER products_reserve_sku');
  try { return await operation(); }
  finally { await db.query('ALTER TABLE products ENABLE TRIGGER products_reserve_sku'); }
}

async function setup045(name) {
  const { Pool, fs, os, path, recreateTestDatabase } = suite;
  const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-legacy-sku-repair-045-'));
  await copyMigrationsBefore046(directory);
  await migrationRunner(url, directory);
  const db = new Pool({ connectionString: url });
  await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Legacy collision fixtures')");
  const actorId = await createActor(db);
  return { url, directory, db, actorId };
}

async function cleanup(fixture) {
  await fixture.db.end();
  await suite.fs.rm(fixture.directory, { recursive: true, force: true });
  await suite.dropTestDatabase(fixture.name);
}

async function stageSplitThrough046(name) {
  const fixture = await setup045(name);
  fixture.name = name;
  const keeper = await insertProduct(fixture.db, 'ZZ-GATE-COLLISION');
  const target = await withSkuTriggerDisabled(fixture.db, () => insertProduct(fixture.db, 'ZZ-GATE-COLLISION',
    { weight: 8, price: 444, answers: { kind: 2 } }));
  await activateLifecycle(fixture.db, fixture.actorId);
  const decisions = { version: 1, groups: [{ sku: 'ZZ-GATE-COLLISION', action: 'split_public_identity',
    keeperProductId: Number(keeper.id), splitProductIds: [Number(target.id)], reason: 'Reviewed separate product' }] };
  const artifact = await repair.preflight({ expectedDatabase: name, actorUserId: fixture.actorId,
    decisions }, { databasePool: fixture.db });
  suite.assert.deepEqual(artifact.blockers, []);
  await repair.stage({ expectedDatabase: name, actorUserId: fixture.actorId, plan: artifact.plan,
    planHash: artifact.planHash }, { databasePool: fixture.db,
    mutationContext: { actorUserId: fixture.actorId } });
  await copyMigration(fixture.directory, '046_stable_public_product_sku.sql');
  await migrationRunner(fixture.url, fixture.directory);
  return { ...fixture, keeper, target, artifact };
}

suite.test('migration 047 cannot be recorded before migration 046', async () => {
  const { assert } = suite;
  const fixture = await setup045('amber_legacy_sku_repair_order_test');
  fixture.name = 'amber_legacy_sku_repair_order_test';
  try {
    await copyMigration(fixture.directory, '047_finalize_legacy_sku_repair.sql');
    await assert.rejects(migrationRunner(fixture.url, fixture.directory), /requires migration 046/);
    assert.equal((await fixture.db.query(`SELECT count(*)::int AS count FROM schema_migrations
      WHERE name='047_finalize_legacy_sku_repair.sql'`)).rows[0].count, 0);
    assert.equal((await fixture.db.query("SELECT to_regclass('public_product_identities') AS relation")).rows[0].relation, null);
  } finally { await cleanup(fixture); }
});

suite.test('legacy SKU repair stages mixed explicit decisions and 047 restores the same split row', async () => {
  const { assert } = suite;
  const fixture = await setup045('amber_legacy_sku_repair_mixed_test');
  fixture.name = 'amber_legacy_sku_repair_mixed_test';
  const { db, actorId, directory, url } = fixture;
  try {
    const duplicateKeeper = await insertProduct(db, 'ZZ-DUPLICATE');
    const duplicateTargets = await withSkuTriggerDisabled(db, async () => [
      await insertDuplicate(db, duplicateKeeper.id), await insertDuplicate(db, duplicateKeeper.id),
    ]);
    const splitKeeper = await insertProduct(db, 'ZZ-REAL-COLLISION', { weight: 4, price: 120, answers: { kind: 1 } });
    const splitTarget = await withSkuTriggerDisabled(db, () => insertProduct(db, 'ZZ-REAL-COLLISION',
      { weight: 9, price: 275, answers: { kind: 2, length: 'different' } }));
    await insertProduct(db, 'AG-999999');
    await db.query('UPDATE product_full_export_state SET confirmed_revision=revision');
    await activateLifecycle(db, actorId);

    const decisions = { version: 1, groups: [
      { sku: 'ZZ-DUPLICATE', action: 'deduplicate', keeperProductId: Number(duplicateKeeper.id),
        retireProductIds: duplicateTargets.map((row) => Number(row.id)), reason: 'Reviewed exact accidental duplicates' },
      { sku: 'ZZ-REAL-COLLISION', action: 'split_public_identity', keeperProductId: Number(splitKeeper.id),
        splitProductIds: [Number(splitTarget.id)], reason: 'Reviewed materially distinct retained product' },
    ] };
    const artifact = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId, decisions }, { databasePool: db });
    assert.deepEqual(artifact.blockers, []);
    const originalSplit = (await db.query('SELECT * FROM products WHERE id=$1', [splitTarget.id])).rows[0];
    const originalLifecycle = (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [splitTarget.id])).rows[0];
    assert.equal(originalLifecycle.revision, originalLifecycle.confirmed_revision, 'fixture starts with no legacy CSV work');
    const registryBefore = (await db.query(`SELECT * FROM sku_registry
      WHERE full_sku=ANY($1::text[]) ORDER BY full_sku`, [['ZZ-DUPLICATE', 'ZZ-REAL-COLLISION']])).rows;

    const staged = await repair.stage({ expectedDatabase: fixture.name, actorUserId: actorId,
      plan: artifact.plan, planHash: artifact.planHash }, { databasePool: db,
      mutationContext: { actorUserId: actorId, requestId: 'mixed-stage' } });
    assert.equal(staged.alreadyApplied, false);
    assert.deepEqual(staged.magentoCreateProductIds, [Number(splitTarget.id)]);
    const retry = await repair.stage({ expectedDatabase: fixture.name, actorUserId: actorId,
      plan: artifact.plan, planHash: artifact.planHash }, { databasePool: db,
      mutationContext: { actorUserId: actorId, requestId: 'mixed-stage-retry' } });
    assert.equal(retry.alreadyApplied, true);
    assert.deepEqual((await db.query(`SELECT id,status,full_sku FROM products
      WHERE id=ANY($1::int[]) ORDER BY id`, [[...duplicateTargets.map((row) => row.id), splitTarget.id]])).rows
      .map((row) => row.status), ['archived', 'archived', 'archived']);
    assert.deepEqual((await db.query(`SELECT * FROM sku_registry
      WHERE full_sku=ANY($1::text[]) ORDER BY full_sku`, [['ZZ-DUPLICATE', 'ZZ-REAL-COLLISION']])).rows, registryBefore);
    const stagedLifecycle = (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [splitTarget.id])).rows[0];
    assert.equal(stagedLifecycle.route, 'retired');
    for (const field of ['revision','confirmed_revision','cutover_baseline_revision','csv_retired_revision']) {
      assert.equal(stagedLifecycle[field], originalLifecycle[field]);
    }
    assert.equal(stagedLifecycle.delivery_version, String(BigInt(originalLifecycle.delivery_version) + 1n));

    await copyMigration(directory, '046_stable_public_product_sku.sql');
    await migrationRunner(url, directory);
    const post046 = (await db.query(`SELECT p.id,p.status,p.full_sku,i.public_sku
      FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      WHERE p.id=ANY($1::int[]) ORDER BY p.id`, [[splitKeeper.id, splitTarget.id]])).rows;
    assert.deepEqual(post046.map((row) => row.public_sku), ['ZZ-REAL-COLLISION', 'ZZ-REAL-COLLISION']);
    assert.equal(post046[1].status, 'archived');
    const post046Lifecycle = (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [splitTarget.id])).rows[0];
    for (const field of ['route','revision','confirmed_revision','cutover_baseline_revision','csv_retired_revision','delivery_version']) {
      assert.equal(post046Lifecycle[field], stagedLifecycle[field]);
    }

    await copyMigration(directory, '047_finalize_legacy_sku_repair.sql');
    await migrationRunner(url, directory);
    await migrationRunner(url, directory);
    const finalRows = (await db.query(`SELECT p.*,i.public_sku,i.origin,i.allocation_number
      FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      WHERE p.id=ANY($1::int[]) ORDER BY p.id`, [[splitKeeper.id, splitTarget.id]])).rows;
    assert.equal(finalRows[0].public_sku, 'ZZ-REAL-COLLISION');
    assert.equal(finalRows[1].public_sku, 'AG-1000000');
    assert.equal(finalRows[1].allocation_number, '1000000');
    assert.equal(finalRows[1].origin, 'allocated');
    assert.equal(finalRows[1].id, Number(splitTarget.id));
    assert.equal(finalRows[1].full_sku, originalSplit.full_sku);
    assert.equal(finalRows[1].status, originalSplit.status);
    assert.equal(finalRows[1].weight, originalSplit.weight);
    assert.equal(finalRows[1].total_price_uah, originalSplit.total_price_uah);
    assert.deepEqual(finalRows[1].details, originalSplit.details);
    const finalLifecycle = (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [splitTarget.id])).rows[0];
    assert.equal(finalLifecycle.route, originalLifecycle.route);
    assert.equal(finalLifecycle.hold_reason, originalLifecycle.hold_reason);
    assert.equal(finalLifecycle.business_exclusion_state, originalLifecycle.business_exclusion_state);
    assert.equal(finalLifecycle.recount_compatibility_excluded, originalLifecycle.recount_compatibility_excluded);
    assert.equal(finalLifecycle.revision, originalLifecycle.revision);
    assert.equal(finalLifecycle.confirmed_revision, originalLifecycle.confirmed_revision);
    assert.equal(finalLifecycle.cutover_baseline_revision, originalLifecycle.cutover_baseline_revision);
    assert.equal(finalLifecycle.csv_retired_revision, originalLifecycle.csv_retired_revision);
    assert.equal(finalLifecycle.delivery_version, String(BigInt(originalLifecycle.delivery_version) + 2n));
    assert.deepEqual((await db.query(`SELECT status FROM products WHERE id=ANY($1::int[]) ORDER BY id`,
      [duplicateTargets.map((row) => row.id)])).rows.map((row) => row.status), ['archived', 'archived']);
    assert.deepEqual((await db.query(`SELECT * FROM sku_registry
      WHERE full_sku=ANY($1::text[]) ORDER BY full_sku`, [['ZZ-DUPLICATE', 'ZZ-REAL-COLLISION']])).rows, registryBefore);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM magento_product_sync_requests')).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM magento_sync_jobs')).rows[0].count, 0);
    const queues = await fullSelection.queues(db);
    assert.deepEqual(queues.counts, { firstDelivery: 0, fullUpdate: 0, replacementReady: 0, held: 0 });
    const retiredIds = duplicateTargets.map((row) => Number(row.id));
    for (const queue of ['new', 'update', 'replacement']) {
      const listed = await fullSelection.list(db, { queue });
      assert.equal(listed.items.some((row) => retiredIds.includes(Number(row.id))), false);
    }
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM products
      WHERE id=ANY($1::int[]) AND (status<>'archived' OR exclude_from_export<>1)`, [retiredIds])).rows[0].count, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM product_full_export_state
      WHERE product_id=ANY($1::int[]) AND route<>'retired'`, [retiredIds])).rows[0].count, 0);
    assert.equal((await productQueries.getRecentProducts(db)).some((row) => retiredIds.includes(Number(row.id))), false);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM (
      SELECT public_product_identity_id FROM products WHERE status='active' AND corrected_to_product_id IS NULL
      GROUP BY public_product_identity_id HAVING count(*)>1) duplicate_current`)).rows[0].count, 0);

    const exportFootprint = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM export_snapshots) AS snapshots,
      (SELECT count(*)::int FROM magento_export_artifacts) AS artifacts,
      (SELECT count(*)::int FROM export_sessions) AS sessions,
      (SELECT count(*)::int FROM export_session_attempts) AS attempts`)).rows[0];
    const beforeLegacyAttempts = await exportFootprint();
    await assert.rejects(exportsService.previewExport({ fromSku: finalRows[1].public_sku,
      toSku: finalRows[1].public_sku, mode: 'manual' }, { databasePool: db }), /SKU identity requires reconciliation/);
    await assert.rejects(exportsService.createExportSnapshot({ fromSku: finalRows[1].public_sku,
      toSku: finalRows[1].public_sku, mode: 'manual', idempotencyKey: suite.crypto.randomUUID(),
      previewExpectation: '0'.repeat(64) }, {
      databasePool: db, mutationContext: { actorUserId: actorId, requestId: 'legacy-split-csv-blocked' },
    }), /SKU identity requires reconciliation/);
    assert.deepEqual(await exportFootprint(), beforeLegacyAttempts);
    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await assert.rejects(insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-REAL-COLLISION','ZZ',100)`), { code: '23505' });
    await db.query('ROLLBACK');

    const activationPlan = await publicSkuActivation.preflight({ expectedDatabase: fixture.name, actorUserId: actorId },
      { databasePool: db });
    assert.deepEqual(activationPlan.blockers, []);
    await publicSkuActivation.apply({ expectedDatabase: fixture.name, actorUserId: actorId,
      planHash: activationPlan.planHash }, { databasePool: db,
      mutationContext: { actorUserId: actorId, requestId: 'legacy-repair-public-activation' } });
    const amberCreate = await readPreviewProduct(db, { sku: finalRows[1].public_sku });
    assert.equal(Number(amberCreate.product.id), Number(splitTarget.id));
    const createEligibility = syncEligibility(amberCreate.product, null);
    assert.equal(createEligibility.eligible, true);
    assert.equal(createEligibility.mode, 'create');
    assert.equal(createEligibility.reasonCode, 'CURRENT_PRODUCT_ALLOWED');
    const installationKey = 'legacy-repair-test';
    const origin = 'https://legacy-repair.example.invalid';
    await publishPublicBinding(db, actorId, installationKey, origin);
    const deliveryPlan = await deliveryCutover.preflight({ expectedDatabase: fixture.name, installationKey,
      actorUserId: actorId, origin }, { databasePool: db });
    assert.deepEqual(deliveryPlan.blockers, []);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM audit_events
      WHERE event_key='legacy_sku_repair.finalized' AND subject_id=$1`, [artifact.planHash])).rows[0].count, 1);
    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await assert.rejects(db.query(`UPDATE products SET public_product_identity_id=$2 WHERE id=$1`,
      [splitTarget.id, finalRows[0].public_product_identity_id]), /public identity is immutable/);
    await db.query('ROLLBACK');

  } finally { await cleanup(fixture); }
});

suite.test('legacy SKU repair preflight rejects registry, equality, external evidence, and stale state', async () => {
  const { assert } = suite;
  const fixture = await setup045('amber_legacy_sku_repair_preflight_test');
  fixture.name = 'amber_legacy_sku_repair_preflight_test';
  const { db, actorId } = fixture;
  try {
    const keeper = await insertProduct(db, 'ZZ-PREFLIGHT');
    const different = await withSkuTriggerDisabled(db, () => insertProduct(db, 'ZZ-PREFLIGHT',
      { weight: 8, price: 222, answers: { kind: 9 } }));
    await activateLifecycle(db, actorId);
    const decision = { version: 1, groups: [{ sku: 'ZZ-PREFLIGHT', action: 'deduplicate',
      keeperProductId: Number(keeper.id), retireProductIds: [Number(different.id)], reason: 'Must be exact' }] };
    let result = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId,
      decisions: decision }, { databasePool: db });
    assert.ok(result.blockers.some((item) => item.code === 'LEGACY_SKU_REPAIR_DUPLICATE_MISMATCH'));

    await db.query('UPDATE sku_registry SET first_product_id=$2 WHERE full_sku=$1', ['ZZ-PREFLIGHT', different.id]);
    result = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId,
      decisions: { version: 1, groups: [{ sku: 'ZZ-PREFLIGHT', action: 'split_public_identity',
        keeperProductId: Number(keeper.id), splitProductIds: [Number(different.id)], reason: 'Real split' }] } }, { databasePool: db });
    assert.ok(result.blockers.some((item) => item.code === 'LEGACY_SKU_REPAIR_REGISTRY_OWNER_MISMATCH'));
    await db.query('UPDATE sku_registry SET first_product_id=$2 WHERE full_sku=$1', ['ZZ-PREFLIGHT', keeper.id]);

    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await db.query(`INSERT INTO product_export_revisions(product_id,revision,confirmed_revision,has_product_snapshot)
      VALUES($1,0,0,TRUE)`, [different.id]);
    await db.query('COMMIT');
    result = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId,
      decisions: decision }, { databasePool: db });
    assert.ok(result.blockers.some((item) => item.code === 'LEGACY_SKU_REPAIR_EXTERNAL_EVIDENCE'));

    const splitDecision = { version: 1, groups: [{ sku: 'ZZ-PREFLIGHT', action: 'split_public_identity',
      keeperProductId: Number(keeper.id), splitProductIds: [Number(different.id)], reason: 'Real split' }] };
    const cleanPlan = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId,
      decisions: splitDecision }, { databasePool: db });
    assert.deepEqual(cleanPlan.blockers, []);
    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await db.query('UPDATE products SET correction_reason=$2 WHERE id=$1', [different.id, 'drift after preflight']);
    await db.query('COMMIT');
    await assert.rejects(repair.stage({ expectedDatabase: fixture.name, actorUserId: actorId,
      plan: cleanPlan.plan, planHash: cleanPlan.planHash }, { databasePool: db,
      mutationContext: { actorUserId: actorId } }), { code: 'LEGACY_SKU_REPAIR_PREFLIGHT_STALE' });
    assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [different.id])).rows[0].status, 'active');
  } finally { await cleanup(fixture); }
});

suite.test('legacy SKU repair stage waits for product locks and rejects committed drift', async () => {
  const { assert, Pool } = suite;
  const fixture = await setup045('amber_legacy_sku_repair_lock_test');
  fixture.name = 'amber_legacy_sku_repair_lock_test';
  const { db, actorId, url } = fixture;
  let holder;
  let workerPool;
  let transactionOpen = false;
  try {
    const keeper = await insertProduct(db, 'ZZ-LOCKED-COLLISION');
    const target = await withSkuTriggerDisabled(db, () => insertProduct(db, 'ZZ-LOCKED-COLLISION',
      { weight: 11, price: 510, answers: { kind: 2 } }));
    await activateLifecycle(db, actorId);
    const decisions = { version: 1, groups: [{ sku: 'ZZ-LOCKED-COLLISION', action: 'split_public_identity',
      keeperProductId: Number(keeper.id), splitProductIds: [Number(target.id)], reason: 'Separate real product' }] };
    const artifact = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId,
      decisions }, { databasePool: db });
    assert.deepEqual(artifact.blockers, []);

    holder = await db.connect();
    workerPool = new Pool({ connectionString: url, max: 1 });
    const worker = await workerPool.connect();
    const holderPid = Number((await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    const workerPid = Number((await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await holder.query('BEGIN');
    transactionOpen = true;
    await holder.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [target.id]);
    const staging = repair.stage({ expectedDatabase: fixture.name, actorUserId: actorId,
      plan: artifact.plan, planHash: artifact.planHash }, { databasePool: { connect: async () => worker },
      mutationContext: { actorUserId: actorId } });
    let isBlocked = false;
    for (let attempt = 0; attempt < 500 && !isBlocked; attempt += 1) {
      isBlocked = (await db.query('SELECT $2::int=ANY(pg_blocking_pids($1)) blocked',
        [workerPid, holderPid])).rows[0].blocked;
      if (!isBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isBlocked, true, 'stage must wait for the independently held product lock');
    await holder.query('UPDATE products SET correction_reason=$2 WHERE id=$1', [target.id, 'committed while stage waited']);
    await holder.query('COMMIT');
    transactionOpen = false;
    await assert.rejects(staging, { code: 'LEGACY_SKU_REPAIR_PREFLIGHT_STALE' });
    assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [target.id])).rows[0].status, 'active');
    assert.equal((await db.query(`SELECT count(*)::int count FROM audit_events
      WHERE event_key='legacy_sku_repair.staged'`)).rows[0].count, 0);
  } finally {
    if (transactionOpen) await holder.query('ROLLBACK').catch(() => {});
    if (holder) holder.release();
    if (workerPool) await workerPool.end();
    await cleanup(fixture);
  }
});

suite.test('migration 047 rolls back if a staged split row changes after staging', async () => {
  const { assert } = suite;
  const fixture = await setup045('amber_legacy_sku_repair_stale_047_test');
  fixture.name = 'amber_legacy_sku_repair_stale_047_test';
  const { db, actorId, directory, url } = fixture;
  try {
    const keeper = await insertProduct(db, 'ZZ-STAGED-DRIFT');
    const target = await withSkuTriggerDisabled(db, () => insertProduct(db, 'ZZ-STAGED-DRIFT',
      { weight: 7, price: 333, answers: { kind: 2 } }));
    await activateLifecycle(db, actorId);
    const decisions = { version: 1, groups: [{ sku: 'ZZ-STAGED-DRIFT', action: 'split_public_identity',
      keeperProductId: Number(keeper.id), splitProductIds: [Number(target.id)], reason: 'Separate real product' }] };
    const artifact = await repair.preflight({ expectedDatabase: fixture.name, actorUserId: actorId, decisions }, { databasePool: db });
    await repair.stage({ expectedDatabase: fixture.name, actorUserId: actorId, plan: artifact.plan,
      planHash: artifact.planHash }, { databasePool: db, mutationContext: { actorUserId: actorId } });
    await db.query('BEGIN');
    await db.query("SET LOCAL amber.lifecycle_writer_version='1'");
    await db.query('UPDATE products SET correction_reason=$2 WHERE id=$1', [target.id, 'unexpected staged drift']);
    await db.query('COMMIT');
    await copyMigration(directory, '046_stable_public_product_sku.sql');
    await migrationRunner(url, directory);
    await copyMigration(directory, '047_finalize_legacy_sku_repair.sql');
    await assert.rejects(migrationRunner(url, directory), /staged product changed before finalization/);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM schema_migrations
      WHERE name='047_finalize_legacy_sku_repair.sql'`)).rows[0].count, 0);
    assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [target.id])).rows[0].status, 'archived');
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM public_product_identities
      WHERE origin='allocated'`)).rows[0].count, 0);
  } finally { await cleanup(fixture); }
});

suite.test('migration 047 fails closed on missing staging evidence, unsafe gates, and allocation conflict', async () => {
  const { assert } = suite;
  const scenarios = [
    ['tampered_receipt_hash', async (fixture) => {
      await fixture.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await fixture.db.query(`UPDATE audit_events SET details=jsonb_set(details,'{receiptHash}',to_jsonb($2::text))
        WHERE event_key='legacy_sku_repair.staged' AND subject_id=$1`, [fixture.artifact.planHash, 'f'.repeat(64)]);
      await fixture.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }, /canonical staging receipt hash is invalid/],
    ['tampered_authenticated_target', async (fixture) => {
      await fixture.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await fixture.db.query(`WITH changed AS (
          SELECT id,jsonb_set((details->>'canonicalReceipt')::jsonb,
            '{targets,0,stagedProductHash}',to_jsonb($2::text)) AS payload
          FROM audit_events WHERE event_key='legacy_sku_repair.staged' AND subject_id=$1
        ) UPDATE audit_events event SET details=jsonb_set(
          jsonb_set(event.details,'{canonicalReceipt}',to_jsonb(changed.payload::text)),
          '{receiptHash}',to_jsonb(encode(sha256(convert_to(changed.payload::text,'UTF8')),'hex')))
        FROM changed WHERE event.id=changed.id`, [fixture.artifact.planHash, 'e'.repeat(64)]);
      await fixture.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }, /staged transition is not the narrow reviewed transition/],
    ['fabricated_plan', async (fixture) => {
      await fixture.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await fixture.db.query(`WITH changed AS (
          SELECT id,jsonb_set((details->>'canonicalReceipt')::jsonb,
            '{plan,environment,fabricated}',to_jsonb(TRUE)) AS payload
          FROM audit_events WHERE event_key='legacy_sku_repair.staged' AND subject_id=$1
        ) UPDATE audit_events event SET details=jsonb_set(
          jsonb_set(event.details,'{canonicalReceipt}',to_jsonb(changed.payload::text)),
          '{receiptHash}',to_jsonb(encode(sha256(convert_to(changed.payload::text,'UTF8')),'hex')))
        FROM changed WHERE event.id=changed.id`, [fixture.artifact.planHash]);
      await fixture.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }, /canonical plan identity is invalid/],
    ['missing_evidence', async (fixture) => {
      await fixture.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
      await fixture.db.query(`DELETE FROM audit_events WHERE event_key='legacy_sku_repair.staged'
        AND subject_id=$1`, [fixture.artifact.planHash]);
      await fixture.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }, /orphaned per-product staging evidence/],
    ['public_activation', async (fixture) => {
      const eventId = await audit(fixture.db, fixture.actorId, 'public_sku.activated');
      await fixture.db.query('BEGIN');
      await fixture.db.query("SET LOCAL amber.public_sku_activation='on'");
      await fixture.db.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
        activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [fixture.actorId, eventId]);
      await fixture.db.query('COMMIT');
    }, /activation to remain disabled/],
    ['automatic_enabled', async (fixture) => {
      await fixture.db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,
        installation_key='unsafe',actor_user_id=$1 WHERE singleton`, [fixture.actorId]);
    }, /automatic delivery disabled/],
    ['allocation_conflict', async (fixture) => {
      await fixture.db.query(`INSERT INTO public_product_identities(public_sku,allocation_number,origin)
        VALUES('AG-000001',1,'allocated')`);
      await fixture.db.query("SELECT setval('public_product_sku_sequence',1,FALSE)");
    }, /public allocation conflict/],
  ];
  for (const [suffix, mutate, expected] of scenarios) {
    const fixture = await stageSplitThrough046(`amber_legacy_sku_repair_${suffix}_test`);
    try {
      await mutate(fixture);
      await copyMigration(fixture.directory, '047_finalize_legacy_sku_repair.sql');
      await assert.rejects(migrationRunner(fixture.url, fixture.directory), expected);
      assert.equal((await fixture.db.query(`SELECT count(*)::int AS count FROM schema_migrations
        WHERE name='047_finalize_legacy_sku_repair.sql'`)).rows[0].count, 0);
      assert.equal((await fixture.db.query('SELECT status FROM products WHERE id=$1', [fixture.target.id])).rows[0].status,
        'archived');
      assert.equal((await fixture.db.query(`SELECT count(*)::int AS count FROM audit_events
        WHERE event_key='legacy_sku_repair.finalized'`)).rows[0].count, 0);
    } finally { await cleanup(fixture); }
  }
});
