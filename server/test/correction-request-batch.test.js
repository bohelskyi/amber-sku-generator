const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/services/correction-request-batch-evidence');
const cli = require('../scripts/correction-request-batch');
const { observeUsdRate, assertUsdRateObservationCurrent } = require('../src/services/currency.service');

function fixture() {
  const source = { product: { id: 1, status: 'active', corrected_to_product_id: null } };
  const old = { productId:1,sku:'BR1',answers:{kind:1,hidden:7},weight:5,totalPrice:10,totalPriceUah:400,pricePerGram:2 };
  const c = { categoryCode:'BR',skuSchemaVersionId:1,weight:5,fullSku:'BR2',publicSku:'AG-000001',answers:{kind:2,hidden:7},
    exactNames:{all:'Name',en:'Name'},nameInheritance:{reviewRequired:false},delivery:{route:'normal',holdReason:null},
    pricePerGram:2,pricePerGramUah:80,fixedPriceUah:null,priceMode:'per_gram_usd',usesWeight:true,totalPrice:10,
    totalPriceUah:400,calculatedPriceUah:400,autoPriceUah:400,uahRate:40,manualPriceUah:null,pricingDetails:{scenario:{id:1}},
    pricingDecision:{mode:'system_auto'},recountEvidence:{version:5,names:{reviewRequired:false},sharedNames:null,exposure:{classification:'reliably_unexposed'},
      target:{answers:{kind:2}},lifecycle:[],lineage:{products:[1]},route:'normal',holdReason:null,publicSkuActivation:true} };
  const preview = { source:old,corrected:c,previewToken:'matching' };
  const row = { id:1,request_type:'recount',status:'pending',claimed_by_user_id:null,claim_token_hash:null,
    pricing_mode:'system_auto',old_payload:structuredClone(old),proposed_payload:structuredClone(c),preview_signature:'matching' };
  return { source,preview,row };
}

test('bulk classification distinguishes current proof, refresh upgrade and missing historical review', () => {
  const f=fixture();
  assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'SAFE_TO_COMPLETE');
  f.row.proposed_payload.recountEvidence.version=4;
  assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'REFRESH_SAME_INTENT');
  delete f.row.proposed_payload.recountEvidence;
  assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'REVIEW_REQUIRED');
});
test('semantic target, schema, calibration and names are material even at the same final UAH', () => {
  for (const mutate of [p=>p.answers.kind=3,p=>p.skuSchemaVersionId=2,p=>p.answers.is_calibrated=2,
    p=>p.exactNames.en='Different',p=>p.delivery.holdReason='historical_ambiguity']) {
    const f=fixture();mutate(f.preview.corrected);
    assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'REVIEW_REQUIRED');
  }
});
test('all persisted pricing results are material including manual baseline and USD totals', () => {
  for (const field of ['calculatedPriceUah','autoPriceUah','totalPrice','pricePerGram','uahRate']) {
    const f=fixture();f.row.pricing_mode='manual_uah';f.row.pricing_manual_uah=400;
    f.preview.corrected[field]+=1;
    assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'REVIEW_REQUIRED');
  }
});
test('only inherited hidden removal can remain same intent; explicitly requested removal needs review', () => {
  const f=fixture();delete f.preview.corrected.answers.hidden;
  assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'SAFE_TO_COMPLETE');
  f.row.proposed_payload.answers.hidden=8;
  assert.equal(e.classify(f.row,f.source,f.preview,5).classification,'REVIEW_REQUIRED');
});
test('ownership includes token-only exclusion and no implicit disabled-owner bypass', () => {
  const f=fixture();f.row.status='in_progress';f.row.claimed_by_user_id=6;
  assert.deepEqual(e.classify(f.row,f.source,null,5),{classification:'OWNERSHIP_BLOCKED',reasons:['CLAIMED_BY_OTHER']});
  f.row.claimed_by_user_id=null;f.row.claim_token_hash='secret';
  assert.equal(e.classify(f.row,f.source,null,5).reasons[0],'LEGACY_TOKEN_ONLY');
  f.row.claim_token_hash=null;assert.equal(e.classify(f.row,f.source,null,5),null);
});
test('retired sources, no-op price changes and invalid owner shapes are explicit', () => {
  const f=fixture();f.source.product.status='corrected';
  assert.equal(e.classify(f.row,f.source,null,5).classification,'STALE_OR_OBSOLETE');
  f.source.product.status='active';f.row.claimed_by_user_id=5;
  assert.equal(e.classify(f.row,f.source,null,5).classification,'INVALID_OR_BLOCKED');
  f.row.claimed_by_user_id=null;f.row.request_type='price_change';
  assert.equal(e.classify(f.row,f.source,{unchanged:true},5).classification,'STALE_OR_OBSOLETE');
});
test('result seal ignores only observation time/explanations and rejects rate/allocation/dependency drift', () => {
  const f=fixture(),observation={rateInfo:{rate:40,rateDate:'2026-10-03',source:'nbu',stale:false}};
  const entry={requestType:'recount',refreshedResult:e.resultProjection(f.preview,'recount'),rateEvidence:e.rateEvidence(observation)};
  f.preview.corrected.uahRateFetchedAt='later';f.preview.corrected.logMessage='display';
  e.assertReviewedResult(entry,f.preview,observation);
  f.preview.corrected.fullSku='BR2-1';assert.throws(()=>e.assertReviewedResult(entry,f.preview,observation),{code:'CORRECTION_BATCH_DRIFT'});
});

