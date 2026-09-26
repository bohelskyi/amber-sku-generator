// Rehearse ONLY a restored 038 disposable database. Production follows the
// operator runbook; this script's simulated attestations are never approvals.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const { runMigrations } = require('../src/db/run-migrations');
const cutover = require('../src/services/full-product-cutover.service');
const { dryRunRepair } = require('../src/services/recount-repair.service');
const { reconcileFullProduct } = require('../src/services/full-product-reconciliation.service');
const selection = require('../src/services/full-product-selection');
const { digest } = require('../src/services/export-exposure/repair-manifest');

async function immutable(db) {
  const result = await db.query(`SELECT
    (SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'csv',csv_content,'confirmed',confirmed_at) ORDER BY id) FROM export_snapshots) snapshots,
    (SELECT jsonb_agg(a ORDER BY snapshot_id,group_code) FROM magento_export_artifacts a) artifacts,
    (SELECT jsonb_agg(s) FROM export_state s) cursor,
    (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations`);
  return digest(result.rows[0]);
}
async function main() {
  if (!process.env.DATABASE_URL || process.argv.length !== 3) throw Error('Explicit DATABASE_URL and output directory required');
  const expectedDatabase = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(expectedDatabase)) throw Error('Disposable _test database required');
  const out = path.resolve(process.argv[2]); await fs.mkdir(out, { recursive: false });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const timings = []; const result = { procedure: '039 → 040 → preparing → indexing manifest → index → post-index manifest → batches → validate → activate', timings };
  const timed = async (name, action) => {
    const start = performance.now(); const value = await action();
    timings.push({ name, milliseconds: Math.round((performance.now()-start)*100)/100 });
    console.log(JSON.stringify(timings.at(-1))); return value;
  };
  const save = (name, value) => fs.writeFile(path.join(out,name), JSON.stringify(value,null,2)+'\n', { flag:'wx' });
  try {
    assert.equal((await db.query('SELECT current_database() name')).rows[0].name, expectedDatabase);
    assert.equal((await db.query('SELECT max(name) name FROM schema_migrations')).rows[0].name, '038_editable_export_columns.sql');
    const immutableBefore = await immutable(db);
    const productsBefore = digest((await db.query('SELECT to_jsonb(p) AS p FROM products p ORDER BY id')).rows);
    await timed('039_then_040', () => runMigrations());
    const actorUserId = Number((await db.query(`SELECT u.id FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
      JOIN roles r ON r.id=a.role_id JOIN role_permissions rp ON rp.role_id=r.id
      WHERE u.status='active' AND a.revoked_at IS NULL AND r.status='active' AND rp.permission_key='exports.reconcile' ORDER BY u.id LIMIT 1`)).rows[0].id);
    const options = { databasePool: db, expectedDatabase, deploymentEvidence:'DISPOSABLE isolated rehearsal; no application traffic; only current writer code',
      mutationContext: { actorUserId, requestId:'DISPOSABLE-cutover-rehearsal' } };
    await timed('prepare', () => cutover.prepare(options));
    const index = await timed('fresh_index_manifest', () => cutover.generate('index',options));
    await save('index-manifest.json',index); result.indexHash = index.contentSha256;
    result.indexing = await timed('historical_index', () => cutover.indexHistorical(index,index.contentSha256,options));
    assert.equal((await cutover.indexHistorical(index,index.contentSha256,options)).alreadyApplied,true);
    const manifest = await timed('fresh_post_index_manifest', () => cutover.generate('cutover',options));
    await save('cutover-manifest.json',manifest); result.cutoverHash = manifest.contentSha256;
    result.actions = Object.fromEntries(['legacy_baseline','first_delivery','hold','preserve'].map((a) => [a,manifest.entries.filter((e)=>e.action===a).length]));
    await timed('approve_simulated_baseline', () => cutover.approve(manifest,manifest.contentSha256,'DISPOSABLE simulation of approved 2193/44/40 policy; not a production approval',options));
    const batches = Math.ceil(manifest.entries.filter((e) => e.action!=='preserve').length/cutover.BATCH_SIZE);
    for (let n=0;n<batches;n++) await timed(`batch_${n}`, () => cutover.applyBatch(manifest.contentSha256,n,options));
    assert.equal((await cutover.applyBatch(manifest.contentSha256,0,options)).alreadyApplied,true);
    result.validation = await timed('final_validation', () => cutover.validate(manifest.contentSha256,options));
    await timed('selector_activation', () => cutover.activate(manifest.contentSha256,options));
    assert.equal((await cutover.activate(manifest.contentSha256,options)).alreadyActive,true);
    result.beforeRelease = await selection.queues(db);
    // Existing rows, names, exclusions, immutable bytes, cursor and reservations
    // are still bit-for-bit equivalent at the selector authority switch.
    assert.equal(immutableBefore,await immutable(db));
    assert.equal(productsBefore,digest((await db.query("SELECT to_jsonb(p)-'magento_name_review_required' AS p FROM products p ORDER BY id")).rows));
    result.simulatedReleases = [];
    for (const id of [4512,4846,4847,4848]) {
      const e = (await dryRunRepair(db,{expectedDatabase})).repairEntries.find((p)=>p.productId===id);
      assert.equal(e.exposure.classification,'reliably_unexposed');
      result.simulatedReleases.push(await timed(`simulated_attestation_${id}`, () => reconcileFullProduct({
        action:'unexposed_first_delivery',successorId:id,deliveryVersion:e.lifecycle.delivery_version,beforeFingerprint:e.beforeFingerprint,
        ancestorSkus:e.ancestorChain.map((a)=>a.sku),oldSkus:e.ancestorChain.map((a)=>({sku:a.sku,disposition:'verified_absent',evidence:'DISPOSABLE simulation only'})),
        files:[],exclusionResolution:{disposition:'recount_only_attested',evidence:'DISPOSABLE simulation: recount-generated and no later independent exclusion'},
        reason:'DISPOSABLE simulation only',resolutionKey:`disposable-release-${id}` },options)));
    }
    result.afterRelease = await selection.queues(db);
    assert.equal(immutableBefore,await immutable(db));
    result.focusProducts = (await db.query(`SELECT id,full_sku,status,exclude_from_export,weight,total_price_uah,sku_schema_version_id,
      details->'answers'->'weight' answer,magento_name_subject_ua,magento_name_subject_en,magento_name_review_required
      FROM products WHERE id IN(4502,4512,4846,4847,4848) ORDER BY id`)).rows;
    result.memberships = (await db.query(`SELECT s.status,count(*)::int count,count(*) FILTER(WHERE m.full_revision IS NOT NULL OR m.delivery_version IS NOT NULL)::int acknowledged
      FROM export_snapshot_products m JOIN export_snapshots s ON s.id=m.snapshot_id GROUP BY s.status ORDER BY s.status`)).rows;
    result.unacknowledged = (await db.query('SELECT count(*)::int count FROM product_full_export_state WHERE confirmed_revision=0')).rows[0].count;
    result.immutablePreserved = true;
    await save('result.json',result);
  } finally { await db.end(); await require('../src/db/pool').end(); }
}
if (require.main === module) main().catch((error)=>{ console.error(error);process.exitCode=1; });
