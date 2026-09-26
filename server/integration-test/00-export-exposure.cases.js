const { test, assert, pool, crypto, schemas, execFileAsync, serverRoot } = require('./suite-context');
const { loadCorrectionExposureManifest } = require('../src/services/export-exposure.service');
const { serializeManifest } = require('../src/services/export-exposure/manifest');

// Registered first: these isolated fixtures must not depend on earlier export
// tests' deliberately malformed historical snapshots. Only the disposable DB.
async function withExposureFixture(run) {
  const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.ok(database.endsWith('_test'));
  const suffix = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  const ids = []; const snapshotId = crypto.randomUUID(); let correctionId;
  try {
    for (const role of ['SOURCE', 'SUCCESSOR']) {
      const row = (await pool.query(`INSERT INTO products
        (full_sku,category,weight,total_price_uah,exclude_from_export,details,sku_schema_version_id)
        VALUES ($1,'ZZ',1,100,1,'{"answers":{"size":"1,0"}}'::jsonb,$2) RETURNING id,full_sku`,
      [`ZZ-EVIDENCE-${role}-${suffix}`, schemas.ZZ])).rows[0];
      ids.push(row.id);
    }
    const [source, successor] = (await pool.query('SELECT id,full_sku FROM products WHERE id=ANY($1::int[]) ORDER BY id', [ids])).rows;
    await pool.query("UPDATE products SET status='corrected',corrected_to_product_id=$1 WHERE id=$2", [successor.id, source.id]);
    await pool.query('UPDATE products SET corrected_from_product_id=$1 WHERE id=$2', [source.id, successor.id]);
    correctionId = (await pool.query(`INSERT INTO product_corrections
      (source_product_id,corrected_product_id,source_sku,corrected_sku,old_payload,new_payload,reason)
      VALUES ($1,$2,$3,$4,'{"answers":{"size":"1,0"}}','{"answers":{"size":1}}','Exposure fixture') RETURNING id`,
    [source.id, successor.id, source.full_sku, successor.full_sku])).rows[0].id;
    await pool.query(`INSERT INTO export_snapshots
      (id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content)
      VALUES ($1,$1,$2,$2,$2,$3,1,'evidence.csv',$4)`,
    [snapshotId, source.full_sku, source.id, `sku,price_uah\r\n${source.full_sku},100\r\n`]);
    await run({ database, source, successor, snapshotId, correctionId });
  } finally {
    // Disposable fixture cleanup only; never invoked by the inventory loader.
    await pool.query('DELETE FROM export_snapshots WHERE id=$1', [snapshotId]);
    if (correctionId) await pool.query('DELETE FROM product_corrections WHERE id=$1', [correctionId]);
    await pool.query('UPDATE products SET corrected_from_product_id=NULL,corrected_to_product_id=NULL WHERE id=ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::int[])', [ids]);
  }
}