function planFixture() {
  const body={format:e.FORMAT,toolContract:'correction-batch-v1',policyVersion:1,actorUserId:5,requestIds:[1,2,3],entries:[
    {requestId:1,classification:'SAFE_TO_COMPLETE',postDeliveryReviewRequired:false},
    {requestId:2,classification:'REFRESH_SAME_INTENT',postDeliveryReviewRequired:true},
    {requestId:3,classification:'REVIEW_REQUIRED',postDeliveryReviewRequired:false},
  ].map(x=>({...x,entryHash:e.hash(x)}))};
  return {...body,planHash:e.hash(body)};
}
test('sealed selection requires explicit held IDs and cannot authorize unsafe/duplicate/unknown IDs', () => {
  const p=planFixture();
  assert.throws(()=>e.select(p,p.planHash,[1,2]),{code:'CORRECTION_BATCH_SELECTION_INVALID'});
  const s=e.select(p,p.planHash,[2,1],[2]);e.verifySelection(p,s,s.selectionHash);
  for(const ids of [[3],[4],[1,1]])assert.throws(()=>e.select(p,p.planHash,ids));
  assert.throws(()=>e.verifySelection(p,{...s,postDeliveryReviewIds:[]},s.selectionHash));
  p.entries[0].classification='REVIEW_REQUIRED';assert.throws(()=>e.verifyPlan(p,p.planHash));
});
test('CLI rejects implicit/ambiguous/unbounded scope and strips credentials from target identity', () => {
  const args=['preflight','--expected-database','amber_test','--actor-user-id','5','--all-active','--limit','100','--output','new.json'];
  assert.equal(cli.parseArguments(args).limit,100);
  for(const bad of [args.filter(x=>x!=='100'),[...args,'--ids-file','ids.json'],[...args,'--limit','200']]) assert.throws(()=>cli.parseArguments(bad));
  const a=cli.connectionTarget('postgresql://user:password@127.0.0.1:55432/amber_test');
  assert.equal(a,cli.connectionTarget('postgresql://different:secret@127.0.0.1:55432/amber_test'));
  assert.throws(()=>cli.connectionTarget(''));
});
test('read-only rate provider uses exact live evidence with no cache writes', async () => {
  const queries=[];
  const rate=await observeUsdRate({databasePool:{query:async sql=>{queries.push(sql);return{rows:[]};}},
    fetchLive:async()=>({rate:40,rateDate:'2026-10-03',fetchedAt:'2026-10-03T10:00:00Z'}),now:()=>new Date('2026-10-03T10:00:00Z')});
  assert.equal(rate.rateInfo.rate,40);assert.equal(rate.rateInfo.source,'nbu');assert.deepEqual(queries,[]);
});
test('read-only rate fallback enforces normal maximum stale age and never persists', async () => {
  const queries=[],databasePool={query:async sql=>{queries.push(sql);return{rows:[{rate:39,rate_date:'2026-10-02',fetched_at:'2026-10-02T10:00:00Z'}]};}};
  const options={databasePool,fetchLive:async()=>{throw Error('offline');},now:()=>new Date('2026-10-03T10:00:00Z')};
  const rate=await observeUsdRate(options);assert.equal(rate.rateInfo.stale,true);assert.equal(rate.rateInfo.rate,39);
  const tooOld=await observeUsdRate({...options,now:()=>new Date('2026-10-12T10:00:00Z')});assert.equal(tooOld.rateInfo,null);
  assert.ok(queries.every(sql=>sql.startsWith('SELECT')));
});

