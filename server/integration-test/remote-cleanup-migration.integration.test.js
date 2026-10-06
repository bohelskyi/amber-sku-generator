const {test}=require('node:test');const assert=require('node:assert/strict');
const {Client,Pool}=require('pg');const {spawnSync}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
require('../test/setup-env');
test('070 checkpoint rollback and repeated startup retain 000-069 checksums and all preexisting cleanup guards',async()=>{
 const source=new URL(process.env.TEST_DATABASE_URL);assert.match(source.pathname,/_test$/);assert.ok(['localhost','127.0.0.1'].includes(source.hostname));
 const name='amber_remote_cleanup_migration_test',admin=new Client({connectionString:source.toString()});await admin.connect();let created=false,db,directory;
 const server=path.resolve(__dirname,'..');
 try{
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);await admin.query(`CREATE DATABASE ${name}`);created=true;source.pathname='/'+name;
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-remote-cleanup-069-'));
  for(const file of (await fs.readdir(path.join(server,'migrations'))).filter(n=>n.endsWith('.sql')&&n<'070'))await fs.copyFile(path.join(server,'migrations',file),path.join(directory,file));
  const migrate=()=>spawnSync(process.execPath,['--require','./test/setup-env.js','-e',`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1})`],{cwd:server,env:{...process.env,DATABASE_URL:source.toString(),NODE_ENV:'test'},encoding:'utf8',timeout:120000,windowsHide:true});
  let result=migrate();assert.equal(result.status,0,result.stderr);db=new Pool({connectionString:source.toString()});
  const old=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const oldIdentity=(await db.query("SELECT pg_get_functiondef('validate_test_deletion_identity()'::regprocedure) definition")).rows[0].definition;
  const file='070_reviewed_remote_only_cleanup.sql',sql=await fs.readFile(path.join(server,'migrations',file),'utf8');
  await fs.writeFile(path.join(directory,file),sql+'\nSELECT 1/0;');result=migrate();assert.notEqual(result.status,0);assert.match(result.stderr,/division by zero/);
  assert.equal((await db.query("SELECT to_regclass('magento_remote_catalog_deletions') present")).rows[0].present,null);
  assert.equal((await db.query("SELECT pg_get_functiondef('validate_test_deletion_identity()'::regprocedure) definition")).rows[0].definition,oldIdentity);
  assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,old);
  await fs.writeFile(path.join(directory,file),sql);result=migrate();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Applied migration 070/);
  assert.equal((await db.query('SELECT count(*)::int n FROM magento_remote_catalog_deletions')).rows[0].n,0);
  assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'070' ORDER BY name")).rows,old);
  result=migrate();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.includes('Applied migration'),false);
  await fs.writeFile(path.join(directory,file),sql.replace(/\r?\n/g,'\r\n'));result=migrate();assert.equal(result.status,0,result.stderr);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('catalog_deletion_final_state','test_deletion_product_fence','zzz_test_deletion_product_fence')")).rows[0].n,2);
 }finally{
  if(db)await db.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end();
  if(directory){assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('amber-remote-cleanup-069-'));await fs.rm(directory,{recursive:true,force:true});}
 }
});
