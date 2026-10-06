const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { sendHttpError } = require('../../http/errors');
const config = require('../../config/env').magento;
const service = require('../../services/catalog/catalog-deletion.service');
const remoteOnly = require('../../services/catalog/catalog-remote-deletion.service');
const router = express.Router();
// Mount inside app.js's existing authenticated, active-user, CSRF-protected API.
router.use('/admin/catalog-deletion',requirePermission('catalog.manage'),requirePermission('export_templates.manage'),requirePermission('export_templates.publish'));
const handle = operation => async(req,res) => {
  res.set('Cache-Control','no-store');
  try { res.json(await operation(req,{mutationContext:getRequestMutationContext(req)})); }
  catch(error) { sendHttpError(res,error,{includeCode:true,includeDetails:true}); }
};
for(const name of ['preview','apply','reconcile']) router.post(`/admin/catalog-deletion/${name}`,handle((req,options)=>service[name](config,req.body,options)));
for(const name of ['preview','apply','reconcile']) router.post(`/admin/catalog-deletion/remote-only/${name}`,handle((req,options)=>remoteOnly[name](config,req.body,options)));
router.get('/admin/catalog-deletion/remote-only/actions',handle((_req,options)=>remoteOnly.list(config,options)));
router.get('/admin/catalog-deletion/remote-only/actions/:id',handle((req,options)=>remoteOnly.get(config,req.params.id,options)));
router.get('/admin/catalog-deletion/actions',handle((_req,options)=>service.list(config,options)));
router.get('/admin/catalog-deletion/actions/:id',handle((req,options)=>service.get(config,req.params.id,options)));
module.exports = router;
