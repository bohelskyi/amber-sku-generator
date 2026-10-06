const { Pool } = require('pg');
const photos = require('../product-photos.service');
const { hash, originHash } = require('./binding-contract');
const { validateBaseUrl } = require('../../config/magento');
const { signProductMediaRequest, signGetRequest, percentEncode } = require('./oauth');
const { readJson, createMagentoClient } = require('./client');
const access = require('../access-admin-transaction');
const gate = require('../full-product-cutover-gate');
const { writeAuditEvent } = require('../../audit/audit-events');

const fail = (code) => { throw photos.error(409,code,'Передавання фото потребує перевірки.'); };
const positive = (id) => Number.isSafeInteger(Number(id)) && Number(id)>0;
function validSku(sku) {
  if (typeof sku!=='string' || !sku.trim() || sku.length>256 || ['.','..'].includes(sku) || /[\u0000-\u001f\u007f]/.test(sku)) return false;
  try {percentEncode(sku);return true;} catch{return false;}
}
const label = (asset) => `amber:${asset.id}:${asset.content_hash}`;
const roles = (position) => position===1 ? ['image','small_image','thumbnail'] : [];
function metadata(asset, position, disabled=false) {
  return {media_type:'image',label:label(asset),position,disabled,types:disabled ? [] : roles(position)};
}
function matchesMetadata(entry, expected) {
  return entry?.media_type==='image' && entry.label===expected.label && Number(entry.position)===expected.position
    && entry.disabled===expected.disabled && Array.isArray(entry.types)
    && JSON.stringify([...entry.types].sort())===JSON.stringify([...expected.types].sort());
}
function preserved(raw) {
  const excluded=new Set(['status','updated_at','media_gallery_entries','custom_attributes']);
  return hash({ ...Object.fromEntries(Object.entries(raw).filter(([key])=>!excluded.has(key))),
    custom_attributes:(raw.custom_attributes || []).filter((a)=>!['image','small_image','thumbnail','swatch_image'].includes(a.attribute_code))
      .sort((a,b)=>a.attribute_code.localeCompare(b.attribute_code)) });
}
// Magento gallery saves add role defaults and primary-image labels. Retain the
// original full preservation hash; accept these effects only with sealed dispatch
// and exact owned metadata/original-byte proof, never by excluding these fields.
const MEDIA_SIDE_EFFECTS=Object.freeze(['image_label','small_image_label','thumbnail_label','hover_image','listing_video','content_video']);
const PRIMARY_LABELS=MEDIA_SIDE_EFFECTS.slice(0,3);
const mediaAttribute=(raw,code)=>{
  const values=(raw.custom_attributes || []).filter((a)=>a.attribute_code===code);
  if(values.length>1)fail('PHOTO_REMOTE_CHANGED');
  const value=values[0];
  if(value && (Object.keys(value).length!==2 || !Object.hasOwn(value,'value')
    || (value.value!==null && (typeof value.value!=='string' || value.value.length>512))))fail('PHOTO_REMOTE_CHANGED');
  return value;
};
function capturePreservation(raw) {
  const mediaSideEffects=Object.fromEntries(MEDIA_SIDE_EFFECTS.map((code)=>{
    const attribute=mediaAttribute(raw,code);
    return [code,attribute ? {present:true,value:attribute.value} : {present:false}];
  }));
  return {version:2,hash:preserved(raw),mediaSideEffects};
}
function validatePreservation(preservation) {
  if(!preservation || !/^[a-f0-9]{64}$/.test(preservation.hash || ''))fail('PHOTO_REMOTE_CHANGED');
  if(preservation.version===undefined) {
    if(Object.keys(preservation).length!==1)fail('PHOTO_REMOTE_CHANGED');
    return;
  }
  if(preservation.version!==2 || Object.keys(preservation).length!==3
    || !preservation.mediaSideEffects || Array.isArray(preservation.mediaSideEffects)
    || Object.keys(preservation.mediaSideEffects).length!==MEDIA_SIDE_EFFECTS.length
    || MEDIA_SIDE_EFFECTS.some((code)=>!Object.hasOwn(preservation.mediaSideEffects,code)))fail('PHOTO_REMOTE_CHANGED');
  for(const code of MEDIA_SIDE_EFFECTS) {
    const value=preservation.mediaSideEffects[code];
    if(!value || typeof value.present!=='boolean' || Object.keys(value).length!==(value.present ? 2 : 1)
      || (value.present && (!Object.hasOwn(value,'value') || (value.value!==null
        && (typeof value.value!=='string' || value.value.length>512)))))fail('PHOTO_REMOTE_CHANGED');
  }
}
function preservationCandidate(raw,preservation,primaryLabel) {
  validatePreservation(preservation);
  if(preserved(raw)===preservation.hash)return {unchanged:true};
  const observed=Object.fromEntries(MEDIA_SIDE_EFFECTS.map((code)=>[code,mediaAttribute(raw,code)]));
  const reconstruct=(snapshot)=>({...raw,custom_attributes:[
    ...(raw.custom_attributes || []).filter((a)=>!MEDIA_SIDE_EFFECTS.includes(a.attribute_code)),
    ...MEDIA_SIDE_EFFECTS.filter((code)=>snapshot[code].present).map((code)=>({attribute_code:code,value:snapshot[code].value})),
  ]});
  if(preservation.version===2) {
    const snapshot=preservation.mediaSideEffects;const changed=[];
    for(const code of MEDIA_SIDE_EFFECTS) {
      const prior=snapshot[code];const current=observed[code];
      if(prior.present===Boolean(current) && (!current || prior.value===current.value))continue;
      if(PRIMARY_LABELS.includes(code)) {
        if(primaryLabel===null) {
          if(current && current.value!==null && current.value!=='')return null;
        } else if(!current || current.value!==primaryLabel)return null;
      } else if(prior.present || !current || current.value!=='no_selection')return null;
      changed.push(code);
    }
    return changed.length && preserved(reconstruct(snapshot))===preservation.hash ? {changed} : null;
  }
  // Legacy hash-only evidence can prove prior ABSENCE only. The finite closed
  // search never guesses existing values or changes the immutable original hash.
  const removable=MEDIA_SIDE_EFFECTS.filter((code)=>observed[code]
    && observed[code].value===(PRIMARY_LABELS.includes(code) ? primaryLabel : 'no_selection'));
  let matched=null;
  for(let mask=1;mask<(1<<removable.length);mask++) {
    const changed=removable.filter((_code,index)=>mask&(1<<index));
    const candidate={...raw,custom_attributes:(raw.custom_attributes || []).filter((a)=>!changed.includes(a.attribute_code))};
    if(preserved(candidate)!==preservation.hash)continue;
    if(matched)return null;
    matched={changed};
  }
  return matched;
}
function createMediaTransport(config,{fetchImpl=globalThis.fetch}={}) {
  if (!config?.configured) fail('PHOTO_MAGENTO_NOT_CONFIGURED');
  const credentials={...config}; const base=validateBaseUrl(credentials.baseUrl);
  const client=createMagentoClient(credentials,{fetchImpl});
  async function request(sku,method,kind,entryId,body) {
    if (!validSku(sku) || !['product','media','entry'].includes(kind)
      || (kind==='entry' && !positive(entryId))) fail('PHOTO_TARGET_INVALID');
    const endpoint=`products/${percentEncode(sku)}${kind==='product' ? '' : `/media${kind==='entry' ? `/${entryId}` : ''}`}`;
    const url=`${base}/rest/all/V1/${endpoint}`;
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),30000); let response;
    try {
      response=await fetchImpl(url,{method,redirect:'manual',signal:controller.signal,
        headers:{Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {}),
          Authorization:method==='GET' ? signGetRequest(url,credentials) : signProductMediaRequest(url,credentials,method,undefined,sku)},
        ...(body ? {body:JSON.stringify(body)} : {})});
      if (!response.ok) fail(method==='GET' ? 'PHOTO_REMOTE_READ_FAILED' : 'PHOTO_MUTATION_UNCERTAIN');
      return await readJson(response);
    } catch (cause) {
      if (cause.code?.startsWith('PHOTO_')) throw cause;
      fail(method==='GET' ? 'PHOTO_REMOTE_READ_FAILED' : 'PHOTO_MUTATION_UNCERTAIN');
    } finally {
      controller.abort(); clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(()=>{});
    }
  }
  async function originalFile(file) {
    // Magento 2.4.6 entry GET has metadata only. Original files are public reads,
    // confined to this configured origin; OAuth credentials never reach media/CDNs.
    if (typeof file!=='string' || file.length>512 || !file.startsWith('/')
      || file.slice(1).split('/').some((part)=>!part || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,159}$/.test(part))
      || !/\.(png|jpe?g)$/i.test(file)) fail('PHOTO_REMOTE_FILE_INVALID');
    const url=`${base}/media/catalog/product${file}`;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);let response;
    try {
      response=await fetchImpl(url,{method:'GET',redirect:'manual',signal:controller.signal,
        headers:{Accept:'image/jpeg,image/png','Cache-Control':'no-cache'}});
      if (!response.ok || !response.body) fail('PHOTO_REMOTE_READ_FAILED');
      const chunks=[];let length=0;
      for await(const chunk of response.body){length+=chunk.byteLength;if(length>photos.MAX_STORED_PHOTO_BYTES)fail('PHOTO_REMOTE_READ_FAILED');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);
      if(bytes.length<32)fail('PHOTO_REMOTE_READ_FAILED');
      return {base64_encoded_data:bytes.toString('base64'),type:photos.imageType(bytes),name:file.split('/').at(-1)};
    }catch{fail('PHOTO_REMOTE_READ_FAILED');}
    finally{controller.abort();clearTimeout(timer);if(response?.body && !response.body.locked)await response.body.cancel().catch(()=>{});}
  }
  async function entry(sku,id) {
    const value=await request(sku,'GET','entry',id);
    if(!value || typeof value!=='object' || Number(value.id)!==Number(id))fail('PHOTO_REMOTE_READ_FAILED');
    if(value.content?.base64_encoded_data===undefined)value.content=await originalFile(value.file);
    return value;
  }
  return Object.freeze({
    product:(sku)=>client.findProductBySku(sku),
    entry,
    upload:(sku,asset,position)=>request(sku,'POST','media',null,{entry:{...metadata(asset,position),content:{
      base64_encoded_data:asset.content.toString('base64'),type:asset.mime_type,name:`amber_${asset.id}_${asset.content_hash}.${asset.mime_type==='image/png' ? 'png' : 'jpg'}`}}}),
    update:(sku,id,expected)=>request(sku,'PUT','entry',id,{entry:{id:Number(id),...expected}}),
    status:(sku,status)=>{
      if (![1,2].includes(status)) fail('PHOTO_STATUS_INVALID');
      return request(sku,'PUT','product',null,{product:{sku,status}});
    },
  });
}
async function verifyAsset(transport,sku,raw,asset,expected) {
  const matches=(raw.media_gallery_entries || []).filter((e)=>e.label===label(asset));
  if (matches.length!==1 || !positive(matches[0].id)) return null;
  const entry=await transport.entry(sku,matches[0].id);
  if (Number(entry.id)!==Number(matches[0].id) || !matchesMetadata(entry,expected)
    || entry.content?.type!==asset.mime_type || photos.sha(photos.decodeBase64(entry.content?.base64_encoded_data,photos.MAX_STORED_PHOTO_BYTES))!==asset.content_hash) return null;
  return Number(entry.id);
}
async function shortTransaction(db,operation) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);
    await gate.enterExisting(client);
    const result=await operation(client); await gate.commit(client); return result;
  } catch (cause) { await gate.rollback(client).catch(()=>{}); throw cause; }
  finally { await gate.release(client).catch(()=>{}); client.release(); }
}
async function authorize(client,config,job) {
  await access.assertActorStillAuthorized(client,Number(job.actor_user_id),job.required_permission,photos.error);
  const activation=(await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton FOR SHARE')).rows[0];
  if (!activation?.enabled) fail('PHOTO_AUTO_DISABLED');
  await access.assertActorStillAuthorized(client,Number(activation.actor_user_id),'export_templates.publish',photos.error);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${activation.installation_key}`]);
  const binding=(await client.query(`SELECT id,origin_hash FROM magento_binding_revisions WHERE installation_key=$1
    AND state='published' ORDER BY version_number DESC LIMIT 1`,[activation.installation_key])).rows[0];
  if (!binding || binding.origin_hash!==originHash(config.baseUrl) || (job.binding_revision_id && binding.id!==job.binding_revision_id)
    || (job.origin_hash && job.origin_hash!==binding.origin_hash)) fail('PHOTO_BINDING_CHANGED');
  const product=(await client.query(`SELECT p.id,p.public_product_identity_id,p.status,p.corrected_to_product_id,i.public_sku,COALESCE((to_jsonb(i)->>'is_test_product')::boolean,FALSE) AS is_test_product
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1 FOR NO KEY UPDATE OF p`,[job.product_id])).rows[0];
  if (!product || String(product.public_product_identity_id)!==String(job.public_product_identity_id)
    || product.status!=='active' || product.corrected_to_product_id!==null || !validSku(product.public_sku)) fail('PHOTO_PRODUCT_NOT_CURRENT');
  const lifecycle=(await client.query('SELECT route,business_exclusion_state,recount_compatibility_excluded FROM product_full_export_state WHERE product_id=$1 FOR NO KEY UPDATE',[job.product_id])).rows[0];
  if (!lifecycle || lifecycle.route!=='normal' || lifecycle.business_exclusion_state!=='none' || lifecycle.recount_compatibility_excluded) fail('PHOTO_PRODUCT_NOT_SENDABLE');
  if ((await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',[job.public_product_identity_id])).rowCount) fail('PHOTO_PRODUCT_DELETION');
  require('../product/test-products').assertDisabled(product, null, job.enable_when_verified);
  const set=(await client.query('SELECT version,photo_ids,enable_when_verified FROM product_photo_sets WHERE product_id=$1',[job.product_id])).rows[0];
  if (!set || set.version!==job.version || photos.mediaIntent(product,job.version,set.photo_ids,set.enable_when_verified)!==job.intent_hash) fail('PHOTO_INTENT_CHANGED');
  const native=(await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR SHARE',[job.public_product_identity_id])).rows[0];
  if (!native || Number(native.product_id)!==Number(job.product_id) || native.state!=='synced'
    || native.synced_generation!==native.desired_generation) fail('PHOTO_NATIVE_SYNC_REQUIRED');
  if (job.native_generation && job.native_generation!==native.synced_generation) fail('PHOTO_NATIVE_GENERATION_CHANGED');
  const proof=(await client.query(`SELECT remote_product_id FROM magento_sync_jobs WHERE public_product_identity_id=$1
    AND product_id=$2 AND state='succeeded' AND automatic_generation=$3 AND origin_hash=$4
    AND acknowledged_at IS NOT NULL ORDER BY acknowledged_at DESC,created_at DESC LIMIT 1`,
  [job.public_product_identity_id,job.product_id,native.synced_generation,binding.origin_hash])).rows[0];
  if (!positive(proof?.remote_product_id)) fail('PHOTO_NATIVE_ACK_REQUIRED');
  return {product,binding,generation:native.synced_generation,remoteId:Number(proof.remote_product_id)};
}
async function processJob(config,id,{databasePool:db,fetchImpl,transport:createTransport,readOnly=false,mutationContext}={}) {
  const lane=await db.connect(); let identityLock; let skuLock; let job; let raw;
  let transport; let assets;
  const readJob=async()=>{job=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[id])).rows[0]; if (!job) fail('PHOTO_JOB_NOT_FOUND'); return job;};
  const audit=async(client,event,details={})=>writeAuditEvent(client,{mutationContext:{actorUserId:Number(job.actor_user_id),requestId:mutationContext?.requestId || `media-${id}`},eventKey:`product.media_${event}`,subjectType:'product_media_job',subjectId:id,details});
  let reviewAudited=false;
  const guard=async(operation)=>shortTransaction(db,async(client)=>{
    await readJob();
    if (job.state==='superseded') fail('PHOTO_JOB_SUPERSEDED');
    if (readOnly && mutationContext) {
      const reviewer=Number(mutationContext.actorUserId);
      const required=reviewer===Number(job.actor_user_id) ? job.required_permission : 'products.recount';
      await access.assertActorStillAuthorized(client,reviewer,required,photos.error);
      if (!reviewAudited) {
        await writeAuditEvent(client,{mutationContext,eventKey:'product.media_reconciliation_requested',subjectType:'product_media_job',subjectId:id,details:{productId:Number(job.product_id),version:job.version}});
        reviewAudited=true;
      }
    }
    const state=await authorize(client,config,job); return operation(client,state);
  });
  let sku; let activationDispatched=false;
  const fresh=async()=>{
    const current=await guard(async(_client,value)=>value); raw=await transport.product(sku);
    require('../product/test-products').assertDisabled(current.product, raw);
    if (raw.sku!==sku || Number(raw.id)!==Number(job.remote_product_id)) fail('PHOTO_REMOTE_CHANGED');
    const primary=assets?.find((asset)=>asset.id===job.photo_ids[0]);
    const candidate=preservationCandidate(raw,job.preservation,primary ? label(primary) : null);
    if(!candidate)fail('PHOTO_REMOTE_CHANGED');
    if(!candidate.unchanged) {
      const proveDispatch=async(asset,entry,disabled=false)=>{
        const expected=metadata(asset,disabled ? Number(entry.position) : 1,disabled);
        if(!positive(entry.id) || !matchesMetadata(entry,expected))return false;
        const operations=disabled ? [[`remove:${asset.id}`,{sku,entryId:Number(entry.id),expected}]] : [
          [`upload:${asset.id}`,{sku,assetId:asset.id,hash:asset.content_hash,expected}],
          [`order:${asset.id}`,{sku,entryId:Number(entry.id),expected}],
        ];
        let dispatched=false;
        for(const [stepKey,operation] of operations) {
          const receipt=(await db.query('SELECT * FROM product_media_steps WHERE job_id=$1 AND step_key=$2',[id,stepKey])).rows[0];
          if(receipt && receipt.job_id===id && receipt.step_key===stepKey && receipt.dispatched_at
            && Number.isFinite(new Date(receipt.dispatched_at).getTime()) && receipt.operation_hash===hash(operation)
            && (receipt.remote_entry_id==null || Number(receipt.remote_entry_id)===Number(entry.id)))dispatched=true;
        }
        return dispatched && await verifyAsset(transport,sku,raw,asset,expected)===Number(entry.id);
      };
      if(primary) {
        if(PRIMARY_LABELS.some((code)=>mediaAttribute(raw,code)?.value!==label(primary)))fail('PHOTO_REMOTE_CHANGED');
        const entries=(raw.media_gallery_entries || []).filter((entry)=>entry.label===label(primary));
        if(entries.length!==1 || !await proveDispatch(primary,entries[0]))fail('PHOTO_REMOTE_CHANGED');
      } else {
        // Clearing primary labels is a different deliberate operation. Only v2
        // pinned before-values plus proved same-identity removal can authorize it.
        if(job.preservation.version!==2 || job.photo_ids.length || PRIMARY_LABELS.some((code)=>{
          const current=mediaAttribute(raw,code);return current && current.value!==null && current.value!=='';
        }))fail('PHOTO_REMOTE_CHANGED');
        const owned=(await db.query(`SELECT a.* FROM product_photo_assets a JOIN products p ON p.id=a.product_id
          WHERE p.public_product_identity_id=$1`,[job.public_product_identity_id])).rows;
        const proved=[];
        for(const asset of owned) {
          const entries=(raw.media_gallery_entries || []).filter((entry)=>entry.label===label(asset));
          if(entries.length!==1 || !entries[0].disabled || entries[0].types?.length)continue;
          if(photos.sha(asset.content)!==asset.content_hash || photos.imageType(asset.content)!==asset.mime_type)fail('PHOTO_REMOTE_CHANGED');
          if(await proveDispatch(asset,entries[0],true))proved.push(label(asset));
        }
        if(!proved.length || candidate.changed.filter((code)=>PRIMARY_LABELS.includes(code)).some((code)=>{
          const prior=job.preservation.mediaSideEffects[code];
          return prior.present && prior.value!==null && prior.value!=='' && !proved.includes(prior.value);
        }))fail('PHOTO_REMOTE_CHANGED');
      }
    }
    return raw;
  };
  async function step(key,operation,verify,dispatch) {
    const opHash=hash(operation);
    let receipt=(await db.query('SELECT * FROM product_media_steps WHERE job_id=$1 AND step_key=$2',[id,key])).rows[0];
    if (receipt && receipt.operation_hash!==opHash) fail('PHOTO_STEP_INTEGRITY');
    await fresh(); let result=await verify(raw);
    if (!['hide','enable'].includes(key) && raw.status!==2 && !(activationDispatched && result)) fail('PHOTO_PRODUCT_NOT_HIDDEN');
    if (!result) {
      if (receipt) fail('PHOTO_PREVIOUS_DISPATCH_UNRESOLVED');
      if (readOnly) {
        const unresolved=(await db.query('SELECT 1 FROM product_media_steps WHERE job_id=$1 AND verified_at IS NULL',[id])).rowCount;
        if (!unresolved) await guard(async(client)=>{
          await client.query("UPDATE product_media_jobs SET state='pending',failure_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[id]);
          await audit(client,'reconciled',{nextStep:key});
        });
        return false;
      }
      if(!['hide','enable'].includes(key) && MEDIA_SIDE_EFFECTS.slice(3).some((code)=>{
        const current=mediaAttribute(raw,code);
        return current && current.value!==null && current.value!=='' && current.value!=='no_selection';
      }))fail('PHOTO_REMOTE_CHANGED');
      await guard(async(client)=>{
        await client.query('INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,$2,$3)',[id,key,opHash]);
        await audit(client,'dispatched',{step:key,operationHash:opHash});
      });
      try { await dispatch(); } catch { /* The committed receipt requires GET reconciliation. */ }
      await fresh(); result=await verify(raw);
      if (!result) fail('PHOTO_PREVIOUS_DISPATCH_UNRESOLVED');
      receipt={};
    }
    if (receipt && !receipt.verified_at) await guard(async(client)=>{
      await client.query(`UPDATE product_media_steps SET verified_at=CURRENT_TIMESTAMP,remote_entry_id=$3
        WHERE job_id=$1 AND step_key=$2 AND verified_at IS NULL`,[id,key,typeof result==='number' ? result : null]);
      await audit(client,'verified',{step:key,remoteEntryId:typeof result==='number' ? result : null});
    });
    return true;
  }
  try {
    transport=createTransport || createMediaTransport(config,{fetchImpl});
    await readJob();
    if (['succeeded','superseded'].includes(job.state)) return {jobId:id,state:job.state};
    identityLock=`amber_magento_public_identity:${job.public_product_identity_id}`;
    if (!(await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held',[identityLock])).rows[0].held) return {jobId:id,state:job.state,busy:true};
    const state=await guard(async(_client,value)=>value); sku=state.product.public_sku;
    skuLock=`amber_magento_sync:${originHash(config.baseUrl)}:${sku}`;
    if (!(await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held',[skuLock])).rows[0].held) { skuLock=null; return {jobId:id,state:job.state,busy:true}; }
    raw=await transport.product(sku);
    require('../product/test-products').assertDisabled(state.product, raw);
    if (raw.sku!==sku || Number(raw.id)!==state.remoteId || (job.remote_product_id && Number(job.remote_product_id)!==Number(raw.id))) fail('PHOTO_REMOTE_IDENTITY_CHANGED');
    if (!job.preservation) await guard(async(client,current)=>{
      await client.query(`UPDATE product_media_jobs SET origin_hash=$2,binding_revision_id=$3,remote_product_id=$4,
        native_generation=$5,preservation=$6::jsonb,state='running',updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id,current.binding.origin_hash,current.binding.id,raw.id,current.generation,JSON.stringify(capturePreservation(raw))]);
    });
    await readJob();
    assets=(await db.query(`SELECT a.* FROM product_photo_assets a JOIN products p ON p.id=a.product_id
      WHERE a.id=ANY($1::uuid[]) AND p.public_product_identity_id=$2`,[job.photo_ids,job.public_product_identity_id])).rows;
    if (assets.length!==job.photo_ids.length) fail('PHOTO_ASSETS_CHANGED');
    for (const asset of assets) if (photos.sha(asset.content)!==asset.content_hash || photos.imageType(asset.content)!==asset.mime_type) fail('PHOTO_CONTENT_INTEGRITY');
    const activationReceipt=(await db.query("SELECT * FROM product_media_steps WHERE job_id=$1 AND step_key='enable'",[id])).rows[0];
    activationDispatched=Boolean(activationReceipt);
    if (!activationReceipt) {
      const hidden=await step('hide',{sku,status:2},(value)=>value.status===2,()=>transport.status(sku,2));
      if (!hidden) return {jobId:id,state:job.state,readOnly:true};
    }
    for (let index=0;index<job.photo_ids.length;index++) {
      const asset=assets.find((a)=>a.id===job.photo_ids[index]); const expected=metadata(asset,index+1);
      await fresh();
      const candidates=(raw.media_gallery_entries || []).filter((e)=>e.label===label(asset));
      if (candidates.length>1) fail('PHOTO_REMOTE_DUPLICATE');
      const uploadReceipt=(await db.query('SELECT 1 FROM product_media_steps WHERE job_id=$1 AND step_key=$2',[id,`upload:${asset.id}`])).rowCount;
      if (!candidates.length || uploadReceipt) {
        const verified=await step(`upload:${asset.id}`,{sku,assetId:asset.id,hash:asset.content_hash,expected},
          (value)=>verifyAsset(transport,sku,value,asset,expected),()=>transport.upload(sku,asset,index+1));
        if (!verified) return {jobId:id,state:job.state,readOnly:true};
      } else {
        const entryId=Number(candidates[0].id);
        // Verify exact bytes before using an existing asset; a label alone is not evidence.
        const content=await transport.entry(sku,entryId);
        if (photos.sha(photos.decodeBase64(content.content?.base64_encoded_data,photos.MAX_STORED_PHOTO_BYTES))!==asset.content_hash) fail('PHOTO_REMOTE_CONTENT_CHANGED');
        const verified=await step(`order:${asset.id}`,{sku,entryId,expected},(value)=>verifyAsset(transport,sku,value,asset,expected),()=>transport.update(sku,entryId,expected));
        if (!verified) return {jobId:id,state:job.state,readOnly:true};
      }
    }
    const owned=(await db.query(`SELECT a.id,a.content_hash FROM product_photo_assets a JOIN products p ON p.id=a.product_id
      WHERE p.public_product_identity_id=$1`,[job.public_product_identity_id])).rows;
    await fresh();
    for (const asset of owned.filter((a)=>!job.photo_ids.includes(a.id))) {
      const entries=(raw.media_gallery_entries || []).filter((e)=>e.label===label(asset));
      if (entries.length>1) fail('PHOTO_REMOTE_DUPLICATE');
      if (!entries.length) continue;
      const entryId=Number(entries[0].id); const expected=metadata(asset,Number(entries[0].position),true);
      const verified=await step(`remove:${asset.id}`,{sku,entryId,expected},(value)=>{
        const entry=(value.media_gallery_entries || []).find((e)=>Number(e.id)===entryId); return matchesMetadata(entry,expected);
      },()=>transport.update(sku,entryId,expected));
      if (!verified) return {jobId:id,state:job.state,readOnly:true};
    }
    // A fresh complete verification precedes enabling and follows its dispatch.
    const allPhotos=async()=>{
      await fresh();
      for (let index=0;index<job.photo_ids.length;index++) if (!await verifyAsset(transport,sku,raw,assets.find((a)=>a.id===job.photo_ids[index]),metadata(assets.find((a)=>a.id===job.photo_ids[index]),index+1))) fail('PHOTO_FINAL_VERIFICATION_FAILED');
    };
    await allPhotos();
    if (job.enable_when_verified && job.photo_ids.length) {
      if (!activationReceipt && raw.status!==2) fail('PHOTO_PRODUCT_NOT_HIDDEN');
      const enabled=await step('enable',{sku,status:1,photoIds:job.photo_ids},(value)=>value.status===1,async()=>{
        await allPhotos();
        if (raw.status!==2) fail('PHOTO_PRODUCT_NOT_HIDDEN');
        await guard(async()=>{}); await transport.status(sku,1);
      });
      if (!enabled) return {jobId:id,state:job.state,readOnly:true};
    }
    await allPhotos();
    if (raw.status!==(job.enable_when_verified && job.photo_ids.length ? 1 : 2)) fail('PHOTO_FINAL_STATUS_MISMATCH');
    await guard(async(client)=>{
      await client.query("UPDATE product_media_jobs SET state='succeeded',failure_code=NULL,verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND verified_at IS NULL",[id]);
      await audit(client,'succeeded',{photoIds:job.photo_ids,status:raw.status});
    });
    return {jobId:id,state:'succeeded'};
  } catch (cause) {
    if (!job) throw cause;
    if (job.state==='superseded') return {jobId:id,state:job.state};
    const unresolved=(await db.query('SELECT 1 FROM product_media_steps WHERE job_id=$1 AND verified_at IS NULL',[id])).rowCount>0;
    const code=/^(PHOTO|MAGENTO|ADMIN|EXPORT)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'PHOTO_DELIVERY_FAILED';
    if (code==='PHOTO_NATIVE_SYNC_REQUIRED' && !job.native_generation && !unresolved) return {jobId:id,state:job.state,waitingForProduct:true};
    await shortTransaction(db,async(client)=>{
      await client.query('UPDATE product_media_jobs SET state=$2,failure_code=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND state<>\'succeeded\'',[id,unresolved ? 'uncertain' : 'blocked',code]);
      await audit(client,'attention',{code,reconciliationOnly:unresolved});
    });
    return {jobId:id,state:unresolved ? 'uncertain' : 'blocked',code};
  } finally {
    if (skuLock) await lane.query('SELECT pg_advisory_unlock(hashtext($1))',[skuLock]).catch(()=>{});
    if (identityLock) await lane.query('SELECT pg_advisory_unlock(hashtext($1))',[identityLock]).catch(()=>{});
    lane.release();
  }
}
async function processPending(config,{databasePool:db,fetchImpl,limit=2,shouldStop=()=>false,transport}={}) {
  if (!config?.configured || shouldStop()) return [];
  const enabled=(await db.query('SELECT enabled FROM magento_auto_sync_activation WHERE singleton')).rows[0]?.enabled;
  if (!enabled) return [];
  const rows=(await db.query(`SELECT j.id FROM product_media_jobs j JOIN magento_product_sync_requests n
    ON n.public_product_identity_id=j.public_product_identity_id AND n.product_id=j.product_id
    WHERE j.state IN ('pending','running') AND n.state='synced' AND n.synced_generation=n.desired_generation
    ORDER BY j.created_at LIMIT $1`,[Math.min(2,Math.max(1,Number(limit)||2))])).rows;
  const results=[];
  for (const row of rows) {
    if (shouldStop()) break;
    results.push(await processJob(config,row.id,{databasePool:db,fetchImpl,transport}));
  }
  return results;
}
async function assertCanEnableVisibility(client,productId) {
  const proof=(await client.query(`SELECT s.photo_ids,s.version,j.id AS job_id,j.remote_product_id,n.synced_generation AS native_generation
    FROM product_photo_sets s JOIN product_media_jobs j ON j.product_id=s.product_id AND j.version=s.version
    JOIN products p ON p.id=s.product_id
    JOIN magento_product_sync_requests n ON n.public_product_identity_id=p.public_product_identity_id AND n.product_id=p.id
    WHERE s.product_id=$1 AND s.enable_when_verified=TRUE AND cardinality(s.photo_ids)>0
      AND j.state='succeeded' AND j.verified_at IS NOT NULL AND j.photo_ids=s.photo_ids AND j.enable_when_verified=TRUE
      AND n.state='synced' AND n.synced_generation=n.desired_generation
      AND p.status='active' AND p.corrected_to_product_id IS NULL`,[productId])).rows[0];
  if (!proof) fail('PHOTO_ACTIVATION_PROOF_REQUIRED');
  return {jobId:proof.job_id,version:proof.version,photoIds:proof.photo_ids,remoteProductId:Number(proof.remote_product_id),nativeGeneration:proof.native_generation};
}
async function verifyCurrentPhotoSet(config,productId,{databasePool:db,fetchImpl,expectedProof}={}) {
  const proof=await assertCanEnableVisibility(db,productId);
  if (expectedProof && hash(proof)!==hash(expectedProof)) fail('PHOTO_ACTIVATION_PROOF_CHANGED');
  const product=(await db.query(`SELECT i.public_sku FROM products p JOIN public_product_identities i
    ON i.id=p.public_product_identity_id WHERE p.id=$1`,[productId])).rows[0];
  if (!product?.public_sku) fail('PHOTO_TARGET_INVALID');
  const transport=createMediaTransport(config,{fetchImpl});const raw=await transport.product(product.public_sku);
  if (Number(raw.id)!==proof.remoteProductId || raw.sku!==product.public_sku) fail('PHOTO_REMOTE_IDENTITY_CHANGED');
  const assets=(await db.query(`SELECT a.* FROM product_photo_assets a JOIN products p ON p.id=a.product_id
    JOIN products target ON target.public_product_identity_id=p.public_product_identity_id
    WHERE a.id=ANY($1::uuid[]) AND target.id=$2`,[proof.photoIds,productId])).rows;
  if (assets.length!==proof.photoIds.length) fail('PHOTO_ASSETS_CHANGED');
  for (let index=0;index<proof.photoIds.length;index++) {
    const asset=assets.find((a)=>a.id===proof.photoIds[index]);
    if (!await verifyAsset(transport,product.public_sku,raw,asset,metadata(asset,index+1))) fail('PHOTO_FINAL_VERIFICATION_FAILED');
  }
  if (hash(await assertCanEnableVisibility(db,productId))!==hash(proof)) fail('PHOTO_ACTIVATION_PROOF_CHANGED');
  return {...proof,verifiedAt:new Date().toISOString()};
}
function startMediaRuntime(config,logger) {
  const db=new Pool({...config.databaseOptions,max:3,ssl:config.useSsl ? {rejectUnauthorized:false}:false,
    connectionTimeoutMillis:config.pgConnectTimeoutMs,idleTimeoutMillis:config.pgIdleTimeoutMs,
    query_timeout:config.pgQueryTimeoutMs,statement_timeout:config.pgStatementTimeoutMs});
  db.on('error',()=>logger.error('magento.media.pool_failed',{code:'LOCAL_POOL_FAILURE'}));
  let timer; let active; let stopping=false;
  const loop=()=>{
    timer=null;
    active=processPending(config.magento,{databasePool:db,shouldStop:()=>stopping}).catch(()=>logger.error('magento.media.poll_failed',{code:'LOCAL_MEDIA_FAILURE'}))
      .finally(()=>{active=null;if(!stopping){timer=setTimeout(loop,5000);timer.unref();}});
  };
  timer=setTimeout(loop,5000); timer.unref();
  return {async stop(){stopping=true;clearTimeout(timer);await active;await db.end();}};
}
module.exports={ label,metadata,matchesMetadata,preserved,capturePreservation,preservationCandidate,createMediaTransport,verifyAsset,processJob,processPending,assertCanEnableVisibility,verifyCurrentPhotoSet,startMediaRuntime };
