const {test}=require('node:test');
const assert=require('node:assert/strict');
const shape=require('../src/services/magento/attribute-create-contract');
const {signAttributeCreateRequest}=require('../src/services/magento/oauth');
const command={bindingRevisionId:'00000000-0000-0000-0000-000000000001',expectedRevision:'1',
  attributeCode:'new_color',label:'Колір',englishLabel:'Color',frontendInput:'select',scope:'global',
  required:false,visibleOnFront:true,searchable:true,filterable:true,filterableInSearch:true};
function remote(input=command){
  const body=shape.creation(input,3);
  return {...body.attribute,attribute_id:6001,source_model:input.frontendInput==='select'?'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table':null,
    backend_model:null,backend_type:input.frontendInput==='select'?'int':'varchar',options:[]};
}
test('new attributes expose explicit bounded settings and never write an ID, custom source or initial options',()=>{
  const body=shape.creation(command,3);
  assert.equal(Object.hasOwn(body.attribute,'attribute_id'),false);
  assert.equal(Object.hasOwn(body.attribute,'options'),false);
  assert.equal(Object.hasOwn(body.attribute,'source_model'),false);
  assert.deepEqual(body.attribute.frontend_labels,[{store_id:0,label:'Колір'},{store_id:3,label:'Color'}]);
  for(const patch of [{frontendInput:'multiselect'},{frontendInput:'swatch_visual'},{scope:'unknown'},{required:'false'},
    {attributeCode:'unsafe/path'},{attribute_id:77},{options:[]},{label:' x'},{englishLabel:''}]){
    assert.throws(()=>shape.creation({...command,...patch},3));
  }
  assert.throws(()=>shape.creation({...command,frontendInput:'text'},3),{code:'MAGENTO_ATTRIBUTE_FILTER_TYPE_UNSUPPORTED'});
  assert.throws(()=>shape.creation(command,null),{code:'MAGENTO_ATTRIBUTE_EN_STORE_UNAVAILABLE'});
});
test('exact create verification checks identity, every reviewed flag, source type, scope and exact EN',()=>{
  const intent={body:shape.creation(command,3)};const observed=remote();
  assert.equal(shape.verifyCreated(intent,'6001',observed).attributeId,6001);
  for(const patch of [{attribute_id:6002},{attribute_code:'other'},{frontend_input:'text'}, {scope:'store'},
    {is_required:true},{source_model:'Custom\\Source'},{default_value:'1'}, {apply_to:[]},
    {frontend_labels:[{store_id:3,label:'Колір'}]},{options:[{value:'1',label:'Unexpected'}]}]){
    assert.throws(()=>shape.verifyCreated(intent,'6001',{...observed,...patch}));
  }
  for(const flag of Object.keys(shape.FIXED_FLAGS)) assert.throws(()=>shape.verifyCreated(intent,'6001',{...observed,[flag]:!observed[flag]}));
  const text={...command,frontendInput:'text',filterable:false,filterableInSearch:false};
  assert.equal(shape.verifyCreated({body:shape.creation(text,3)},'6001',remote(text)).attributeId,6001);
});

test('stock REST nullable backend/default omission verifies only the empty reviewed profile',()=>{
  const intent={body:shape.creation(command,3)};
  const observed=remote();
  delete observed.backend_model; delete observed.default_value;
  assert.equal(shape.verifyCreated(intent,'6001',observed).attributeId,6001);
  for(const field of ['backend_model','default_value']){
    for(const value of [null,'']) assert.equal(shape.verifyCreated(intent,'6001',{...observed,[field]:value}).attributeId,6001);
    for(const value of ['Custom\\Backend','1',false,true,0,1,[],{}]){
      assert.throws(()=>shape.verifyCreated(intent,'6001',{...observed,[field]:value}),{code:'MAGENTO_ATTRIBUTE_VERIFICATION_FAILED'});
    }
    assert.throws(()=>shape.verifyCreated(intent,'6001',{...observed,[field]:undefined}),{code:'MAGENTO_BINDING_INVALID'});
  }
  for(const field of ['backend_type','source_model']){
    const missing={...observed};delete missing[field];
    assert.throws(()=>shape.verifyCreated(intent,'6001',missing),{code:'MAGENTO_ATTRIBUTE_VERIFICATION_FAILED'});
  }
  for(const patch of [{attribute_id:6002},{attribute_code:'other'},{backend_type:'varchar'},
    {source_model:'Custom\\Source'},{scope:'store'},{apply_to:[]},{is_required:true},
    {frontend_labels:[]},{options:[{label:'New',value:'1'}]}]){
    assert.throws(()=>shape.verifyCreated(intent,'6001',{...observed,...patch}));
  }
});

test('stock REST empty option placeholder, omitted null fields and string boolean flags retain exact verification',()=>{
  const quiet={...command,visibleOnFront:false,searchable:false,filterable:false,filterableInSearch:false};
  const observed=remote(quiet); delete observed.backend_model; delete observed.default_value;
  observed.frontend_labels=[{store_id:3,label:'Color'}]; observed.options=[{label:' ',value:''}];
  for(const key of ['is_visible_on_front','is_searchable','is_unique','is_comparable','is_visible_in_advanced_search','is_used_for_promo_rules','used_in_product_listing']) observed[key]='0';
  assert.equal(shape.verifyCreated({body:shape.creation(quiet,3)},'6001',observed).attributeId,6001);
  for(const flag of Object.keys(shape.FIXED_FLAGS)){
    const opposite=shape.FIXED_FLAGS[flag]?'0':'1';
    assert.throws(()=>shape.verifyCreated({body:shape.creation(quiet,3)},'6001',{...observed,[flag]:opposite}));
  }
});
test('set context never accepts truncated groups, another set or ambiguous member identity',()=>{
  assert.deepEqual(shape.groups({items:[{attribute_group_id:'3',attribute_set_id:'7',attribute_group_name:'Загальні'}],total_count:1},7),[{id:3,setId:7,name:'Загальні'}]);
  assert.throws(()=>shape.groups({items:[],total_count:101},7));
  assert.throws(()=>shape.groups({items:[{attribute_group_id:3,attribute_set_id:8,attribute_group_name:'Wrong'}],total_count:1},7));
  assert.throws(()=>shape.membership([remote(),remote()]));
});
test('typed attribute POST signer rejects updates, arbitrary paths, queries and unrelated resource endpoints',()=>{
  const config={consumerKey:'k',consumerSecret:'s',accessToken:'t',accessTokenSecret:'ts'};
  for(const path of ['/rest/all/V1/products/attributes','/rest/all/V1/products/attribute-sets/attributes']){
    assert.match(signAttributeCreateRequest(`https://fixture.invalid${path}`,config),/^OAuth /);
  }
  for(const path of ['/rest/all/V1/products/attributes/price','/rest/all/V1/products/attributes?x=1','/rest/en/V1/products/attributes','/rest/all/V1/products']){
    assert.throws(()=>signAttributeCreateRequest(`https://fixture.invalid${path}`,config));
  }
});