async function retainedRows() {
  const result = {};
  // Identifiers are a fixed test allowlist, not input.
  for (const table of ['products', 'product_corrections', 'export_snapshots', 'magento_export_artifacts',
    'product_export_revisions', 'export_state', 'export_events', 'sku_registry', 'audit_events', 'correction_requests']) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

test('exposure inventory PostgreSQL uses one read-only repeatable transaction and changes no retained rows', async () => {
  await withExposureFixture(async ({ database, correctionId }) => {
    const before = await retainedRows(); const queries = []; let connections = 0; let settings;
    const observedPool = { async connect() {
      connections += 1; const client = await pool.connect();
      return { release: () => client.release(), async query(sql, args) {
        queries.push(sql);
        if (sql.includes('FROM products ORDER BY id')) {
          settings = (await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
            current_setting('transaction_isolation') AS isolation`)).rows[0];
          await client.query('SAVEPOINT prove_read_only');
          await assert.rejects(client.query('UPDATE products SET weight=weight WHERE FALSE'), { code: '25006' });
          await client.query('ROLLBACK TO SAVEPOINT prove_read_only');
        }
        return client.query(sql, args);
      } };
    } };
    const manifest = await loadCorrectionExposureManifest(observedPool, { expectedDatabase: database });
    assert.equal(connections, 1);
    assert.deepEqual(settings, { read_only: 'on', isolation: 'repeatable read' });
    assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(queries.every((sql) => /^(BEGIN|SET LOCAL|SELECT|COMMIT)/.test(sql) && !/FOR (UPDATE|SHARE)/.test(sql)));
    assert.equal(manifest.correctionPairs.find((p) => p.correctionId === correctionId).lineageExposure.classification, 'generated_exact');
    const repeated = await loadCorrectionExposureManifest(pool, { expectedDatabase: database });
    assert.equal(serializeManifest(manifest), serializeManifest(repeated));
    assert.deepEqual(await retainedRows(), before);
  });
});

test('exposure inventory PostgreSQL keeps a consistent view across a concurrent independent writer', async () => {
  await withExposureFixture(async ({ database, source, snapshotId, correctionId }) => {
    const writer = await pool.connect(); let overlapped = false;
    try {
      const observedPool = { async connect() {
        const reader = await pool.connect();
        return { release: () => reader.release(), async query(sql, args) {
          const result = await reader.query(sql, args);
          if (sql.includes('FROM products ORDER BY id')) {
            // Barrier: the reader has read products, but not the snapshots.
            // Commit both writer changes while the reader transaction remains open.
            const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            assert.notEqual(readerPid, (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            await writer.query('BEGIN');
            await writer.query('UPDATE products SET total_price_uah=200 WHERE id=$1', [source.id]);
            await writer.query("UPDATE export_snapshots SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id=$1", [snapshotId]);
            await writer.query('COMMIT'); overlapped = true;
          }
          return result;
        } };
      } };
      const during = await loadCorrectionExposureManifest(observedPool, { expectedDatabase: database });
      const oldPair = during.correctionPairs.find((p) => p.correctionId === correctionId);
      assert.ok(overlapped);
      assert.equal(Number(oldPair.source.total_price_uah), 100);
      assert.equal(oldPair.lineageExposure.classification, 'generated_exact');
      const after = await loadCorrectionExposureManifest(pool, { expectedDatabase: database });
      const newPair = after.correctionPairs.find((p) => p.correctionId === correctionId);
      assert.equal(Number(newPair.source.total_price_uah), 200);
      assert.equal(newPair.lineageExposure.classification, 'confirmed_exact');
      assert.notEqual(after.contentSha256, during.contentSha256);
      assert.equal((await pool.query('SELECT status FROM export_snapshots WHERE id=$1', [snapshotId])).rows[0].status, 'confirmed');
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });
});

test('exposure inventory CLI PostgreSQL emits identical JSON bytes and rejects the wrong database', async () => {
  await withExposureFixture(async ({ database, correctionId }) => {
    const run = (name, tz) => execFileAsync(process.execPath, [
      'scripts/inventory-correction-exposure.js', '--database-name', name,
    ], { cwd: serverRoot, env: { ...process.env, TZ: tz }, maxBuffer: 10 * 1024 * 1024 });
    const before = await retainedRows();
    const first = await run(database, 'UTC'); const second = await run(database, 'Pacific/Honolulu');
    assert.equal(first.stderr, ''); assert.equal(second.stderr, '');
    assert.equal(first.stdout, second.stdout);
    const manifest = JSON.parse(first.stdout);
    assert.equal(manifest.correctionPairs.find((p) => p.correctionId === correctionId).lineageExposure.classification, 'generated_exact');
    assert.match(manifest.contentSha256, /^[a-f0-9]{64}$/);
    await assert.rejects(run('incorrect_test', 'UTC'), (error) => {
      assert.equal(error.stdout, ''); assert.match(error.stderr, /does not match expected name/); return true;
    });
    assert.deepEqual(await retainedRows(), before);
  });
});
