const express=require('express');
const photos=require('../../services/product-photos.service');
const { requirePermission,requireAnyPermission }=require('../../auth/authorization');
const { getRequestMutationContext }=require('../../audit/mutation-context');
const { sendHttpError }=require('../../http/errors');
const pool=require('../../db/pool');
const router=express.Router();
const handle=(operation)=>async(req,res)=>{
  res.set('Cache-Control','no-store');
  try { await operation(req,res); }
  catch(cause){sendHttpError(res,cause,{includeCode:true});}
};
router.post('/product-photos/stage',requireAnyPermission(['products.create','products.recount']),handle(async(req,res)=>{
  res.json(await photos.stage(req.body || {},{mutationContext:getRequestMutationContext(req)}));
}));
router.get('/product-photos/:id/content',requireAnyPermission(['products.view','products.create','products.recount']),handle(async(req,res)=>{
  const asset=await photos.content(req.params.id,req.applicationUser.id,req.permissions.includes('products.view'));
  res.set('Content-Type',asset.mime_type);res.set('X-Content-Type-Options','nosniff');
  res.set('Content-Disposition','inline');res.send(asset.content);
}));
router.get('/products/:id/photos',requirePermission('products.view'),handle(async(req,res)=>{
  if (!Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id)<=0) throw photos.error(422,'PHOTO_PRODUCT_INVALID','Некоректний товар.');
  res.json(await photos.read(Number(req.params.id)));
}));
router.post('/products/:id/photos',requirePermission('products.recount'),handle(async(req,res)=>{
  res.json(await photos.save(Number(req.params.id),req.body || {},{mutationContext:getRequestMutationContext(req)}));
}));
router.post('/products/:id/photos/reconcile',requireAnyPermission(['products.create','products.recount','corrections.complete']),handle(async(req,res)=>{
  const context=getRequestMutationContext(req);
  const job=(await pool.query('SELECT * FROM product_media_jobs WHERE product_id=$1 ORDER BY version DESC LIMIT 1',[Number(req.params.id)])).rows[0];
  if (!job) throw photos.error(404,'PHOTO_JOB_NOT_FOUND','Передавання фото не знайдено.');
  if (!req.permissions.includes('products.recount') && (Number(job.actor_user_id)!==context.actorUserId
    || !req.permissions.includes(job.required_permission)
    || (job.required_permission==='corrections.complete' && (!job.inherited_from_product_id || !job.inherited_from_job_id)))) throw photos.error(403,'INSUFFICIENT_PERMISSION','Немає дозволу перевіряти ці фотографії.');
  res.json(await require('../../services/magento/product-media-delivery').processJob(require('../../config/env').magento,job.id,
    {databasePool:pool,readOnly:true,mutationContext:context}));
}));
module.exports=router;
