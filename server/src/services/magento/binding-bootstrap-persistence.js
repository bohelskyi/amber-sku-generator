const { randomUUID } = require('node:crypto');
const c = require('./binding-contract');
const { createMutationContext } = require('../../audit/mutation-context');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');

async function assertBootstrapSchema(client) {
  const result = await client.query(`SELECT to_regclass('magento_binding_revisions') IS NOT NULL AS present,
    EXISTS (SELECT 1 FROM schema_migrations WHERE name='041_magento_binding_revisions.sql') AS applied`);
  if (!result.rows[0]?.present || !result.rows[0]?.applied) throw c.error(409, 'MAGENTO_BINDING_MIGRATION_REQUIRED',
    'Migration 041 must be applied by the normal migration runner before bootstrap');
}
async function preflight(databasePool) {
  const client = await databasePool.connect();
  try { await assertBootstrapSchema(client); } finally { client.release(); }
}
async function persistBootstrap(input, options = {}) {
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: options.databasePool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.manage', createError: c.error, operation: async (client) => {
      await assertBootstrapSchema(client);
      let versionId = input.templateVersionId;
      if (!versionId) {
        await assertActorStillAuthorized(client, context.actorUserId, 'export_templates.publish', c.error);
        const templates = require('../export-templates/template.service');
        const family = await templates.createTemplateOnClient(client, context, { key: `magento-bootstrap-${randomUUID()}`,
          displayName: 'Magento binding evaluator snapshot', definition: input.definition });
        const version = await templates.publishTemplateOnClient(client, context, family.id, {
          expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash });
        if (version.definitionHash !== input.definitionHash) throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Frozen evaluator differs');
        versionId = version.id;
      }
      const revision = await require('./binding.service').createDraftOnClient(client, context, {
        installationKey: input.installationKey, origin: input.origin, templateVersionId: versionId,
        observedAt: input.observedAt, schema: input.schema, bindings: input.bindings });
      // Receipt construction/safety checks must finish before COMMIT too.
      if (options.prepareReceipt) options.prepareReceipt(revision);
      return revision;
    } });
}
module.exports = { preflight, persistBootstrap };
