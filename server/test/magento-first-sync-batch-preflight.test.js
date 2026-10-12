const test=require('node:test'),assert=require('node:assert/strict');
const batch=require('../src/services/magento/first-sync-batch-preflight'),first=require('../src/services/magento/first-sync.service');
const c=require('../src/services/magento/binding-contract'),binding='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
function harness(t,skus=['NM1']) {
 const observations=new Map(skus.map((sku,i)=>[sku,{amber:{product:{id:i+1,public_sku:sku,full_sku:sku,category:'NM',status:'active',exclude_from_export:0,
  weight:'132.3',total_price_uah:'100.00',details:{answers:{}},exportState:{route:'normal',business_exclusion_state:'none'}},compiled:{hash}},raw:{id:1488+i,sku}}]));
 const calls={observe:0,prepare:0,sql:[]};let packetChecks=0;
 const client={query:async sql=>{calls.sql.push(sql);return {rows:sql.includes('SELECT id FROM')?[{id:binding}]:[]};},release(){}};
 const pool={connect:async()=>client},config={baseUrl:'https://batch.invalid'};
 t.mock.method(require('../src/services/access-admin-transaction'),'assertActorStillAuthorized',async()=>{packetChecks++;});
 for(const method of ['enterExisting','rollback','release'])t.mock.method(require('../src/services/full-product-cutover-gate'),method,async()=>{});
 t.mock.method(require('../src/services/magento/binding.service'),'readRevisionOnClient',async()=>({id:binding,state:'published',installationKey:'batch',definitionHash:hash,originHash:c.originHash(config.baseUrl)}));
 t.mock.method(require('../src/services/magento/binding-publication'),'administrator',async()=>{});
 t.mock.method(require('../src/services/magento/sync-job-transaction'),'revalidate',async()=>{});
 t.mock.method(require('../src/services/magento/first-sync-eligibility'),'readFirstSyncEligibility',async()=>({mode:'first',evidenceHash:hash}));
 const boundary=require('../src/services/magento/sync-job.service').recoveryBoundary;
 t.mock.method(boundary,'guard',async(_c,input,_o,fn)=>fn({publicSku:input.sku}));
 t.mock.method(boundary,'observe',async(_c,input)=>{calls.observe++;return {observation:observations.get(input.sku),report:{evaluation:{ready:true},syncEligibility:{eligible:true},sendable:true}};});
 const row={target:'decor_weight',scope:'all',local:{known:true,present:true,value:'132.3'},remote:{known:true,present:true,value:132},canKeepLocal:true};
 const base={mode:'first',fields:[row],projection:{projection:[{target:'decor_weight',scope:'all',persistence:'weight'}]},first:{key:{},evidenceHash:hash},
  prepared:{rows:[],blockers:[]},blockers:[],previewToken:hash};
 t.mock.method(first,'inspect',async(_c,observation)=>({...base,observation}));
 t.mock.method(first,'prepareDecision',async(_c,b,choices)=>{calls.prepare++;return {...b,prepared:{readyForOutbound:true,blockers:[],rows:choices.map(d=>({...d,record:{state:'pending_outward_confirmation'}}))}};});
 const input={bindingRevisionId:binding,expectedDefinitionHash:hash,items:skus.map(sku=>({sku,expectedProduct:batch.source(observations.get(sku).amber.product),
  remoteProductId:observations.get(sku).raw.id,fields:[{target:'decor_weight',scope:'all',local:'132,3',remote:132}]}))};
 return {input,base,row,observations,calls,boundary,options:{databasePool:pool,actorUserId:7},config,get packetChecks(){return packetChecks;}};
}
test('bounded preview uses validated canonical preparation, two authority fences and no DML',async t=>{
 const h=harness(t),r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.readOnly,true);assert.equal(r.counts.readyForApply,1);
 assert.equal(h.calls.prepare,1);assert.equal(h.packetChecks,2);assert.equal(r.results[0].readyForOutboundAfterChoices,true);
 assert.deepEqual(r.results[0].applyInput.choices,[{target:'decor_weight',scope:'all',choice:'keep_local'}]);assert.ok(h.calls.sql.every(sql=>/^(BEGIN|SELECT)/.test(sql)));
});
test('strict input rejects duplicate/sparse/oversized products, fields and extras',()=>{
 const item={sku:'NM1',expectedProduct:batch.source({}),remoteProductId:1,fields:[{target:'price',scope:'all',local:1,remote:2}]};
 const command={bindingRevisionId:binding,expectedDefinitionHash:hash,items:[item]};batch.command(command);
 for(const bad of [{...command,items:[item,item]},{...command,items:Array(1)},{...command,items:Array.from({length:11},(_,i)=>({...item,sku:'NM'+i}))},
  {...command,items:[{...item,fields:[{...item.fields[0],choice:'accept_remote'}]}]}])assert.throws(()=>batch.command(bad),{code:'MAGENTO_BINDING_INVALID'});
});
test('changed identity/snapshot and nonrounding weights never yield apply commands',async t=>{
 const h=harness(t,['NM1','NM2','NM3']);h.input.items[0].expectedProduct.weight_numeric='132.4';h.input.items[1].remoteProductId=999;
 h.input.items[2].fields[0].remote=140;h.row.remote.value=140;
 const r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.counts.readyForApply,0);
 for(const [i,code]of ['BATCH_PRODUCT_CHANGED','BATCH_IDENTITY_CHANGED','BATCH_WEIGHT_NOT_ROUNDING_ONLY'].entries())assert.ok(r.results[i].blockers.some(b=>b.code===code));
 assert.equal(h.calls.prepare,0);
});
test('excluded/test lifecycle, unready payload, unknown/inherited remote fail closed',async t=>{
 const h=harness(t,['NM1','NM2','NM3']);h.observations.get('NM1').amber.product.is_test_product=true;
 h.observations.get('NM2').amber.product.exportState.business_exclusion_state='excluded';
 t.mock.method(h.boundary,'observe',async(_c,input)=>({observation:h.observations.get(input.sku),report:{evaluation:{ready:false},syncEligibility:{eligible:false},sendable:false}}));
 let r=await batch.preflight(h.config,h.input,h.options);assert.equal(h.calls.prepare,0);assert.ok(r.results.every(r=>!r.applyInput));
 assert.ok(r.results[0].blockers.some(b=>b.code==='BATCH_LIFECYCLE_NOT_NORMAL'));assert.ok(r.results[2].blockers.some(b=>b.code==='BATCH_PRODUCT_PAYLOAD_NOT_READY'));
 t.mock.method(h.boundary,'observe',async(_c,input)=>({observation:h.observations.get(input.sku),report:{evaluation:{ready:true},syncEligibility:{eligible:true},sendable:true}}));
 h.row.remote.known=false;r=await batch.preflight(h.config,h.input,h.options);assert.ok(r.results[2].blockers.some(b=>b.code==='BATCH_FIELD_CHANGED'));
 h.row.remote.known=true;h.row.canKeepLocal=false;r=await batch.preflight(h.config,h.input,h.options);assert.ok(r.results[2].blockers.some(b=>b.code==='BATCH_LOCAL_CHOICE_UNAVAILABLE'));
});
test('validated preparation reports remaining canonical blockers honestly',async t=>{
 const h=harness(t);t.mock.method(first,'prepareDecision',async(_c,b,choices)=>({...b,prepared:{rows:choices.map(d=>({...d,record:{state:'pending_outward_confirmation'}})),readyForOutbound:false,blockers:[{code:'CANONICAL_IMPORT_REQUIRES_FRESH_PREVIEW'}]}}));
 const r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.results[0].readyForApply,true);assert.equal(r.results[0].readyForOutboundAfterChoices,false);
 assert.equal(r.results[0].remainingBlockers[0].code,'CANONICAL_IMPORT_REQUIRES_FRESH_PREVIEW');
});
test('historical admission and ordinary workflow stay separate',async t=>{
 const h=harness(t,['NM1','NM2']);t.mock.method(first,'inspect',async(_c,o)=>o.raw.sku==='NM1'?{mode:'review',blockers:[{code:'HISTORY_REQUIRED'}],historyReview:{sku:'NM1'}}:{mode:'ordinary',blockers:[]});
 const r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.results[0].status,'blocked');assert.ok(r.results[0].historyReview);
 assert.equal(r.results[1].status,'ordinary_preview_required');assert.equal(r.counts.ordinaryPreviewRequired,1);assert.equal(h.calls.prepare,0);
});
test('rights failure aborts further reads and invalidates earlier commands',async t=>{
 const h=harness(t,['NM1','NM2','NM3']);t.mock.method(h.boundary,'guard',async(_c,input,_o,fn)=>{if(input.sku==='NM2')throw Object.assign(Error('Revoked'),{statusCode:403,code:'ADMIN_PERMISSION_REVOKED'});return fn({publicSku:input.sku});});
 const r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.globalFailure,'ADMIN_PERMISSION_REVOKED');assert.equal(r.counts.readyForApply,0);
 assert.equal(r.counts.notChecked,1);assert.equal(r.results[2].status,'not_checked');assert.equal(h.calls.observe,1);assert.ok(r.results.every(r=>!r.applyInput));
});
test('final packet authority drift invalidates all previously ready products',async t=>{
 const h=harness(t,['NM1','NM2']);let count=0;t.mock.method(require('../src/services/access-admin-transaction'),'assertActorStillAuthorized',async()=>{if(++count===2)throw Object.assign(Error('Changed'),{code:'ACTOR_NOT_ACTIVE'});});
 const r=await batch.preflight(h.config,h.input,h.options);assert.equal(r.globalFailure,'ACTOR_NOT_ACTIVE');assert.equal(r.counts.readyForApply,0);assert.equal(r.counts.blocked,2);assert.ok(r.results.every(r=>!r.applyInput));
});
