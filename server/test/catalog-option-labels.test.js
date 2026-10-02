const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeLabel}=require('../src/services/catalog/option-labels');
const {createOption,updateOption}=require('../src/services/catalog/option-commands');
test('catalog English display metadata is nullable and never translated or substituted',()=>{
  for(const v of [undefined,null,'']) assert.equal(normalizeLabel(v,{optional:true}),null);
  assert.equal(normalizeLabel('Amber boxes',{optional:true}),'Amber boxes');
  for(const v of [' ',123,' x','x ','x\n','x\u007f','x'.repeat(256)]) assert.throws(()=>normalizeLabel(v,{optional:true}),{code:'CATALOG_OPTION_LABEL_INVALID'});
  assert.throws(()=>normalizeLabel(null));
});
test('authoritative option create/update reject invalid labels before any database mutation',async()=>{
  for(const command of [createOption,updateOption]) {
    await assert.rejects(command({label:'UA',label_en:' '}),{code:'CATALOG_OPTION_LABEL_INVALID'});
    await assert.rejects(command({label:'',label_en:'English'}),{code:'CATALOG_OPTION_LABEL_INVALID'});
  }
});
