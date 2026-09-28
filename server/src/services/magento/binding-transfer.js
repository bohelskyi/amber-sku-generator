const pool = require('../../db/pool');
const c = require('./binding-contract');
const bindingService = require('./binding.service');
const { compareSchema } = require('./binding-drift');
const { auditMagentoSchema } = require('./schema-audit');
const { createMagentoClient } = require('./client');
const { indexTrees } = require('./sync-preview-categories');
const { compileDefinition } = require('../export-templates/definition');
const templates = require('../export-templates/template.service');
const { createMutationContext } = require('../../audit/mutation-context');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');

function failure(code, message, details) { throw c.error(409, code, message, details); }
async function databaseName(client, expected) {
  if (typeof expected !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(expected)) c.invalid();
  const actual = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (actual !== expected) failure('MAGENTO_BINDING_TRANSFER_DATABASE_MISMATCH', 'Target database differs');
  return actual;
}

async function exportArtifact(revisionId, input, options = {}) {
  c.identity(revisionId); c.counter(input.expectedRevision);
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const database = await databaseName(client, input.expectedDatabase);
    const revision = await bindingService.readRevisionOnClient(client, revisionId);
    const current = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`, [revision.installationKey])).rows[0];
    if (revision.state !== 'published' || revision.revision !== String(input.expectedRevision) || current?.id !== revision.id) {
      failure('MAGENTO_BINDING_TRANSFER_SOURCE_NOT_CURRENT', 'Source must be the current publication at the expected revision');
    }
    const template = (await client.query(`SELECT t.template_key,t.display_name,v.* FROM export_template_versions v
      JOIN export_templates t ON t.id=v.template_id WHERE v.id=$1`, [revision.templateVersionId])).rows[0];
    if (!template) failure('MAGENTO_BINDING_TRANSFER_TEMPLATE_MISSING', 'Source template publication is missing');
    const compiled = compileDefinition(template.definition);
    if (compiled.hash !== template.definition_hash || compiled.definition.evaluatorVersion !== template.evaluator_version
      || compiled.definition.outputContract !== template.output_contract || compiled.definition.formatVersion !== template.format_version) {
      failure('MAGENTO_BINDING_TRANSFER_TEMPLATE_INTEGRITY', 'Source template publication identity is invalid');
    }
    const artifact = c.safeData({ artifactVersion: 1, kind: 'amber-magento-binding-transfer',
      installationKey: revision.installationKey, originHash: revision.originHash,
      source: { database, revisionId: revision.id, revision: revision.revision, versionNumber: revision.versionNumber,
        bindingHash: c.hash(revision.bindings), schemaFingerprint: revision.schemaFingerprint,
        topologyFingerprint: revision.topologyFingerprint },
      template: { sourceTemplateId: revision.templateId, sourceVersionId: revision.templateVersionId,
        sourceTemplateKey: template.template_key, sourceDisplayName: template.display_name,
        definition: compiled.definition, definitionHash: compiled.hash, evaluatorVersion: template.evaluator_version,
        outputContract: template.output_contract, formatVersion: template.format_version },
      observedAt: new Date(revision.observedAt).toISOString(), schema: revision.schema, bindings: revision.bindings,
    }, [], 64 * 1024 * 1024);
    await client.query('COMMIT');
    return { artifact, artifactHash: c.hash(artifact) };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function verifyArtifact(wrapper) {
  if (!wrapper || wrapper.artifactHash !== c.hash(wrapper.artifact)) failure('MAGENTO_BINDING_TRANSFER_HASH_MISMATCH', 'Artifact hash differs');
  const a = c.safeData(wrapper.artifact, [], 64 * 1024 * 1024);
  if (a.artifactVersion !== 1 || a.kind !== 'amber-magento-binding-transfer') c.invalid();
  c.installation(a.installationKey); c.identity(a.source?.revisionId); c.counter(a.source?.revision);
  if (!/^[a-f0-9]{64}$/.test(a.originHash) || a.source.bindingHash !== c.hash(a.bindings)
    || a.source.schemaFingerprint !== c.hash(c.normalizeSchema(a.schema))
    || a.source.topologyFingerprint !== c.hash(c.normalizeSchema(a.schema).storeTopology)) c.invalid();
  const compiled = compileDefinition(a.template.definition);
  if (compiled.hash !== a.template.definitionHash || compiled.definition.evaluatorVersion !== a.template.evaluatorVersion
    || compiled.definition.outputContract !== a.template.outputContract || compiled.definition.formatVersion !== a.template.formatVersion) c.invalid();
  return a;
}

async function categoryDrift(config, artifact, options = {}) {
  const approved = artifact.bindings.attributes.flatMap((binding) =>
    (binding.evidence?.categories || []).filter((row) => row.reviewState === 'approved')
      .map((row) => ({ bindingKey: binding.bindingKey, path: row.normalizedPath, categoryId: row.categoryId })));
  if (!approved.length) return [];
  const client = createMagentoClient(config, { fetchImpl: options.fetchImpl, storeCode: artifact.schema.storeCode });
  const roots = [...new Set(artifact.schema.storeTopology.storeGroups.map((row) => row.root_category_id).filter(Number.isSafeInteger))];
  const trees = [];
  for (const root of roots) trees.push(await client.getCategoryTree(root));
  const indexed = indexTrees(trees);
  return approved.flatMap((decision) => {
    const matches = indexed.filter((row) => row.comparable && row.normalizedPath === decision.path);
    return matches.length === 1 && String(matches[0].categoryId) === String(decision.categoryId) ? []
      : [{ code: 'CATEGORY_IDENTITY_DRIFT', severity: 'missing_identity', ...decision,
        observedCategoryIds: matches.map((row) => String(row.categoryId)) }];
  });
}

async function liveDrift(config, artifact, options = {}) {
  if (c.originHash(config.baseUrl) !== artifact.originHash) failure('MAGENTO_BINDING_INSTALLATION_MISMATCH', 'Configured Magento origin differs');
  const schema = await auditMagentoSchema(config, { fetchImpl: options.fetchImpl, storeCode: artifact.schema.storeCode });
  const comparison = compareSchema({ id: artifact.source.revisionId, revision: artifact.source.revision,
    schema: artifact.schema, schemaFingerprint: artifact.source.schemaFingerprint,
    topologyFingerprint: artifact.source.topologyFingerprint, bindings: artifact.bindings }, schema);
  // A fingerprint-only change outside every approved identity is informational;
  // report only drift that can affect the reviewed binding or store topology.
  const diagnostics = comparison.diagnostics.filter((item) => item.code !== 'SCHEMA_FINGERPRINT_CHANGED');
  diagnostics.push(...await categoryDrift(config, artifact, options));
  return { schemaFingerprint: comparison.schemaFingerprint, topologyFingerprint: comparison.topologyFingerprint,
    diagnostics, drifted: diagnostics.length > 0 };
}

async function ensureTemplate(client, context, artifact, artifactHash) {
  const key = `magento-transfer-${artifactHash.slice(0, 32)}`;
  let family = (await client.query('SELECT * FROM export_templates WHERE template_key=$1 FOR UPDATE', [key])).rows[0];
  if (!family) family = await templates.createTemplateOnClient(client, context,
    { key, displayName: `Magento binding transfer ${artifactHash.slice(0, 12)}`, definition: artifact.template.definition });
  const version = (await client.query(`SELECT * FROM export_template_versions WHERE template_id=$1
    AND definition_hash=$2 ORDER BY version_number LIMIT 1`, [family.id, artifact.template.definitionHash])).rows[0];
  if (version) {
    if (version.evaluator_version !== artifact.template.evaluatorVersion || version.output_contract !== artifact.template.outputContract
      || version.format_version !== artifact.template.formatVersion) c.invalid();
    return version;
  }
  const draft = (await client.query('SELECT * FROM export_template_drafts WHERE template_id=$1 FOR UPDATE', [family.id])).rows[0];
  const compiled = compileDefinition(draft.definition);
  if (compiled.hash !== artifact.template.definitionHash) failure('MAGENTO_BINDING_TRANSFER_TEMPLATE_CONFLICT', 'Imported template identity conflicts');
  return templates.publishTemplateOnClient(client, context, family.id,
    { expectedRevision: draft.revision, expectedDefinitionHash: compiled.hash });
}

async function importArtifact(wrapper, input, config, options = {}) {
  const artifact = verifyArtifact(wrapper);
  if (wrapper.artifactHash !== input.expectedHash || artifact.installationKey !== input.installationKey) c.invalid();
  const drift = await liveDrift(config, artifact, options);
  if (drift.drifted) failure('MAGENTO_BINDING_TARGET_DRIFT', 'Target Magento identities require review', { diagnostics: drift.diagnostics });
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish', createError: c.error, operation: async (client) => {
      await databaseName(client, input.expectedDatabase);
      await assertActorStillAuthorized(client, context.actorUserId, 'export_templates.manage', c.error);
      const version = await ensureTemplate(client, context, artifact, wrapper.artifactHash);
      const draft = await bindingService.importReviewedDraftOnClient(client, context, {
        installationKey: artifact.installationKey, origin: config.baseUrl, templateVersionId: version.id,
        observedAt: artifact.observedAt, schema: artifact.schema, bindings: artifact.bindings,
      }, { artifactHash: wrapper.artifactHash, sourceRevisionId: artifact.source.revisionId,
        sourceRevision: artifact.source.revision, sourceVersionNumber: artifact.source.versionNumber,
        sourceBindingHash: artifact.source.bindingHash });
      return { id: draft.id, revision: draft.revision, state: draft.state, installationKey: draft.installationKey,
        templateVersionId: draft.templateVersionId, artifactHash: wrapper.artifactHash, drift };
    } });
}

async function verifyImported(revisionId, input, config, options = {}) {
  const client = await (options.databasePool || pool).connect();
  try { await client.query('BEGIN READ ONLY'); await databaseName(client, input.expectedDatabase); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const revision = await bindingService.getRevision(revisionId, options);
  const local = await bindingService.validateDraft(revisionId, options);
  const drift = await liveDrift(config, { originHash: revision.originHash, source: { revisionId: revision.id,
    revision: revision.revision, schemaFingerprint: revision.schemaFingerprint, topologyFingerprint: revision.topologyFingerprint },
    schema: revision.schema, bindings: revision.bindings }, options);
  return { id: revision.id, revision: revision.revision, state: revision.state, valid: local.valid && !drift.drifted,
    localDiagnostics: local.diagnostics, drift };
}

module.exports = { exportArtifact, verifyArtifact, liveDrift, importArtifact, verifyImported };
