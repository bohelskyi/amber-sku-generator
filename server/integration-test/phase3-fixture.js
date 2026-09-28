const { Pool } = require('pg');
const pool = require('../src/db/pool');
const { runMigrations } = require('../src/db/run-migrations');
const { ensureLegacySkuSchemas } = require('../src/services/sku-schema.service');
const products = require('../src/services/product.service');
const exportsService = require('../src/services/export.service');
const repair = require('../src/services/recount-repair.service');
const { reconcileFullProduct } = require('../src/services/full-product-reconciliation.service');
const crypto = require('node:crypto');
let actorId; let database;
const opts = (db = pool) => ({databasePool:db,expectedDatabase:database,mutationContext:{actorUserId:actorId,requestId:'phase3-test'}});
const product = async (id) => (await pool.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];
const state = async (id) => (await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[id])).rows[0];
const audits = async (event) => (await pool.query('SELECT * FROM audit_events WHERE event_key=$1 ORDER BY id',[event])).rows;
async function setup() {
  database = (await pool.query('SELECT current_database() db')).rows[0].db;
  if (!database.endsWith('_test')) throw Error('Disposable database required');
  await runMigrations();
  await pool.query("INSERT INTO categories(code,name,requires_weight) VALUES('SV','Souvenirs',0)");
  for (const [at,[key,value]] of [['material',2],['color',3],['souvenir',1],['statuette',5]].entries()) {
    const q=(await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
      VALUES('SV',$1,$1,$2::int,$2::int,1,1,'options') RETURNING id`,[key,at+1])).rows[0];
    await pool.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)',[q.id,value,String(value)]);
  }
  for (const key of ['weight','size']) await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
    VALUES('SV',$1,$1,0,99,0,0,'text')`,[key]);
  for (const [at,[key,visible]] of [['2',{statuette:1}],['bird',{'2':2}],['plants',{statuette:2}],
    ['symbolic_stat',{statuette:5}],['table_games',{souvenir:2}],['stone_processing',{souvenir:5}],['additional_stone',{souvenir:5}]].entries()) {
    const q=(await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type,visible_if_json)
      VALUES('SV',$1,$1,$2::int,$2::int,0,1,'options',$3::jsonb) RETURNING id`,[key,at+5,JSON.stringify(visible)])).rows[0];
    await pool.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','1')",[q.id]);
  }
  await ensureLegacySkuSchemas();
  actorId=Number((await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','Phase3 tester') RETURNING id")).rows[0].id);
  await pool.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actorId]);
}
const answers={material:2,color:3,souvenir:1,statuette:5,symbolic_stat:1,weight:1260,size:'23/6/30'};
async function save() {
  const names={magento_name_subject_ua:'[UX-5 аудит] Символіка',magento_name_subject_en:'[UX-5 audit] Symbolic figurine'};
  const preview=await products.buildNewProductPreview({categoryCode:'SV',answers,weight:1260,...names});
  const p=await products.saveProduct({category:'SV',answers,weight:1260,manualPriceUah:21700,...names,
    skuSchemaVersionId:preview.skuSchemaVersionId,previewToken:preview.previewToken},opts());
  return product(p.id);
}
async function recountInput(p,patch={size:`${crypto.randomUUID()}`}) {
  const input={sourceSku:p.full_sku,answers:patch,manualPriceUah:21700};
  const preview=await products.buildProductRecountPreview(input);
  return {...input,sourceStateSignature:preview.source.stateSignature};
}
const recount = (input,db=pool) => products.applyProductRecount(input,opts(db));
async function pair({exposed,legacy=false,lostNames=false,weightRepair=false}={}) {
  let source=await save();let snapshot;
  if(weightRepair){await pool.query(`UPDATE products SET details=jsonb_set(details,'{answers,weight}','"1260,0"'::jsonb) WHERE id=$1`,[source.id]);source=await product(source.id);}
  if(exposed) { snapshot=await capture(source);if(exposed==='confirmed')await confirm(snapshot); }
  const result=await recount(await recountInput(source,weightRepair?{weight:1260}:undefined));const id=result.correctedProductId;
  if(legacy) await pool.query(`UPDATE product_full_export_state SET evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',
    route='hold',hold_reason='historical_ambiguity',delivery_version=delivery_version+1 WHERE product_id=$1`,[id]);
  if(lostNames) await pool.query('UPDATE products SET magento_name_subject_ua=NULL,magento_name_subject_en=NULL WHERE id=$1',[id]);
  return {source:await product(source.id),successor:await product(id),snapshot};
}
const capture=(p,db=pool)=>exportsService.createExportSnapshot({fromSku:p.full_sku,toSku:p.full_sku,idempotencyKey:crypto.randomUUID()},opts(db))
  .catch((error)=>{error.message+=` ${JSON.stringify(error.details)}`;throw error;});
const confirm=(s,db=pool)=>exportsService.confirmExportSnapshot(s.id,opts(db));
const manifest=(db=pool)=>repair.dryRunRepair(db,{expectedDatabase:database});
const apply=(m,ids,indexHistorical=false,db=pool)=>repair.applyRepair({manifest:m,manifestHash:m.contentSha256,productIds:ids,indexHistorical},opts(db));
async function resolution(id) {
  const m=await manifest();const e=m.repairEntries.find((r)=>r.productId===id);
  const exact=[...e.generatedMemberships,...e.confirmedMemberships];
  return {successorId:id,deliveryVersion:e.lifecycle.delivery_version,beforeFingerprint:e.beforeFingerprint,
    ancestorSkus:e.ancestorChain.map((a)=>a.sku),reason:'Reviewed external SKU and file evidence',resolutionKey:crypto.randomUUID(),
    oldSkus:[...new Set([...e.ancestorChain.map((a)=>a.sku),...exact.map((x)=>x.sku)])].map((sku)=>({sku,disposition:'verified_absent',evidence:'External review fixture'})),
    files:[...new Set(exact.map((x)=>x.snapshotId))].map((snapshotId)=>({snapshotId,disposition:'quarantined_do_not_import',evidence:'File review fixture'})),
    externalHistory:{disposition:'resolved',evidence:'External history review fixture'},
    exclusionResolution:{disposition:'release',evidence:'Business exclusion review fixture'}};
}
const reconcile=(command,db=pool)=>reconcileFullProduct(command,opts(db));
async function footprint() {
  const result={};
  for(const table of ['products','product_full_export_state','export_snapshot_products','export_snapshots','magento_export_artifacts','sku_registry','product_corrections','audit_events','export_state']) {
    result[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}
module.exports={pool,Pool,setup,opts,save,product,state,audits,pair,capture,confirm,manifest,apply,resolution,reconcile,recountInput,recount,footprint};
