const test=require('node:test'),assert=require('node:assert/strict');
const admission=require('../src/services/magento/first-sync-cutover-admission');
const repair=require('../src/services/export-exposure/repair-loader');
const {fixture}=require('./fixtures/first-sync-cutover-admission');
const c=require('../src/services/magento/binding-contract');
const retainedInput=()=>({products:[{id:7,full_sku:'SV7',public_sku:'SV7',category:'SV'}],
  registry:[{full_sku:'SV7',first_product_id:7}],snapshots:[],artifacts:[],members:[],revisions:[],events:[],
  state:[{singleton:true,exported_to_product_id:7}]});
test('canonical cutover proof accepts the complete chain and rejects malformed entries without writes or network',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('History qualification must never perform HTTP'));
  let retainedReads=0;
  t.mock.method(repair,'readRepairInput',async()=>{retainedReads++;return retainedInput();});
  const valid=fixture({malformed:false});assert.ok(await admission.proposal(valid.client,valid.config,valid.observation,valid.options));
  assert.equal(retainedReads,1);
  for(const malformed of [true,e=>[e,'entry'],e=>[e,{...e,productId:8,action:'ordinary_delivery'}],e=>[e,{...e}],e=>[e,{...e,productId:-1}]]) {
    const broken=fixture({malformed});assert.equal(await admission.proposal(broken.client,broken.config,broken.observation,broken.options),null);
    assert.ok(broken.queries.every(sql=>sql.startsWith('SELECT ')));
  }
  assert.equal(retainedReads,1,'malformed proof must fail before retained inventory loading');
});
test('legacy snapshot indicator permits only reviewed canonical admission and is sealed without changing old false proofs',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('Qualification is local read-only'));
  const input=retainedInput(),f=fixture({malformed:false});
  t.mock.method(repair,'readRepairInput',async()=>input);
  const previous=await admission.proposal(f.client,f.config,f.observation,f.options);
  assert.equal(previous.retainedHash,c.hash({snapshots:[],diagnostics:[],events:[],cursor:input.state}));
  assert.equal(Object.hasOwn(previous,'legacySnapshotFlag'),false);
  input.revisions.push({product_id:7,revision:'0',confirmed_revision:'0',has_product_snapshot:true});
  const before=structuredClone(input),review=await admission.assessProposal(f.client,f.config,f.observation,f.options);
  assert.equal(review.proposal.legacySnapshotFlag,true);assert.notEqual(review.proposal.retainedHash,previous.retainedHash);
  assert.deepEqual(review.assessment,{status:'available',code:'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE',legacySnapshotFlag:true});
  assert.equal(admission.descriptor(review.proposal,f.observation).legacySnapshotFlag,true);
  input.revisions[0].revision='8';input.revisions[0].confirmed_revision='3';
  assert.equal((await admission.proposal(f.client,f.config,f.observation,f.options)).retainedHash,review.proposal.retainedHash,
    'Dedicated price-stream counters are not full-product delivery receipts');
  input.revisions[0].has_product_snapshot=false;
  assert.deepEqual(await admission.proposal(f.client,f.config,f.observation,f.options),previous);
  assert.equal(before.revisions[0].has_product_snapshot,true);assert.ok(f.queries.every(sql=>sql.startsWith('SELECT ')));
});
const retainedSnapshot=(csv='sku,price_uah\r\nSV7,42\r\n')=>({id:'retained',status:'generated',row_count:1,
  exported_to_product_id:7,from_sku:'SV7',to_sku:'SV7',resolved_to_sku:'SV7',reexport_revisions:[],file_name:'retained.csv',csv_content:csv});
