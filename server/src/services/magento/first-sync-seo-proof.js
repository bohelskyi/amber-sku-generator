const c = require('./binding-contract');
const PENDING = 'seo_pending_initial_readback', RECEIVED = 'seo_received', CONTRACT = 'nm-first-sync-seo-v1';
const proofs = new WeakMap();
const key = f => f.scope + '/' + f.target;
const record = f => Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,f[k]]));
const target = f => ['meta_title','meta_description'].includes(f?.target) && ['all','en'].includes(f?.scope);
const valid = v => typeof v==='string' && v.trim()!=='' && v.length<=4096 && !/[\u0000-\u001f\u007f]/.test(v);
const fail = () => { throw c.error(409,'MAGENTO_FIRST_SYNC_SEO_RECEIPT_CHANGED','SEO першої синхронізації потребує актуальної перевірки.'); };
function identity(o) {
  const {product,revision,compiled}=o.amber;
  return {productId:product.id,identityId:String(product.public_product_identity_id),sku:product.public_sku,
    remoteId:o.raw?.id,bindingId:revision.id,definitionHash:compiled.hash,installationKey:revision.installationKey,originHash:revision.originHash};
}
function value(o,f) {
  if(f.scope==='all') {
    const entries=o.raw?.custom_attributes?.filter(a=>a.attribute_code===f.target);
    return entries?.length===1 ? entries[0].value : undefined;
  }
  const en=o.domainEvidence?.english;
  if(en?.id!==o.raw?.id || en?.sku!==o.raw?.sku
    || o.domainEvidence?.failures?.some(f=>f.domain==='storeViews'||f.operation==='storeViews')) return undefined;
  return en.fields?.[f.target];
}
function snapshot(o,fields) {
  const p=o?.amber?.product,raw=o?.raw;
  if(!p || p.category!=='NM' || !raw || !Number.isSafeInteger(raw.id) || raw.id<=0 || raw.sku!==p.public_sku
    || !o.amber.revision || !o.amber.compiled || !Array.isArray(fields) || !fields.length || fields.length>4) return null;
  const i=identity(o);
  if(!Object.values(i).every(v=>v!==undefined&&v!==null) || new Set(fields.map(key)).size!==fields.length) return null;
  for(const f of fields) {
    if(!target(f) || !valid(f.after) || value(o,f)!==f.after
      || f.source?.productId!==p.id || f.source.bindingRevisionId!==i.bindingId || f.source.definitionHash!==i.definitionHash) return null;
    const attr=o.schema?.attributes?.find(a=>a.attribute_code===f.target), pinned=o.amber.revision.schema?.attributes?.find(a=>a.attribute_code===f.target);
    if(!attr || !pinned || attr.attribute_id!==pinned.attribute_id || !['text','textarea'].includes(attr.frontend_input)
      || attr.frontend_input!==pinned.frontend_input || f.scope==='en'&&attr.scope!=='store') return null;
  }
  return c.hash({identity:i,schema:o.schema,fields:fields.map(f=>({target:f.target,scope:f.scope,value:value(o,f)}))});
}
function jobHash(job) {
  return job ? c.hash({id:job.id,productId:job.product_id,identityId:String(job.public_product_identity_id),sku:job.sku,
    bindingId:job.binding_revision_id,originHash:job.origin_hash,installationKey:job.installation_key,
    intent:job.intent,baseline:job.baseline,planHash:job.plan_hash}) : null;
}
function mint(o,fields,job=null) {
  const digest=snapshot(o,fields);if(!digest) return null;
  const token=Object.freeze({});proofs.set(token,{digest,identity:identity(o),fields:fields.map(f=>record(f)),job:jobHash(job)});return token;
}
function sourceValid(f) {
  return f.source?.kind==='seo_snapshot' && f.source.category==='NM' && f.source.seoContract===CONTRACT
    && f.source.field===f.target && f.remote?.known===true && f.remote.present===true && f.remote.value===f.after;
}
function issue(o,prepared,projection) {
  if(!prepared?.readyForOutbound || prepared.blockers?.length || !Array.isArray(prepared.rows)) return null;
  const fields=prepared.rows.filter(row=>target(row) && (row.record?.state===PENDING
    || row.record?.state==='equal' && row.record.remote?.known===true && row.record.remote.present===true)).map(row=>row.record);
  if(!fields.some(f=>f.state===PENDING) || fields.some(f=>f.state===PENDING&&!sourceValid(f))) return null;
  if(fields.some(f=>!projection?.projection?.some(m=>key(m)===key(f)&&m.persistence==='seo_snapshot'&&!m.reason&&!m.readReason))) return null;
  return mint(o,fields);
}
function allows(o,token,job=null) {
  const p=proofs.get(token);return !!p && p.digest===snapshot(o,p.fields) && p.job===jobHash(job);
}
function fieldsFor(o,token,{job=null,freshObservation=null}={}) {
  if(!allows(freshObservation||o,token,job)) return [];
  const p=proofs.get(token);
  if(freshObservation && snapshot(o,p.fields)!==p.digest) return [];
  return p.fields.map(({target,scope})=>({target,scope}));
}
function assertProgress(progress,token,job=null) {
  const p=proofs.get(token);if(!p || !progress || progress.session.public_sku!==p.identity.sku
    || Number(progress.session.remote_product_id)!==p.identity.remoteId || progress.session.installation_key!==p.identity.installationKey
    || progress.session.origin_hash!==p.identity.originHash || String(progress.session.public_product_identity_id)!==p.identity.identityId
    || p.sessionId && progress.session.id!==p.sessionId
    || p.initialRevision && BigInt(progress.session.revision)<BigInt(p.initialRevision)
    || p.job!==jobHash(job)) fail();
  for(const f of p.fields) {
    const current=progress.fields.find(x=>key(x)===key(f));if(!current) fail();
    const copy=record(current);
    if(copy.state===RECEIVED && f.state===PENDING) {
      if(!job || copy.source.seoDelivery?.jobId!==job.id || copy.source.seoDelivery.planHash!==job.plan_hash) fail();
      copy.state=PENDING;copy.source={...copy.source};delete copy.source.seoDelivery;
    }
    if(c.hash(copy)!==c.hash(f)) fail();
  }
}
function baselineReceipt(o,token,progress) {
  if(!allows(o,token)) fail();assertProgress(progress,token);
  const p=proofs.get(token);p.sessionId=progress.session.id;p.initialRevision=progress.session.revision;
  return {sessionId:progress.session.id,revision:progress.session.revision,identityHash:c.hash(identity(o)),schemaHash:c.hash(o.schema),
    fields:proofs.get(token).fields.map(f=>({target:f.target,scope:f.scope,valueHash:c.hash(f.after),mappingHash:f.mappingHash}))};
}
function restore({observation:o,job,progress,command}) {
  try {
    const ref=job?.baseline?.firstSyncSeo;
    if(!ref || ref.sessionId!==progress?.session.id || !/^[1-9][0-9]{0,18}$/.test(ref.revision)
      || ref.identityHash!==c.hash(identity(o)) || ref.schemaHash!==c.hash(o.schema) || job.intent?.mode!=='update'
      || job.product_id!==o.amber.product.id || String(job.public_product_identity_id)!==String(o.amber.product.public_product_identity_id)
      || job.sku!==o.raw?.sku || job.binding_revision_id!==o.amber.revision.id || job.origin_hash!==o.amber.revision.originHash
      || job.installation_key!==o.amber.revision.installationKey || job.baseline.raw?.id!==o.raw?.id
      || !Array.isArray(ref.fields) || ref.fields.length<1 || ref.fields.length>4
      || !Array.isArray(command?.fields) || command.key?.originHash!==job.origin_hash
      || command.key?.publicIdentityId!==String(job.public_product_identity_id)) return null;
    const fields=ref.fields.map(r=>{
      const f=command.fields.find(f=>key(f)===key(r));
      if(!f || !target(f) || r.valueHash!==c.hash(f.after) || r.mappingHash!==f.mappingHash
        || ![PENDING,'equal'].includes(f.state) || f.state===PENDING&&!sourceValid(f)
        || f.state==='equal'&&(!f.remote?.known||!f.remote.present||f.remote.value!==f.after)) throw new Error('Invalid SEO reference');
      const operation=job.intent.operations.find(op=>op.domain===(f.scope==='all'?'coreProduct':'storeViews'));
      if(operation?.payload?.product?.custom_attributes?.some(a=>a.attribute_code===f.target)
        || f.scope==='en'&&Object.hasOwn(job.intent.englishValues||{},f.target)) throw new Error('SEO was included');
      return f;
    });
    if(!fields.some(f=>f.state===PENDING)) return null;
    const token=mint(o,fields,job);
    if(token) {const p=proofs.get(token);p.sessionId=ref.sessionId;p.initialRevision=ref.revision;assertProgress(progress,token,job);}
    return token;
  } catch { return null; }
}
function receivedFields(progress,token,job) {
  const p=proofs.get(token);if(!p?.job || p.job!==jobHash(job)) fail();
  assertProgress(progress,token,job);const accepted=new Set(p.fields.filter(f=>f.state===PENDING).map(key));
  return progress.fields.map(f=>{
    const r=record(f);return accepted.has(key(f))&&f.state===PENDING ? {...r,state:RECEIVED,
      source:{...r.source,seoDelivery:{jobId:job.id,planHash:job.plan_hash}}} : r;
  });
}
module.exports={PENDING,RECEIVED,CONTRACT,target,valid,issue,allows,fieldsFor,assertProgress,baselineReceipt,restore,receivedFields};