test('fallback that expires during a lock wait is rejected again before pricing',()=>{
  assert.throws(()=>assertUsdRateObservationCurrent({rateInfo:{stale:true,fetchedAt:'2026-10-01T10:00:00Z'}},new Date('2030-10-03T10:00:00Z')),{code:'ERR_RATE_TOO_OLD'});
});

test('tool build binds source/dependencies without Git and canonicalizes Windows line endings',async()=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'amber-batch-build-'));
  try{
    await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'scripts'));
    await fs.writeFile(path.join(root,'package.json'),'{}');await fs.writeFile(path.join(root,'package-lock.json'),'{}');
    const file=path.join(root,'src','primitive.js');await fs.writeFile(file,'safe\r\n');
    const before=await cli.buildIdentity(root);await fs.writeFile(file,'safe\n');assert.equal(await cli.buildIdentity(root),before);
    await fs.writeFile(file,'changed\n');assert.notEqual(await cli.buildIdentity(root),before);
  }finally{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});}
});

test('phase uniqueness failure remains fatal rather than being normalized as a SKU collision',async()=>{
  const receipts=require('../src/services/correction-request-batch-receipts');
  const review={planHash:e.hash('p'),selectionHash:e.hash('s'),actorUserId:5,entry:{requestId:1,requestHash:e.hash('before'),entryHash:e.hash('entry')}};
  const client={query:async sql=>{
    if(sql.includes('FROM audit_events'))return{rows:[]};
    if(sql.includes('FROM correction_requests'))return{rows:[{raw:{id:1},claim_version:'1'}]};
    if(sql.includes('FROM application_users'))return{rows:[{display_name:'Actor',preferred_username:null}]};
    if(sql.includes('INSERT INTO audit_events'))throw Object.assign(Error('duplicate receipt'),{code:'23505',constraint:'correction_batch_step_identity_idx'});
    assert.fail(sql);
  }};
  await assert.rejects(receipts.record(client,{batchReview:review,mutationContext:{actorUserId:5}},'claimed'),
    {code:'CORRECTION_BATCH_RECEIPT_CONFLICT',statusCode:503});
});

test('apply recomputes safety from the actual stored request, even for a self-consistent reviewed result',()=>{
  const f=fixture(),entry={classification:'SAFE_TO_COMPLETE',sourceEvidence:f.source};
  e.assertReviewedClassification(entry,f.row,f.preview,5);
  f.preview.corrected.totalPriceUah=500;
  assert.throws(()=>e.assertReviewedClassification(entry,f.row,f.preview,5),{code:'CORRECTION_BATCH_CLASSIFICATION_DRIFT'});
});
