const { createHash, randomUUID } = require('node:crypto');
const pool = require('../db/pool');
const { PublicHttpError } = require('../http/errors');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const access = require('./access-admin-transaction');
const gate = require('./full-product-cutover-gate');

const MAX_PHOTO_BYTES = 1024 * 1024;
// Previously accepted originals remain immutable and can still be verified.
const MAX_STORED_PHOTO_BYTES = 5 * 1024 * 1024;
// One canonical base64 original plus the bounded JSON metadata envelope.
const MAX_PHOTO_REQUEST_BYTES = 4 * Math.ceil(MAX_PHOTO_BYTES / 3) + 2048;
const MAX_PHOTOS = 8;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const error = (status, code, message) => new PublicHttpError(status, message, { code });
function fail(code, message = 'Некоректні фотографії.', status = 422) { throw error(status, code, message); }
function shape(input,keys) {
  if (!input || Object.getPrototypeOf(input)!==Object.prototype || Object.keys(input).some((key)=>!keys.includes(key))
    || keys.some((key)=>!Object.hasOwn(input,key))) fail('PHOTO_REQUEST_INVALID');
}
function photoIds(value) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS || value.some((id) => typeof id !== 'string' || !UUID.test(id))
    || new Set(value).size !== value.length) fail('PHOTO_SELECTION_INVALID');
  return [...value];
}
function normalizeCreationPhotos(payload = {}) {
  if (payload.enableWhenPhotosVerified !== undefined && typeof payload.enableWhenPhotosVerified !== 'boolean') fail('PHOTO_ENABLE_INVALID');
  const ids = photoIds(payload.photoIds ?? []);
  return { photoIds: ids, enableWhenVerified: ids.length > 0 && payload.enableWhenPhotosVerified === true };
}
function decodeBase64(value, maxBytes = MAX_PHOTO_BYTES) {
  if (typeof value === 'string' && value.length > 4 * Math.ceil(maxBytes / 3)) {
    fail('PHOTO_SIZE_LIMIT_EXCEEDED', 'Фото завелике. Максимум — 1 МіБ (1048576 байтів).', 413);
  }
  if (typeof value !== 'string' || value.length < 44
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('PHOTO_CONTENT_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) fail('PHOTO_SIZE_LIMIT_EXCEEDED', 'Фото завелике. Максимум — 1 МіБ (1048576 байтів).', 413);
  if (bytes.length < 32 || bytes.toString('base64') !== value) fail('PHOTO_SIZE_INVALID');
  return bytes;
}
function imageType(bytes) {
  let width; let height; let type;
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR'
      || bytes.toString('ascii',bytes.length-8,bytes.length-4) !== 'IEND') fail('PHOTO_FORMAT_INVALID');
    width=bytes.readUInt32BE(16); height=bytes.readUInt32BE(20); type='image/png';
  } else if (bytes[0]===255 && bytes[1]===216 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217) {
    let offset=2;
    while (offset+4<bytes.length) {
      if (bytes[offset++]!==255) break;
      while (bytes[offset]===255) offset++;
      if (offset+3>=bytes.length) fail('PHOTO_FORMAT_INVALID');
      const marker=bytes[offset++];
      if (marker===218 || marker===217) break;
      const length=bytes.readUInt16BE(offset);
      if (length<2 || offset+length>bytes.length) fail('PHOTO_FORMAT_INVALID');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length>=8) {
        height=bytes.readUInt16BE(offset+3); width=bytes.readUInt16BE(offset+5); type='image/jpeg'; break;
      }
      offset+=length;
    }
  }
  if (!type || !width || !height || width>12000 || height>12000 || width*height>40000000) fail('PHOTO_FORMAT_INVALID');
  return type;
}
function validateUpload(input) {
  shape(input,['idempotencyKey','name','mimeType','base64']);
  if (!input || typeof input.idempotencyKey !== 'string' || !UUID.test(input.idempotencyKey)) fail('PHOTO_REQUEST_KEY_INVALID');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length>160 || /[\u0000-\u001f\u007f/\\]/.test(input.name)) fail('PHOTO_NAME_INVALID');
  const bytes=decodeBase64(input.base64); const mime=imageType(bytes);
  if (input.mimeType!==mime) fail('PHOTO_TYPE_MISMATCH');
  return { bytes, mime, hash:sha(bytes), name:input.name.trim(), requestKey:input.idempotencyKey };
}
async function assertPhotoActor(client, actor, permissions) {
  for (const permission of permissions) {
    try { await access.assertActorStillAuthorized(client,actor,permission,error); return permission; }
    catch (cause) { if (cause.statusCode!==403) throw cause; }
  }
  fail('INSUFFICIENT_PERMISSION','Немає дозволу змінювати фотографії.',403);
}
async function transaction(options, permissions, operation) {
  const context=createMutationContext(options.mutationContext); const client=await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);
    const permission=await assertPhotoActor(client,context.actorUserId,permissions);
    await gate.enterExisting(client);
    const result=await operation(client,context,permission); await gate.commit(client); return result;
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally { await gate.release(client); client.release(); }
}
async function stage(input, options={}) {
  const upload=validateUpload(input);
  return transaction(options,['products.create','products.recount'],async(client,context)=>{
    const existing=(await client.query('SELECT id,content_hash,mime_type,display_name FROM product_photo_assets WHERE actor_user_id=$1 AND request_key=$2',[context.actorUserId,upload.requestKey])).rows[0];
    if (existing) {
      if (existing.content_hash!==upload.hash || existing.mime_type!==upload.mime || existing.display_name!==upload.name) fail('PHOTO_IDEMPOTENCY_CONFLICT','Цей запит уже містить інше фото.',409);
      return { id:existing.id,name:existing.display_name,mimeType:existing.mime_type,hash:existing.content_hash };
    }
    const quota=(await client.query('SELECT count(*)::int AS count,COALESCE(sum(octet_length(content)),0)::bigint AS bytes FROM product_photo_assets WHERE actor_user_id=$1 AND product_id IS NULL AND expires_at>CURRENT_TIMESTAMP',[context.actorUserId])).rows[0];
    if (quota.count>=24 || Number(quota.bytes)+upload.bytes.length>64*1024*1024) fail('PHOTO_STAGE_QUOTA','Збережіть товар перед додаванням наступних фото.',409);
    const id=randomUUID();
    await client.query(`INSERT INTO product_photo_assets(id,actor_user_id,request_key,content_hash,mime_type,display_name,content)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,context.actorUserId,upload.requestKey,upload.hash,upload.mime,upload.name,upload.bytes]);
    await writeAuditEvent(client,{ mutationContext:context,eventKey:'product.photo_staged',subjectType:'product_photo',subjectId:id,details:{hash:upload.hash,mimeType:upload.mime,bytes:upload.bytes.length} });
    return { id,name:upload.name,mimeType:upload.mime,hash:upload.hash };
  });
}
async function lockProduct(client,id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id)<=0) fail('PHOTO_PRODUCT_INVALID');
  const product=(await client.query(`SELECT p.id,p.public_product_identity_id,p.status,p.corrected_to_product_id,i.public_sku,COALESCE((to_jsonb(i)->>'is_test_product')::boolean,FALSE) AS is_test_product
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1 FOR NO KEY UPDATE OF p`,[id])).rows[0];
  if (!product || product.status!=='active' || product.corrected_to_product_id!==null) fail('PHOTO_PRODUCT_NOT_CURRENT','Товар більше не є активним.',409);
  if ((await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rowCount) fail('PHOTO_PRODUCT_DELETION','Товар готується до видалення.',409);
  return product;
}
function mediaIntent(product,version,ids,enable) {
  return sha(JSON.stringify({productId:String(product.id),publicIdentityId:String(product.public_product_identity_id),version:String(version),photoIds:ids,enableWhenVerified:enable}));
}
async function attach(client, productId, input, context, permission, expectedVersion) {
  const ids=photoIds(input.photoIds);
  if (typeof input.enableWhenVerified!=='boolean') fail('PHOTO_ENABLE_INVALID');
  const product=await lockProduct(client,productId);
  require('./product/test-products').assertDisabled(product, null, input.enableWhenVerified);
  // Both lifecycle writers and photo writes hold the access/lifecycle fence and
  // this product row lock. Preserve the prior deliberate visibility authority.
  if ((await client.query(`SELECT 1 FROM product_visibility_intents WHERE public_product_identity_id=$1
    AND state IN ('queued','dispatched') LIMIT 1 FOR SHARE`,[product.public_product_identity_id])).rowCount) {
    fail('PHOTO_VISIBILITY_UNRESOLVED','Спочатку дочекайтеся завершення зміни видимості товару в Magento або перевірте її результат.',409);
  }
  const current=(await client.query('SELECT * FROM product_photo_sets WHERE product_id=$1 FOR UPDATE',[productId])).rows[0];
  if (expectedVersion!==undefined && String(expectedVersion)!==String(current?.version ?? 0)) fail('PHOTO_VERSION_CONFLICT','Фото змінилися. Оновіть товар перед збереженням.',409);
  if ((await client.query("SELECT 1 FROM product_media_jobs WHERE product_id=$1 AND state NOT IN ('succeeded','superseded')",[productId])).rowCount) fail('PHOTO_DELIVERY_UNRESOLVED','Спершу перевірте попереднє передавання фото.',409);
  const assets=(await client.query(`SELECT a.id,a.actor_user_id,a.product_id,p.public_product_identity_id FROM product_photo_assets a
    LEFT JOIN products p ON p.id=a.product_id WHERE a.id=ANY($1::uuid[])
    AND (a.product_id IS NOT NULL OR a.expires_at>CURRENT_TIMESTAMP) ORDER BY a.id FOR UPDATE OF a`,[ids])).rows;
  if (assets.length!==ids.length || assets.some((a)=>a.product_id!==null ? (String(a.product_id)!==String(productId) && String(a.public_product_identity_id)!==String(product.public_product_identity_id)) : Number(a.actor_user_id)!==context.actorUserId)) fail('PHOTO_OWNERSHIP','Фото не належить цьому товару або користувачу.',403);
  if (ids.length) await client.query('UPDATE product_photo_assets SET product_id=$2 WHERE id=ANY($1::uuid[]) AND product_id IS NULL',[ids,productId]);
  const version=String(BigInt(current?.version ?? 0)+1n); const enable=ids.length>0 && input.enableWhenVerified;
  await client.query(`INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES($1,$2,$3,$4)
    ON CONFLICT(product_id) DO UPDATE SET version=EXCLUDED.version,photo_ids=EXCLUDED.photo_ids,enable_when_verified=EXCLUDED.enable_when_verified,updated_at=CURRENT_TIMESTAMP`,[productId,version,ids,enable]);
  const jobId=randomUUID();
  await client.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,actor_user_id,required_permission,intent_hash,request_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[jobId,productId,product.public_product_identity_id,version,ids,enable,context.actorUserId,permission,mediaIntent(product,version,ids,enable),input.idempotencyKey || randomUUID()]);
  await writeAuditEvent(client,{ mutationContext:context,eventKey:'product.photos_saved',subjectType:'product',subjectId:productId,details:{version,photoIds:ids,enableWhenVerified:enable,jobId} });
  return {productId:Number(productId),version,photoIds:ids,enableWhenVerified:enable,jobId,state:'pending'};
}
async function attachCreatedProduct(client, productId, input, mutationContext) {
  const context=createMutationContext(mutationContext);
  if (!input.photoIds?.length) return null;
  // The enclosing create owns the access/lifecycle transaction; never commit here.
  await access.assertActorStillAuthorized(client,context.actorUserId,'products.create',error);
  return attach(client,productId,input,context,'products.create',0);
}
async function inheritRecountPhotos(client,sourceProductId,successorProductId,mutationContext,{requiredPermission='products.recount'}={}) {
  const sourceSet=(await client.query('SELECT * FROM product_photo_sets WHERE product_id=$1 FOR UPDATE',[sourceProductId])).rows[0];
  if (!sourceSet) return null;
  if (!['products.recount','corrections.complete'].includes(requiredPermission)) fail('PHOTO_INHERITANCE_AUTHORITY');
  const context=createMutationContext(mutationContext);
  await access.assertActorStillAuthorized(client,context.actorUserId,requiredPermission,error);
  const successor=await lockProduct(client,successorProductId);
  const predecessor=(await client.query('SELECT public_product_identity_id,corrected_to_product_id,status FROM products WHERE id=$1',[sourceProductId])).rows[0];
  if (!predecessor || String(predecessor.public_product_identity_id)!==String(successor.public_product_identity_id)
    || Number(predecessor.corrected_to_product_id)!==Number(successorProductId) || predecessor.status!=='corrected') fail('PHOTO_LINEAGE_INVALID');
  const sourceJob=(await client.query('SELECT * FROM product_media_jobs WHERE product_id=$1 AND version=$2 FOR UPDATE',[sourceProductId,sourceSet.version])).rows[0];
  if (!sourceJob || JSON.stringify(sourceJob.photo_ids)!==JSON.stringify(sourceSet.photo_ids)
    || sourceJob.enable_when_verified!==sourceSet.enable_when_verified) fail('PHOTO_LINEAGE_INVALID');
  if (sourceJob.state!=='succeeded' && (!['pending','blocked'].includes(sourceJob.state)
    || [sourceJob.origin_hash,sourceJob.binding_revision_id,sourceJob.remote_product_id,sourceJob.native_generation,sourceJob.preservation,sourceJob.verified_at].some((value)=>value!==null)
    || (await client.query('SELECT 1 FROM product_media_steps WHERE job_id=$1 LIMIT 1',[sourceJob.id])).rowCount)) {
    fail('PHOTO_MEDIA_RECONCILIATION_REQUIRED','Спочатку завершіть передавання фотографій або перевірте його результат перед переобліком.',409);
  }
  const id=randomUUID(),version='1';
  await client.query('INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES($1,1,$2,$3)',
    [successorProductId,sourceSet.photo_ids,sourceSet.enable_when_verified]);
  await client.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,actor_user_id,
    required_permission,intent_hash,request_key,inherited_from_product_id,inherited_from_job_id)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [id,successorProductId,successor.public_product_identity_id,sourceSet.photo_ids,sourceSet.enable_when_verified,context.actorUserId,requiredPermission,
    mediaIntent(successor,version,sourceSet.photo_ids,sourceSet.enable_when_verified),randomUUID(),sourceProductId,sourceJob.id]);
  if (sourceJob.state!=='succeeded') await client.query(`UPDATE product_media_jobs SET state='superseded',superseded_by_job_id=$2,
    failure_code='PHOTO_RECOUNT_SUPERSEDED',updated_at=CURRENT_TIMESTAMP WHERE id=$1`,[sourceJob.id,id]);
  await writeAuditEvent(client,{mutationContext:context,eventKey:'product.photos_inherited',subjectType:'product',subjectId:successorProductId,
    details:{sourceProductId:Number(sourceProductId),sourceJobId:sourceJob.id,jobId:id,photoIds:sourceSet.photo_ids,
      enableWhenVerified:sourceSet.enable_when_verified,requiredPermission,superseded:sourceJob.state!=='succeeded'}});
  return {productId:Number(successorProductId),version,photoIds:sourceSet.photo_ids,enableWhenVerified:sourceSet.enable_when_verified,jobId:id,state:'pending'};
}
async function save(productId,input,options={}) {
  shape(input,['idempotencyKey','expectedVersion','photoIds','enableWhenVerified']);
  if (!input || !/^\d{1,18}$/.test(String(input.expectedVersion))) fail('PHOTO_VERSION_REQUIRED');
  if (!UUID.test(String(input.idempotencyKey))) fail('PHOTO_REQUEST_KEY_INVALID');
  const ids=photoIds(input.photoIds);
  if (typeof input.enableWhenVerified!=='boolean') fail('PHOTO_ENABLE_INVALID');
  return transaction(options,['products.recount'],async(client,context,permission)=>{
    const existing=(await client.query('SELECT * FROM product_media_jobs WHERE actor_user_id=$1 AND request_key=$2',[context.actorUserId,input.idempotencyKey])).rows[0];
    if (existing) {
      if (String(existing.product_id)!==String(productId) || String(existing.version)!==String(BigInt(input.expectedVersion)+1n)
        || JSON.stringify(existing.photo_ids)!==JSON.stringify(ids) || existing.enable_when_verified!==(ids.length>0 && input.enableWhenVerified)) fail('PHOTO_IDEMPOTENCY_CONFLICT','Цей запит уже містить інші фотографії.',409);
      return {productId:Number(productId),version:existing.version,photoIds:existing.photo_ids,enableWhenVerified:existing.enable_when_verified,jobId:existing.id,state:existing.state};
    }
    return attach(client,productId,input,context,permission,input.expectedVersion);
  });
}
async function read(productId,options={}) {
  const db=options.databasePool || pool;
  // One PostgreSQL statement binds gallery order, version and job to one snapshot.
  const current=(await db.query(`SELECT p.id,s.version,s.enable_when_verified,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.display_name,'mimeType',a.mime_type,'hash',a.content_hash) ORDER BY chosen.position)
      FROM unnest(s.photo_ids) WITH ORDINALITY chosen(id,position) JOIN product_photo_assets a ON a.id=chosen.id),'[]'::jsonb) AS photos,
    CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('jobId',j.id,'state',j.state,'verifiedAt',j.verified_at,
      'code',COALESCE(j.failure_code,CASE WHEN j.state IN ('pending','running')
        AND (n.product_id IS NULL OR n.state<>'synced' OR n.synced_generation<>n.desired_generation)
        THEN 'PHOTO_NATIVE_SYNC_REQUIRED' END)) END AS delivery
    FROM products p LEFT JOIN product_photo_sets s ON s.product_id=p.id
    LEFT JOIN product_media_jobs j ON j.product_id=s.product_id AND j.version=s.version
    LEFT JOIN magento_product_sync_requests n ON n.public_product_identity_id=j.public_product_identity_id AND n.product_id=j.product_id
    WHERE p.id=$1`,[productId])).rows[0];
  if (!current) fail('PHOTO_PRODUCT_INVALID','Товар не знайдено.',404);
  return {productId:Number(current.id),version:String(current.version ?? 0),enableWhenVerified:current.enable_when_verified ?? false,
    photos:current.photos,delivery:current.delivery};
}
async function content(id, actorUserId, canView, options={}) {
  if (!UUID.test(String(id))) fail('PHOTO_ID_INVALID');
  const asset=(await (options.databasePool || pool).query(`SELECT content,mime_type,content_hash FROM product_photo_assets
    WHERE id=$1 AND ((product_id IS NULL AND actor_user_id=$2) OR (product_id IS NOT NULL AND $3::boolean))`,[id,actorUserId,canView])).rows[0];
  if (!asset) fail('PHOTO_NOT_FOUND','Фото не знайдено.',404);
  return asset;
}
module.exports={ MAX_PHOTO_BYTES,MAX_STORED_PHOTO_BYTES,MAX_PHOTO_REQUEST_BYTES,MAX_PHOTOS,sha,error,photoIds,decodeBase64,imageType,validateUpload,normalizeCreationPhotos,assertPhotoActor,mediaIntent,stage,save,read,content,attachCreatedProduct,inheritRecountPhotos };
