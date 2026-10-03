const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { sendHttpError } = require('../../http/errors');
const editor = require('../../services/magento/integration-editor.service');
const overview = require('../../services/magento/integration-overview');
const config = require('../../config/env').magento;
const { getRequestMutationContext } = require('../../audit/mutation-context');
const category = require('../../services/magento/configuration-category');
const actions = require('../../services/magento/configuration-actions');
const option = require('../../services/magento/configuration-option');
const optionLabels = require('../../services/magento/configuration-option-labels');
const successor = require('../../services/magento/integration-successor');
const bindingReview = require('../../services/magento/integration-binding-review');
const bindingService = require('../../services/magento/binding.service');
const publication = require('../../services/magento/binding-publication');
const handoff = require('../../services/magento/binding-handoff');
const controlled = require('../../services/magento/binding-controlled-actions');
const router = express.Router();
const root = '/admin/magento-integration';
const handle = (operation) => async (req, res) => {
  try { res.json(await operation(req)); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true, includeDetails: true }); }
};
router.get(root, requirePermission('export_templates.view'), handle((req) => editor.overview(config, {...req.query})));
router.get(`${root}/overview`, requirePermission('export_templates.view'), handle((req) => overview.overview(config,
  { canViewProducts: req.permissions.includes('products.view') })));
router.get(`${root}/creation-inputs`, requirePermission('export_templates.manage'), requirePermission('exports.view'),
  handle((req) => editor.creationInputs({ ...req.query })));
router.post(`${root}/discovery`, requirePermission('export_templates.view'), handle(() => editor.discovery(config)));
router.get(`${root}/bindings/:id`, requirePermission('export_templates.view'), handle((req) => bindingReview.get(config,req.params.id)));
router.get(`${root}/bindings/:id/handoffs`,requirePermission('export_templates.view'),handle((req)=>handoff.status(config,req.params.id)));
router.get(`${root}/bindings/:id/controlled-products`,requirePermission('export_templates.view'),handle((req)=>controlled.candidates(config,req.params.id,{},{...req.query})));
for(const [path,operation] of [['publication/preview',publication.preview],['publication/apply',publication.publish],['controlled/preview',controlled.preview],['controlled/apply',controlled.apply]]){
  router.post(`${root}/${path}`,requirePermission('export_templates.manage'),requirePermission('export_templates.publish'),requirePermission('exports.view'),
    handle((req)=>operation(config,req.body,{mutationContext:getRequestMutationContext(req)})));
}
router.post(`${root}/bindings/:id/clone`,requirePermission('export_templates.manage'),handle(async (req) => {
  await bindingReview.get(config,req.params.id);
  return bindingService.clonePublished(req.params.id,req.body,{mutationContext:getRequestMutationContext(req)});
}));
for (const [name, operation] of [['decision',bindingReview.decide],['select',bindingReview.select]]) {
  router.post(`${root}/bindings/:id/${name}`,requirePermission('export_templates.manage'),
    handle((req) => operation(config,req.params.id,req.body,{mutationContext:getRequestMutationContext(req)})));
}
for (const [name, operation] of [['prepare',successor.prepare],['apply',successor.apply]]) {
  router.post(`${root}/successor/${name}`,requirePermission('export_templates.manage'),
    handle((req) => operation(config,req.body,{mutationContext:getRequestMutationContext(req)})));
}
router.get(`${root}/actions`, requirePermission('export_templates.view'), handle(() => actions.list(config)));
router.get(`${root}/actions/:id`, requirePermission('export_templates.view'), handle(async (req) => actions.receipt(await actions.get(config, req.params.id))));
for (const [name, operation] of [['inspect',option.inspect],['attest',option.attest],['preview',option.preview],['apply',option.apply],['reconcile',option.reconcile]]) {
  router.post(`${root}/options/${name}`,requirePermission('export_templates.manage'),requirePermission('export_templates.publish'),
    handle((req) => operation(config,req.body,{mutationContext:getRequestMutationContext(req)})));
}
for (const [name, operation] of [['inspect',optionLabels.inspect],['attest',optionLabels.attest],['preview',optionLabels.preview],['apply',optionLabels.apply],['reconcile',optionLabels.reconcile]]) {
  router.post(`${root}/option-labels/${name}`,requirePermission('export_templates.manage'),requirePermission('export_templates.publish'),
    handle((req) => operation(config,req.body,{mutationContext:getRequestMutationContext(req)})));
}
for (const [name, operation] of [['preview', category.preview], ['apply', category.apply], ['reconcile', category.reconcile]]) {
  router.post(`${root}/categories/${name}`, requirePermission('export_templates.manage'), requirePermission('export_templates.publish'),
    handle((req) => operation(config, req.body, { mutationContext: getRequestMutationContext(req) })));
}
for (const [path, operation] of [['product-preview', editor.currentPreview], ['create-preview', editor.prospectivePreview]]) {
  router.post(`${root}/${path}`, requirePermission('export_templates.manage'), requirePermission('exports.view'),
    handle((req) => operation(config, req.body)));
}
module.exports = router;
