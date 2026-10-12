const c=require('./binding-contract');
const proofs=new WeakMap();
const targets=new Set(['meta_title','meta_description']);
const keys=['target','scope','state','before','remote','after','source','mappingHash'];
const clean=f=>Object.fromEntries(keys.map(k=>[k,f[k]]));
const key=f=>f.scope+'/'+f.target;
const text=value=>typeof value==='string' && value.trim()!=='' && value.length<=4096 && !/[\u0000-\u001f\u007f]/.test(value);
function validSeoLocal(field) {
  return targets.has(field.target) && ['all','en'].includes(field.scope) && field.type==='text'
    && field.local?.known===true && field.local.present===true && text(field.local.value)
    && field.remote?.known===true && (field.remote.present===true ? text(field.remote.value)
      : field.remote.present===false && (field.remote.value==null || typeof field.remote.value==='string' && field.remote.value.trim()===''));
}
function selectable(field,meta,result) {
  if(field.kind!=='derived' || result.reason!=='DERIVED_FORWARD_MISMATCH'
    || !field.mapping?.proven || !field.prospective?.verified || meta.reason || meta.readReason
    || meta.outwardPolicy!=='authoritative_create_update')return false;
  if(validSeoLocal(field))return true;
  const price=require('./first-sync-field-plan').normalizeDecimal(field.local?.value,2);
  return field.target==='price' && field.scope==='all' && field.type==='decimal' && field.unit==='UAH'
    && meta.canonicalLocalPriceProven===true
    && field.scale===2 && field.local.known && field.local.present && field.remote.known
    && price!==null && price!=='0' && !price.startsWith('-');
}
function mint(inspection,choices) {
  const changed=inspection.prepared.rows.filter(r=>r.record.source?.seoAuthorityChange);
  if(!changed.length)return undefined;
  const token=Object.freeze({}),o=inspection.observation;
  for(const row of changed) {
    const field=inspection.projection.fields.find(f=>key(f)===key(row));
    if(!choices.some(d=>key(d)===key(row)&&d.choice==='keep_local') || !validSeoLocal(field||{})
      || row.record.state!=='pending_outward_confirmation' || row.record.after!==row.local.value)
      throw c.error(409,'MAGENTO_FIRST_SYNC_SEO_AUTHORITY_UNPROVEN','Потрібне явне актуальне рішення щодо SEO.');
  }
  proofs.set(token,{key:inspection.first.key,sessionId:inspection.first.progress.session.id,
    fields:changed.map(r=>clean(r.record)).sort((a,b)=>key(a).localeCompare(key(b),'en')),productId:o.amber.product.id});
  return token;
}
async function validate(client,token,command,current) {
  const proof=proofs.get(token),changed=command.fields.filter(f=>f.source?.seoAuthorityChange)
    .sort((a,b)=>key(a).localeCompare(key(b),'en'));
  const fail=()=>{throw c.error(409,'FIRST_SYNC_LEDGER_SEO_AUTHORITY','Перехід SEO потребує перевіреного рішення адміністратора.');};
  if(!changed.length)return new Set();
  if(!proof || c.hash(proof.key)!==c.hash(command.key) || proof.sessionId!==current?.session.id
    || c.hash(proof.fields)!==c.hash(changed) || current.session.completed_at)fail();
  const protectedWork=(await client.query(`SELECT EXISTS(SELECT 1 FROM magento_sync_jobs j
    WHERE j.origin_hash=$1 AND j.public_product_identity_id=$2 AND
      (j.state NOT IN ('succeeded','superseded') OR EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id))) AS protected`,
  [command.key.originHash,command.key.publicIdentityId])).rows[0];
  if(protectedWork?.protected)fail();
  for(const field of changed) {
    const prior=current.fields.find(f=>key(f)===key(field)),ref=field.source.seoAuthorityChange;
    if(!prior || prior.state!=='seo_pending_initial_readback' || ref.revision!==prior.revision
      || c.hash(ref.evidence)!==c.hash(clean(prior)) || field.mappingHash!==prior.mappingHash
      || field.source.bindingRevisionId!==prior.source.bindingRevisionId)fail();
  }
  return new Set(changed.map(key));
}
module.exports={validSeoLocal,selectable,mint,validate};
