const test = require('node:test');
const assert = require('node:assert/strict');
const { applyNameOverride } = require('../src/services/magento/name-reconciliation');
const { impact } = require('../src/services/magento/binding-publication');
const { compileDefinition } = require('../src/services/export-templates/definition');
const fixture = require('./fixtures/magento-v4');

test('publication preserves existing effective names until an explicit Amber name-rule action', () => {
  const generated={all:'New generated',en:'New English'},existing={all:'Exact Magento name',en:'Exact English'};
  const product={magento_name_override:{generated:{all:'Old generated',en:'Old English'},values:existing},
    magento_name_rule_pin:{generated,values:existing}};
  let mapped={base:{name:generated.all},english:{name:generated.en}};
  assert.deepEqual(applyNameOverride(mapped,product),generated);
  assert.equal(mapped.base.name,existing.all);assert.equal(mapped.english.name,existing.en);
  product.magento_name_override={generated,values:{all:'Intentional Amber change',en:'Intentional English'}};
  mapped={base:{name:generated.all},english:{name:generated.en}};applyNameOverride(mapped,product);
  assert.equal(mapped.base.name,'Intentional Amber change');
  assert.deepEqual(product.magento_name_rule_pin.values,existing);
});
test('a later unchanged rule carries the earlier publication name pin without enrolling unrelated products', () => {
  const definition=fixture.definition();definition.sources={sku:definition.sources.sku};definition.tables={};definition.questionContracts={};
  for(const group of definition.groups){group.columns=group.columns.filter((c)=>!['kolir','new_note'].includes(c));for(const row of group.rows){delete row.cells.kolir;delete row.cells.new_note;row.cells.price={op:'literal',value:'42'};}}
  const compiled=compileDefinition(definition),schema=fixture.observation(),bindings=fixture.approvedBindings(definition,schema);
  for(const a of bindings.attributes)if(a.transportTarget)a.transportTarget='product.'+({attribute_set_code:'attribute_set_id',product_type:'type_id'}[a.target] || a.target);
  const revision={bindings,schema},generated={all:'Тестова назва',en:'Test name'},values={all:'Retained exact UA',en:'Retained exact EN'};
  const product={id:1,category:'XG',public_sku:'AG-000003',full_sku:'XG001',status:'active',exclude_from_export:0,
    details:{answers:{}},public_product_identity_id:1,exportState:{route:'normal',business_exclusion_state:'none'}};
  const result=impact({current:revision,draft:revision,old:{compiled},next:{compiled},states:[],
    oldProducts:[{...product,magento_name_rule_pin:{generated,values}}],nextProducts:[{...product}]},[]);
  assert.equal(result.preservedNames.length,1);assert.deepEqual(result.preservedNames[0].before,values);
  assert.equal(result.projections[0].before.covered,true);assert.equal(result.affected.length,0);assert.deepEqual(result.projections[0].after.names,values);
});
test('legacy CLI cannot bypass successor publication review or silently acknowledge coverage loss',async()=>{
  let published=false;const lines=[];
  const code=await require('../scripts/magento-bindings').runBindings({args:['publish','--revision','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '--expected-revision','1','--expected-current','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','--actor-user-id','1','--json'],
    databasePool:{},env:{},service:{getRevision:async()=>({state:'draft'}),publishDraft:async()=>{published=true;}},print:(s)=>lines.push(s),printError:(s)=>lines.push(s)});
  assert.equal(code,1);assert.equal(published,false);assert.match(lines.join(''),/MAGENTO_BINDING_PUBLICATION_REVIEW_REQUIRED/);
});
test('owned category path/ID changes enroll the exact affected products',()=>{
  const d=fixture.definition();d.sources={sku:d.sources.sku};d.tables={};d.questionContracts={};
  for(const g of d.groups){g.columns=g.columns.filter((c)=>!['kolir','new_note'].includes(c));g.columns.push('categories');
    for(const r of g.rows){delete r.cells.kolir;delete r.cells.new_note;r.cells.price={op:'literal',value:'42'};r.cells.categories={op:'literal',value:r.id==='base'?'Default/One':''};}}
  const next=structuredClone(d);next.groups[0].rows[0].cells.categories.value='Default/Two';
  const schema=fixture.observation(),revision=(definition,path,id)=>{
    const bindings=fixture.approvedBindings(definition,schema);
    for(const a of bindings.attributes){if(a.transportTarget)a.transportTarget='product.'+({attribute_set_code:'attribute_set_id',product_type:'type_id',categories:'extension_attributes.category_links'}[a.target] || a.target);
      if(a.target==='categories')a.evidence={categories:[{normalizedPath:path,categoryId:id,reviewState:'approved'}]};}
    for(const p of bindings.policies){const a=bindings.attributes.find((a)=>a.bindingKey===p.bindingKey);
      if(a.target==='categories'){p.policy='authoritative_create_update';p.evidence={categories:[{normalizedPath:path,categoryId:id,reviewState:'approved'}]};}}
    return {bindings,schema};
  };
  const product={id:1,category:'XG',public_sku:'AG-000003',full_sku:'XG001',status:'active',exclude_from_export:0,
    details:{answers:{}},public_product_identity_id:1,exportState:{route:'normal',business_exclusion_state:'none'}};
  const nodes=[{categoryId:'10',path:'Default/One',normalizedPath:'Default/One',comparable:true},{categoryId:'11',path:'Default/Two',normalizedPath:'Default/Two',comparable:true}];
  const result=impact({current:revision(d,'Default/One','10'),draft:revision(next,'Default/Two','11'),
    old:{compiled:compileDefinition(d)},next:{compiled:compileDefinition(next)},states:[],oldProducts:[{...product}],nextProducts:[{...product}]},nodes);
  assert.equal(result.affected.length,1,JSON.stringify(result.projections));assert.equal(result.affected[0].reason,'delivery_changed');
});
