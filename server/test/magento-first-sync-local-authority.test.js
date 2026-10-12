const test=require('node:test'),assert=require('node:assert/strict');
const {planFirstSyncFields}=require('../src/services/magento/first-sync-field-plan');
const {prepareProgress}=require('../src/services/magento/first-sync-progress-plan');
const authority=require('../src/services/magento/first-sync-local-authority');
const service=require('../src/services/magento/first-sync.service');
const batch=require('../src/services/magento/first-sync-batch-preflight');
const c=require('../src/services/magento/binding-contract');
const present=value=>({known:true,present:true,value});
function field(target='meta_title',scope='all',patch={}) {
  const f={target,scope,kind:'seo',type:'text',required:false,mapping:{proven:true},
    local:present('Amber '+target),remote:present('Magento '+target),...patch};
  if(f.unit){f.local={...f.local,unit:f.unit};f.remote={...f.remote,unit:f.unit};}return f;
}
function project(fields) {
  return {fields,plan:planFirstSyncFields({fields}),blockers:[],projection:fields.map(f=>({target:f.target,scope:f.scope,
    persistence:f.kind==='seo'?'seo_snapshot':f.kind==='derived'?'derived':'weight',outwardPolicy:'authoritative_create_update',
    canonicalLocalPriceProven:f.target==='price',mappingHash:c.hash(f.target+'/'+f.scope),source:{kind:f.kind==='seo'?'seo_snapshot':'derived',field:f.target,
      productId:7,bindingRevisionId:'11111111-1111-4111-8111-111111111111',definitionHash:'a'.repeat(64),routeKey:'NM',
      ...(f.kind==='seo'?{category:'NM',seoContract:'nm-first-sync-seo-v1'}:{})}}))};
}
test('weight-only choice cannot incidentally capture populated Magento SEO',()=>{
  const p=project([field('decor_weight','all',{kind:'scalar',type:'decimal',unit:'g',scale:3,local:present('21.400'),remote:present('21')}),field()]);
  const result=prepareProgress(p,null,{target:'decor_weight',scope:'all',choice:'keep_local'});
  assert.equal(result.rows[0].record.after,'21.400');assert.equal(result.rows[0].record.state,'pending_outward_confirmation');
  assert.equal(result.rows[1].record.state,'conflict');assert.equal(result.rows[1].record.after,'Amber meta_title');
  assert.equal(result.readyForOutbound,false);assert.ok(result.blockers.some(b=>b.target==='meta_title'));
});
test('one atomic local choice set covers weight, price and both SEO scopes with no import states',()=>{
  const fields=[field('decor_weight','all',{kind:'scalar',type:'decimal',unit:'g',scale:3,local:present('21.4'),remote:present('21')}),
    field('price','all',{kind:'scalar',type:'decimal',unit:'UAH',scale:2,local:present('100.00'),remote:present('99.00')}),
    ...['all','en'].flatMap(s=>['meta_title','meta_description'].map(t=>field(t,s)))];
  const result=prepareProgress(project(fields),null,fields.map(({target,scope})=>({target,scope,choice:'keep_local'})));
  assert.equal(result.readyForOutbound,true);assert.equal(result.complete,false);
  assert.ok(result.rows.every(r=>r.record.state==='pending_outward_confirmation'&&r.record.source.decision==='keep_local'));
  assert.ok(result.rows.every(r=>r.record.after===r.local.value));
});
test('only valid proven local derived SEO and positive UAH painting price receive local authority',()=>{
  const seo=field('meta_title','en',{kind:'derived',prospective:{verified:true,value:'Amber meta_title'}});
  const price=field('price','all',{kind:'derived',type:'decimal',unit:'UAH',scale:2,
    local:present('2100.00'),remote:present('2099.00'),prospective:{verified:true,value:'2100.00'}});
  const p=project([seo,price]);const planned=prepareProgress(p,null);
  assert.ok(planned.rows.every(r=>r.canKeepLocal));
  const chosen=prepareProgress(p,null,p.fields.map(({target,scope})=>({target,scope,choice:'keep_local'})));
  assert.equal(chosen.readyForOutbound,true);assert.ok(chosen.rows.every(r=>r.record.state==='pending_outward_confirmation'));
  const mismatched=project([price]);mismatched.projection[0].canonicalLocalPriceProven=false;
  assert.equal(prepareProgress(mismatched,null).rows[0].canKeepLocal,false);
  for(const changed of [{...seo,target:'arbitrary_derived'}, {...seo,remote:{known:false}},
    {...seo,local:present('')},{...seo,mapping:{proven:false}}, {...seo,prospective:{verified:false}},
    {...price,unit:'USD'}, {...price,scale:3}, {...price,local:present('0'),prospective:{verified:true,value:'0'}}]) {
    assert.equal(prepareProgress(project([changed]),null).rows[0].canKeepLocal,false);
  }
});
test('unselected and stale local SEO decisions never fall back to remote authority',()=>{
  const p=project([field()]);assert.equal(prepareProgress(p,null).rows[0].status,'conflict');
  const first=prepareProgress(p,null,{target:'meta_title',scope:'all',choice:'keep_local'});
  const prior={fields:first.rows.map(r=>({...r.record,revision:'1'}))};
  p.fields[0].remote=present('External change');p.plan=planFirstSyncFields({fields:p.fields});
  const stale=prepareProgress(p,prior);assert.equal(stale.rows[0].record.state,'conflict');
  assert.notEqual(stale.rows[0].record.state,'seo_pending_initial_readback');assert.equal(stale.readyForOutbound,false);
  const fresh=prepareProgress(p,prior,{target:'meta_title',scope:'all',choice:'keep_local'});assert.equal(fresh.readyForOutbound,true);
});
test('already accepted pending SEO equal to fresh local remains incomplete until its delivery ACK',()=>{
  const p=project([field()]);const first=prepareProgress(p,null,{target:'meta_title',scope:'all',choice:'accept_remote'});
  const progress={fields:first.rows.map(r=>({...r.record,revision:'1'}))};
  p.fields[0].local=structuredClone(p.fields[0].remote);p.plan=planFirstSyncFields({fields:p.fields});
  const again=prepareProgress(p,progress);assert.equal(again.rows[0].record.state,'seo_pending_initial_readback');
  assert.equal(again.rows[0].terminal,false);assert.equal(again.complete,false);assert.equal(again.readyForOutbound,true);
});
test('old pending remote SEO remains immutable unless explicitly selected with proof; bad reads are denied',async()=>{
  const p=project([field()]),old=prepareProgress(p,null,{target:'meta_title',scope:'all',choice:'accept_remote'});
  const progress={session:{id:'session',completed_at:null},fields:old.rows.map(r=>({...r.record,revision:'1'}))};
  const before=structuredClone(progress),chosen=prepareProgress(p,progress,{target:'meta_title',scope:'all',choice:'keep_local'});
  assert.deepEqual(progress,before);assert.equal(chosen.rows[0].record.after,'Amber meta_title');
  assert.deepEqual(chosen.rows[0].record.source.seoAuthorityChange.evidence,old.rows[0].record);
  const first={key:{originHash:'b'.repeat(64),publicIdentityId:'17'},progress};
  const token=authority.mint({prepared:chosen,projection:p,first,observation:{amber:{product:{id:7}}}},[{target:'meta_title',scope:'all',choice:'keep_local'}]);
  const command={key:first.key,fields:chosen.rows.map(r=>r.record)};
  const db={query:async()=>({rows:[{protected:false}]})};
  assert.equal((await authority.validate(db,token,command,progress)).size,1);
  await assert.rejects(authority.validate(db,{},command,progress),{code:'FIRST_SYNC_LEDGER_SEO_AUTHORITY'});
  await assert.rejects(authority.validate({query:async()=>({rows:[{protected:true}]})},token,command,progress),{code:'FIRST_SYNC_LEDGER_SEO_AUTHORITY'});
  for(const remote of [{known:false},present('malformed\nSEO'),{known:true,present:false,value:'not empty'}]) {
    p.fields[0].remote=remote;p.plan=planFirstSyncFields({fields:p.fields});
    assert.equal(prepareProgress(p,progress).rows[0].canKeepLocal,false);
  }
});
test('choices reject duplicates, sparse/empty/mixed commands and canonicalize retry order',()=>{
  const a={target:'price',scope:'all',choice:'keep_local'},b={target:'meta_title',scope:'en',choice:'keep_local'};
  assert.deepEqual(service.decisions({choices:[a,b]}),service.decisions({choices:[b,a]}));
  for(const input of [{choices:[]},{choices:[a,a]},{choices:[a,,b]},{choices:[a],target:'price'},
    {choices:[{...a,choice:'erase'}]},{choices:[{...a,unknown:true}]}])assert.throws(()=>service.decisions(input));
  assert.throws(()=>prepareProgress(project([field()]),null,[{target:'meta_title',scope:'all',choice:'keep_local'},
    {target:'unmapped',scope:'all',choice:'keep_local'}]),{code:'MAGENTO_FIRST_SYNC_FIELD_NOT_MAPPED'});
});
test('rounding preflight uses exact decimals and excludes other weight differences and unknown precision',()=>{
  for(const [l,r] of [['21.400','21'],['27.800','28'],['39.500','40'],['39.500','39']])assert.equal(batch.roundedWeight(l,r),true);
  for(const [l,r] of [['21.400','22'],['27.800','30'],['22.000','22'],['21.4','21.1'],['0','0'],['-21.4','-21']])assert.equal(batch.roundedWeight(l,r),false);
});
