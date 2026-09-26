const { test, assert, Pool, fs, os, path, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
test('migration 040 rolls back atomically, preserves 039 checksums/data and repeats without accepting a baseline',async()=>{
  const name='amber_cutover_migration_test';const url=await recreateTestDatabase(name);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-cutover-039-'));const db=new Pool({connectionString:url});
  const migrate=()=>runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try{
    for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter(f=>f.endsWith('.sql')&&f<'040'))await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
    await migrate();
    const c=await db.connect();try{await c.query('BEGIN');
      await c.query("INSERT INTO categories(code,name) VALUES('HX','Historical')");
      const products=(await c.query("INSERT INTO products(full_sku,category,exclude_from_export) VALUES('HX1','HX',0),('HX2','HX',1) RETURNING id")).rows;
      for(const p of products)await c.query(`INSERT INTO product_full_export_state(product_id,route,hold_reason,evidence)
        VALUES($1,'hold','historical_ambiguity','{"origin":"migration_039"}')`,[p.id]);
      await c.query('COMMIT');
    }finally{await c.query('ROLLBACK');c.release();}
    const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const products=(await db.query('SELECT * FROM products ORDER BY id')).rows;
    const file='040_full_product_export_cutover.sql';const sql=await fs.readFile(path.join(serverRoot,'migrations',file),'utf8');
    await fs.writeFile(path.join(directory,file),sql+'\nSELECT 1/0;');await assert.rejects(migrate(),/division by zero/);
    assert.equal((await db.query("SELECT to_regclass('full_product_export_activation') gate")).rows[0].gate,null);
    assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='product_full_export_state' AND column_name='cutover_baseline_revision'")).rows[0].n,0);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
    await fs.writeFile(path.join(directory,file),sql);await migrate();await migrate();
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'040' ORDER BY name")).rows,before);
    assert.deepEqual((await db.query('SELECT * FROM products ORDER BY id')).rows,products);
    assert.deepEqual((await db.query('SELECT confirmed_revision,cutover_baseline_revision,business_exclusion_state FROM product_full_export_state ORDER BY product_id')).rows,
      ['none','unknown'].map(business_exclusion_state=>({confirmed_revision:'0',cutover_baseline_revision:'0',business_exclusion_state})));
    assert.equal((await db.query('SELECT phase FROM full_product_export_activation')).rows[0].phase,'legacy');
    assert.equal((await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n,0);
    await assert.rejects(db.query('UPDATE product_full_export_state SET cutover_baseline_revision=revision'),/one-time cutover decision/);
    await assert.rejects(db.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1"),/command boundary/);
    await assert.rejects(db.query("UPDATE product_full_export_state SET business_exclusion_state='excluded'"),/new version/);
  }finally{await db.end();await fs.rm(directory,{recursive:true,force:true});await dropTestDatabase(name);}
});
