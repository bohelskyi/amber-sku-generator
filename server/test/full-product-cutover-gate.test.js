const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../src/services/full-product-cutover-gate');

function fixture() {
  const calls=[];
  const state={phase:'active',generation:'1',selector_version:1,required_writer_version:1};
  return {calls,state,client:{async query(sql) {
    calls.push(sql);
    if(sql.includes('to_regclass')) return {rows:[{present:true}]};
    if(sql==='SELECT * FROM full_product_export_activation WHERE singleton=TRUE') return {rows:[{...state}]};
    return {rows:[]};
  }}};
}
test('repeated existing lifecycle revalidation acquires and releases one shared session lock',async()=>{
  const {client,calls}=fixture();
  await gate.enterExisting(client);
  await gate.enterExisting(client);
  await gate.commit(client);
  await gate.release(client);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_lock_shared(')).length,1);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_unlock_shared(')).length,1);
  assert.equal(calls.filter(sql=>sql.startsWith('SET LOCAL')).length,2);
});
test('existing revalidation preserves an exclusive lifecycle boundary and its matching release',async()=>{
  const {client,calls}=fixture();
  await gate.begin(client,'BEGIN',{exclusive:true});
  await gate.enterExisting(client);
  await gate.rollback(client);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_lock(')).length,1);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_lock_shared(')).length,0);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_unlock(')).length,1);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_unlock_shared(')).length,0);
});
test('reusing a lifecycle lock still checks a newly preparing gate and releases once on rollback',async()=>{
  const {client,calls,state}=fixture();
  await gate.enterExisting(client);
  state.phase='preparing';
  await assert.rejects(gate.enterExisting(client),{code:'EXPORT_CUTOVER_PREPARING'});
  await gate.rollback(client);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_lock_shared(')).length,1);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_unlock_shared(')).length,1);
});
test('reusing a lifecycle lock still rejects an unsupported writer contract',async()=>{
  const {client,calls,state}=fixture();
  await gate.enterExisting(client);
  state.required_writer_version=2;
  await assert.rejects(gate.enterExisting(client),{code:'LIFECYCLE_WRITER_UNSUPPORTED'});
  await gate.rollback(client);
  assert.equal(calls.filter(sql=>sql.includes('pg_advisory_unlock_shared(')).length,1);
});
