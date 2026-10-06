const test=require('node:test');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
// Isolated query-contract fixture: real PostgreSQL evaluates the ownership proof
// predicates. Full application migrations/native create workflows run separately.
test('native ownership reads require exact acknowledged origin/SKU/identity and retain predecessor receipts',async()=>{
  const source=new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name=`amber_native_ownership_${process.pid}_test`,marker=process.env.CODEX_FINAL_DB_MARKER || `native-ownership-${randomUUID()}`;
  const control=new Client({connectionString:source.toString()});await control.connect();let db,created=false;
  const before=(await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname);
  try {
    assert.equal(before.includes(name),false);await control.query(`CREATE DATABASE ${name}`);created=true;
    await control.query(`COMMENT ON DATABASE ${name} IS '${marker}'`);
    const url=new URL(source);url.pathname=`/${name}`;db=new Client({connectionString:url.toString()});await db.connect();
    await db.query(`CREATE TABLE public_product_identities(id bigint PRIMARY KEY,public_sku text NOT NULL,origin text NOT NULL);
      CREATE TABLE magento_sync_jobs(id uuid PRIMARY KEY,public_product_identity_id bigint,product_id bigint,sku text,origin_hash text,state text,
        acknowledged_at timestamptz,remote_product_id bigint,created_at timestamptz DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO public_product_identities VALUES(4959,'AG-000003','allocated')`);
    const own=require('../src/services/magento/native-identity-ownership');
    const a={product:{id:5012,characteristic_version_id:1,public_product_identity_id:4959,public_sku:'AG-000003'},revision:{originHash:'owned-origin'}};
    const raw={id:5797,sku:'AG-000003'};
    const check=async expected=>{await own.load(db,a,'owned-origin');assert.equal(own.issue(a,raw),expected);};
    await check(own.CODE);
    await db.query("INSERT INTO magento_sync_jobs VALUES($1,4960,5011,'AG-000003','owned-origin','succeeded',CURRENT_TIMESTAMP,5797,CURRENT_TIMESTAMP)",[randomUUID()]);
    await check(own.CODE);
    for(const [origin,sku,state,ack] of [['foreign-origin',raw.sku,'succeeded',true],['owned-origin','OTHER','succeeded',true],
      ['owned-origin',raw.sku,'uncertain',true],['owned-origin',raw.sku,'succeeded',false]]) {
      await db.query('INSERT INTO magento_sync_jobs VALUES($1,4959,5011,$2,$3,$4,$5,5797,CURRENT_TIMESTAMP)',
        [randomUUID(),sku,origin,state,ack?new Date():null]);await check(own.CODE);
    }
    await db.query("INSERT INTO magento_sync_jobs VALUES($1,4959,5011,'AG-000003','owned-origin','succeeded',CURRENT_TIMESTAMP,5797,CURRENT_TIMESTAMP)",[randomUUID()]);
    await check(null);assert.equal(own.issue(a,{...raw,id:5798}),own.CODE);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,6,'proof reads never modify receipts');
  }finally{
    if(db)await db.end();
    if(created){assert.equal((await control.query('SELECT shobj_description(oid,\'pg_database\') marker FROM pg_database WHERE datname=$1',[name])).rows[0].marker,marker);
      await control.query(`DROP DATABASE ${name}`);}
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),before);
    await control.end();
  }
});
