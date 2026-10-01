const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { sendHttpError } = require('../../http/errors');
const editor = require('../../services/magento/integration-editor.service');
const config = require('../../config/env').magento;
const { getRequestMutationContext } = require('../../audit/mutation-context');
const category = require('../../services/magento/configuration-category');
const actions = require('../../services/magento/configuration-actions');
const router = express.Router();
const root = '/admin/magento-integration';
const handle = (operation) => async (req, res) => {
  try { res.json(await operation(req)); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true, includeDetails: true }); }
};
router.get(root, requirePermission('export_templates.view'), handle((req) => editor.overview(config, req.query)));
router.post(`${root}/discovery`, requirePermission('export_templates.view'), handle(() => editor.discovery(config)));
router.get(`${root}/actions`, requirePermission('export_templates.view'), handle(() => actions.list(config)));
router.get(`${root}/actions/:id`, requirePermission('export_templates.view'), handle(async (req) => actions.receipt(await actions.get(config, req.params.id))));
for (const [name, operation] of [['preview', category.preview], ['apply', category.apply], ['reconcile', category.reconcile]]) {
  router.post(`${root}/categories/${name}`, requirePermission('export_templates.manage'), requirePermission('export_templates.publish'),
    handle((req) => operation(config, req.body, { mutationContext: getRequestMutationContext(req) })));
}
for (const [path, operation] of [['product-preview', editor.currentPreview], ['create-preview', editor.prospectivePreview]]) {
  router.post(`${root}/${path}`, requirePermission('export_templates.manage'), requirePermission('exports.view'),
    handle((req) => operation(config, req.body)));
}
module.exports = router;
