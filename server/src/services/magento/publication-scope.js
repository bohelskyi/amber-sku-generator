const { createHash } = require('node:crypto');
const c = require('./binding-contract');
const { nameStateEvidence } = require('./name-state');
const { loadSupportInputs } = require('../export-templates/support-inputs');
// Measured release bounds are documented with the disposable benchmark receipt.
const LIMITS = Object.freeze({ products: 4096, page: 128, evidenceBytes: 2 * 1024 * 1024,
  inputPageBytes: 8 * 1024 * 1024, previewMs: 60000, localMs: 15000 });
function limit(bound) { throw c.error(422,'MAGENTO_PUBLICATION_LIMIT',
  `Перевірка публікації перевищила допустиму межу: ${bound}. Публікацію не виконано.`,{bound,limits:LIMITS}); }
function checkDeadline(deadline) { if(Date.now()>=deadline)limit('runtime'); }
function size(value) { return Buffer.byteLength(JSON.stringify(value)); }
function checkEvidence(value) { if(size(value)>LIMITS.evidenceBytes)limit('review_evidence_bytes'); }
function translateLimit(cause) {
  if(cause.code==='55P03')limit('lock_wait');
  if(cause.code==='57014' || cause.message==='Query read timeout')limit('runtime');
  throw cause;
}
async function scan(client,local,{deadline,onPage}={}) {
  deadline ??= Date.now()+LIMITS.localMs;
  const digest=createHash('sha256').update('amber-publication-scope-v2\n');
  digest.update(c.hash(JSON.parse(JSON.stringify({draft:local.draft,current:local.current,evidence:local.evidence,validation:local.validation}))));
  let lastId=0,total=0,inputBytes=0,maxPageBytes=0;
  while(true){
    checkDeadline(deadline);
    // Check serialized storage before transferring potentially large JSON rows.
    // Both queries use the caller's single RR snapshot (or final table locks).
    const budget=(await client.query(`WITH page AS (
      SELECT p,i AS identity,s AS lifecycle FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN product_full_export_state s ON s.product_id=p.id
      WHERE p.id>$1 AND p.status='active' AND p.corrected_to_product_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=p.public_product_identity_id)
      ORDER BY p.id LIMIT $2)
      SELECT COALESCE(sum(octet_length(to_jsonb(page)::text)),0)::bigint AS bytes FROM page`,[lastId,LIMITS.page])).rows[0];
    if(Number(budget.bytes)>LIMITS.inputPageBytes)limit('input_page_bytes');
    const rows=(await client.query(`SELECT p.*,i.public_sku,to_jsonb(i) AS identity_evidence,to_jsonb(s) AS export_state
      FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN product_full_export_state s ON s.product_id=p.id
      WHERE p.id>$1 AND p.status='active' AND p.corrected_to_product_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=p.public_product_identity_id)
      ORDER BY p.id LIMIT $2`,[lastId,LIMITS.page])).rows;
    if(!rows.length)break;
    total+=rows.length;if(total>LIMITS.products)limit('product_count');
    const ids=rows.map(p=>p.public_product_identity_id);
    const schemaIds=[...new Set(rows.map(p=>p.sku_schema_version_id).filter(Boolean))];
    const schemaBudget=(await client.query(`SELECT COALESCE(sum(bytes),0)::bigint AS bytes FROM (
      SELECT octet_length(to_jsonb(q)::text)+128 AS bytes FROM sku_schema_questions q WHERE q.schema_version_id=ANY($1::int[])
      UNION ALL SELECT octet_length(to_jsonb(o)::text)+128 FROM sku_schema_options o JOIN sku_schema_questions q ON q.id=o.schema_question_id
        WHERE q.schema_version_id=ANY($1::int[])) v`,[schemaIds])).rows[0];
    if(Number(schemaBudget.bytes)>LIMITS.inputPageBytes)limit('schema_page_bytes');
    const states=(await client.query(`SELECT * FROM magento_name_sync_states WHERE origin_hash=$1
      AND public_product_identity_id=ANY($2::bigint[]) ORDER BY public_product_identity_id`,[local.draft.originHash,ids])).rows;
    const pins=local.current?(await client.query(`SELECT * FROM magento_binding_name_pins WHERE binding_revision_id=$1
      AND product_id=ANY($2::int[]) ORDER BY product_id`,[local.current.id,rows.map(p=>p.id)])).rows:[];
    const next=await loadSupportInputs(client,local.next.compiled.definition,rows.map(p=>({...p})));
    const old=local.old?await loadSupportInputs(client,local.old.compiled.definition,rows.map(p=>({...p}))):{products:[],schemas:[]};
    const bytes=size({rows,states,pins,nextSchemas:next.schemas,oldSchemas:old.schemas});
    if(bytes>LIMITS.inputPageBytes)limit('input_page_bytes');inputBytes+=bytes;maxPageBytes=Math.max(maxPageBytes,bytes);
    const stateMap=new Map(states.map(s=>[String(s.public_product_identity_id),s]));
    const pinMap=new Map(pins.map(p=>[p.product_id,p]));
    const schemaHashes=new Map([...old.schemas,...next.schemas].map(s=>[s.id,c.hash(s)]));
    for(const row of rows){
      digest.update(c.hash(JSON.parse(JSON.stringify({product:row,nameState:nameStateEvidence(stateMap.get(String(row.public_product_identity_id))),
        pin:pinMap.get(row.id) || null,schemaHash:schemaHashes.get(row.sku_schema_version_id) || null}))));
    }
    const prepare=(products,preserve)=>products.map(p=>{
      p.exportState=p.export_state?{...p.export_state,independentExclusion:p.export_state.evidence?.independentExclusion}:null;
      const pin=preserve && pinMap.get(p.id);if(pin)p.magento_name_rule_pin={generated:pin.generated,values:pin.effective_names};return p;
    });
    if(onPage)await onPage({...local,states,oldProducts:prepare(old.products,true),nextProducts:prepare(next.products,false)});
    checkDeadline(deadline);lastId=rows.at(-1).id;
  }
  digest.update(`\ncount:${total}`);checkDeadline(deadline);
  return {localHash:digest.digest('hex'),totalProducts:total,inputBytes,maxPageBytes};
}
module.exports={LIMITS,scan,limit,checkDeadline,checkEvidence,translateLimit};
