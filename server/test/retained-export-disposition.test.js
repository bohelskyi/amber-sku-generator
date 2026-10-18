const test=require('node:test'),assert=require('node:assert/strict');
const {assess,remoteTime}=require('../src/services/magento/retained-export-disposition');
const local={snapshotId:'s1',fileName:'f.csv',generatedAt:'2026-09-11T10:00:00.000Z',csvSha256:'a'.repeat(64),
  members:[{productId:2,sku:'SV2',current:true},{productId:1,sku:'SV1',current:true}]};
const origin='b'.repeat(64);
test('Magento created_at is parsed only in its exact UTC REST form',()=>{
  assert.equal(remoteTime('2026-09-11 10:17:05'),Date.parse('2026-09-11T10:17:05Z'));
  for(const bad of [null,'',' 2026-09-11 10:17:05','2026-09-11T10:17:05Z','2026-13-40 99:99:99','11.09.2026']) assert.equal(remoteTime(bad),null);
});
test('every member must exist in Magento and be created inside the import window',()=>{
  const ok=assess(local,[{productId:2,sku:'SV2',current:true,remoteId:5,createdAt:'2026-09-11 10:17:05'},
    {productId:1,sku:'SV1',current:true,remoteId:4,createdAt:'2026-09-10 11:00:00'}],origin);
  assert.deepEqual(ok.blockers,[]);
  assert.deepEqual(ok.evidence.members.map(m=>m.productId),[1,2],'evidence order is canonical');
  assert.equal(ok.evidence.originHash,origin);assert.equal(ok.summary.createdFrom,'2026-09-10 11:00:00');
  const same=assess(local,[{productId:1,sku:'SV1',current:true,remoteId:4,createdAt:'2026-09-10 11:00:00'},
    {productId:2,sku:'SV2',current:true,remoteId:5,createdAt:'2026-09-11 10:17:05'}],origin);
  assert.equal(same.evidenceHash,ok.evidenceHash);
  const bad=assess(local,[{productId:2,sku:'SV2',remoteId:5,createdAt:'2026-09-09 09:59:59'},
    {productId:1,sku:'SV1',current:true,code:'MAGENTO_PRODUCT_MISSING'}],origin);
  assert.deepEqual(bad.blockers.map(b=>b.code).sort(),['MAGENTO_CREATED_OUTSIDE_IMPORT_WINDOW','MAGENTO_PRODUCT_MISSING']);
  assert.deepEqual(assess(local,[{productId:2,sku:'SV2',remoteId:5,createdAt:'2026-09-18 10:00:01'},
    {productId:1,sku:'SV1',remoteId:0,createdAt:'2026-09-11 10:00:00'}],origin).blockers.map(b=>b.code).sort(),
  ['MAGENTO_CREATED_AT_INVALID','MAGENTO_CREATED_OUTSIDE_IMPORT_WINDOW']);
  assert.notEqual(assess(local,ok.evidence.members,'c'.repeat(64)).evidenceHash,ok.evidenceHash,'origin is bound');
});
test('a superseded member absent from Magento is recorded unresolved instead of blocking',()=>{
  const result=assess(local,[{productId:2,sku:'SV2',current:true,remoteId:5,createdAt:'2026-09-11 10:17:05'},
    {productId:1,sku:'SV1',current:false,code:'MAGENTO_PRODUCT_MISSING'}],origin);
  assert.deepEqual(result.blockers,[]);
  assert.deepEqual(result.evidence.members.map(m=>[m.productId,m.current,m.resolved]),[[1,false,false],[2,true,true]]);
  assert.equal(result.summary.resolved,1);assert.deepEqual(result.summary.unresolvedSuperseded,['SV1']);
  for(const code of ['MAGENTO_PRODUCT_AMBIGUOUS','MAGENTO_READ_FAILED'])
    assert.deepEqual(assess(local,[{productId:1,sku:'SV1',current:false,code}],origin).blockers.map(b=>b.code),[code],
      'only absence of a superseded version is tolerated');
});
test('CLI arguments are strict per mode',()=>{
  const {parseArguments}=require('../scripts/retained-export-disposition');
  assert.deepEqual(parseArguments(['--mode','preview','--snapshot-id','s','--expected-database','amber']),
    {mode:'preview',snapshotId:'s',expectedDatabase:'amber'});
  const apply=parseArguments(['--mode','apply','--snapshot-id','s','--expected-database','amber','--actor-user-id','1',
    '--preview-token','a'.repeat(64),'--reason','Readback proves the import']);
  assert.equal(apply.actorUserId,1);
  for(const args of [['--mode','apply','--snapshot-id','s','--expected-database','amber'],
    ['--mode','preview','--snapshot-id','s','--expected-database','amber','--reason','x'],
    ['--mode','preview','--snapshot-id','s'],['--mode','delete','--snapshot-id','s','--expected-database','a']])
    assert.throws(()=>parseArguments(args),{code:'RETAINED_DISPOSITION_ARGUMENTS'});
});