for(const [name,modify,code] of [
  ['indexed membership',(_f,input)=>input.members.push({snapshot_id:'absent',product_id:7}),'FIRST_SYNC_RETAINED_FILES_UNRESOLVED'],
  ['unindexed generated CSV',(_f,input)=>input.snapshots.push(retainedSnapshot()),'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED'],
  ['malformed CSV hiding membership',(_f,input)=>input.snapshots.push(retainedSnapshot('sku,price_uah\r\n"SV7,42')),'FIRST_SYNC_RETAINED_FILES_UNRESOLVED'],
  ['unknown SKU in retained CSV',(_f,input)=>input.snapshots.push(retainedSnapshot('sku,price_uah\r\nUNKNOWN,42\r\n')),'FIRST_SYNC_RETAINED_FILES_UNRESOLVED'],
  ['orphan artifact',(_f,input)=>input.artifacts.push({snapshot_id:'absent',csv_content:'sku\r\nSV7\r\n'}),'FIRST_SYNC_RETAINED_FILES_UNRESOLVED'],
  ['invalid cursor',(_f,input)=>{input.state=[];},'FIRST_SYNC_RETAINED_FILES_UNRESOLVED'],
  ['lineage',f=>{f.options.history.hasRecount=true;},'FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED'],
  ['identity change',f=>{f.options.history.identityChanged=true;},'FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED'],
  ['independent exclusion',f=>{f.options.history.products[0].independentExclusion=true;},'FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED'],
  ['unproved baseline',f=>{f.row.details.deliveryNotProven=false;},'FIRST_SYNC_CUTOVER_PROVENANCE_UNPROVEN'],
  ['remote identity mismatch',f=>{f.observation.raw.sku='OTHER';},'FIRST_SYNC_REMOTE_IDENTITY_UNPROVEN'],
  ['pending media or other protected work',f=>{f.options.facts.protected_work=true;},'FIRST_SYNC_UNFINISHED_WORK'],
  ['other origin',f=>{f.options.facts.other_origin=true;},'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED'],
  ['actual delivery receipt',f=>{f.options.facts.external_delivery_receipts.push({revision:'1'});},'FIRST_SYNC_DELIVERY_HISTORY_CHANGED'],
]) test('true legacy indicator does not waive '+name,async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('No HTTP permitted'));
  const input=retainedInput(),f=fixture({malformed:false});input.revisions.push({product_id:7,has_product_snapshot:true});
  modify(f,input);const before=structuredClone(input);t.mock.method(repair,'readRepairInput',async()=>input);
  const assessed=await admission.assessProposal(f.client,f.config,f.observation,f.options);
  assert.equal(assessed.proposal,null);assert.equal(assessed.assessment.status,'blocked');assert.equal(assessed.assessment.code,code);
  assert.deepEqual(input,before);assert.ok(f.queries.every(sql=>sql.startsWith('SELECT ')));
});
test('a migration-082 disposition of the exact retained bytes resolves only that file and is sealed into the proof',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('No HTTP permitted'));
  const {hash}=require('../src/services/export-exposure/evidence');
  const csv='sku,price_uah\r\nSV7,42\r\n',row={snapshot_id:'retained',csv_sha256:hash(csv),evidence_hash:'e'.repeat(64),audit_event_id:'9',
    evidence:{members:[{productId:7,resolved:true}]}};
  const assessed=async(dispositions,extra=[])=>{
    const input=retainedInput(),f=fixture({malformed:false,dispositions});
    input.revisions.push({product_id:7,has_product_snapshot:true});input.snapshots.push(retainedSnapshot(csv),...extra);
    t.mock.method(repair,'readRepairInput',async()=>input);
    return admission.assessProposal(f.client,f.config,f.observation,f.options);
  };
  assert.equal((await assessed([])).assessment.code,'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED');
  assert.equal((await assessed([{...row,csv_sha256:hash('other bytes')}])).assessment.code,'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED',
    'changed stored bytes void the disposition');
  assert.equal((await assessed([{...row,evidence:{members:[{productId:7,resolved:false}]}}])).assessment.code,
    'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED','an unresolved member of a disposed file stays blocked');
  assert.equal((await assessed([{...row,evidence:{members:[{productId:8,resolved:true}]}}])).assessment.code,
    'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED','a disposition resolves only its listed products');
  const resolved=await assessed([row]);
  assert.equal(resolved.assessment.status,'available');
  assert.equal(resolved.assessment.code,'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE');
  const flagOnly=retainedInput(),f=fixture({malformed:false});flagOnly.revisions.push({product_id:7,has_product_snapshot:true});
  t.mock.method(repair,'readRepairInput',async()=>flagOnly);
  const unaffected=await admission.assessProposal(f.client,f.config,f.observation,f.options);
  assert.ok(!f.queries.some(sql=>sql.includes('retained_export_dispositions')),'non-members never read dispositions');
  assert.notEqual(resolved.proposal.retainedHash,unaffected.proposal.retainedHash);
  const second={...retainedSnapshot('sku,price_uah\r\nSV7,43\r\n'),id:'second'};
  assert.equal((await assessed([row],[second])).assessment.code,'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED','every member file needs its own disposition');
});
