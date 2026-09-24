const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { sendHttpError } = require('../../http/errors');
const templates = require('../../services/export-templates/template.service');

const router = express.Router();
const root = '/admin/export-templates';
const permission = (name) => requirePermission(`export_templates.${name}`);
const handle = (operation, status = 200) => async (req, res) => {
  try { res.status(status).json(await operation(req)); } catch (error) {
    sendHttpError(res, error, { includeCode: true, includeDetails: true });
  }
};
const context = (req) => ({ mutationContext: getRequestMutationContext(req) });

// Static endpoints must precede /:id.
router.get(`${root}/system`, permission('view'), handle(() => templates.systemProfile()));
router.get(`${root}/sample-products`, permission('manage'), requirePermission('exports.view'), handle((req) => templates.searchSampleProducts(req.query)));
router.get(`${root}/source-details`, permission('view'), handle((req) => templates.sourceDetails(req.query)));
router.get(`${root}/candidate`, permission('view'), permission('manage'), handle(() => templates.prepareMagentoCandidate()));
router.get(`${root}/sources`, permission('view'), handle(() => templates.listSources()));
router.get(`${root}/activation`, permission('view'), handle(() => templates.getActivation()));
router.put(`${root}/activation`, permission('activate'), handle((req) => templates.updateActivation(req.body, context(req))));
router.get(root, permission('view'), handle(async () => ({ templates: await templates.listTemplates(), systemProfiles: [{ systemKey: 'magento-legacy', displayName: 'Magento — поточний системний', kind: 'system', effectiveExporter: 'legacy' }] })));
router.post(root, permission('manage'), handle((req) => templates.createTemplate(req.body, context(req)), 201));
router.get(`${root}/:id`, permission('view'), handle((req) => templates.getTemplate(req.params.id)));
router.put(`${root}/:id/draft`, permission('manage'), handle((req) => templates.saveDraft(req.params.id, req.body, context(req))));
router.post(`${root}/:id/draft/upgrade-columns`, permission('manage'), handle((req) => templates.upgradeDraft(req.params.id, req.body, context(req))));
router.post(`${root}/:id/draft/from-version`, permission('manage'), handle((req) => templates.cloneDraft(req.params.id, req.body, context(req))));
router.post(`${root}/:id/validate`, permission('manage'), handle((req) => templates.validateDraft(req.params.id, req.body)));
router.post(`${root}/:id/test-preview`, permission('manage'), requirePermission('exports.view'),
  handle((req) => templates.testPreview(req.params.id, req.body)));
router.post(`${root}/:id/publish`, permission('publish'), handle((req) => templates.publishTemplate(req.params.id, req.body, context(req))));

module.exports = router;
