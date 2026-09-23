const { randomUUID } = require('node:crypto');
const pool = require('../../db/pool');
const { PublicHttpError } = require('../../http/errors');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { hashJsonData, compileDefinition } = require('./definition');
const { evaluateBatch } = require('./evaluate');
const { loadSourceEvidence, validateSourceReferences, getSourceRegistry } = require('./source-references');
const { loadDraftPreviewProducts } = require('./draft-inputs');

const error = (status, code, message, details) => new PublicHttpError(status, message, { code, details });
const conflict = (message = 'Draft revision or hash changed') => error(409, 'TEMPLATE_DRAFT_CONFLICT', message);
function command(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || required.some((key) => !Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Missing or unsupported command fields');
  }
}
function counter(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775806n) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Expected positive revision/generation');
  }
  return text;
}
function identity(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Expected template/version UUID');
  }
  return value.toLowerCase();
}
function expectedHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Expected canonical SHA-256');
  }
  return value;
}
function pureCall(operation) {
  try { return operation(); } catch (cause) {
    if (['TEMPLATE_INVALID', 'INPUT_INVALID', 'SOURCE_REFERENCE_AMBIGUOUS', 'EVALUATION_LIMIT'].includes(cause.code)) {
      throw error(422, cause.code, cause.message);
    }
    throw cause;
  }
}
function prepareDraft(definition) {
  const hash = pureCall(() => hashJsonData(definition));
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw error(422, 'TEMPLATE_INVALID', 'Draft must be a JSON object');
  }
  // PostgreSQL JSONB cannot retain NUL or unpaired UTF-16 surrogates. Reject before writing.
  function checkStrings(value) {
    if (typeof value === 'string' && /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
      throw error(422, 'TEMPLATE_INVALID', 'Draft contains text unsupported by JSONB');
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => { checkStrings(key); checkStrings(item); });
    }
  }
  checkStrings(definition);
  return { definition: JSON.parse(JSON.stringify(definition)), hash };
}
function draftView(row) {
  return { templateId: row.template_id, baseVersionId: row.base_version_id,
    revision: row.revision, definition: row.definition, definitionHash: hashJsonData(row.definition),
    state: 'draft', modifiedByUserId: row.modified_by_user_id, modifiedAt: row.modified_at };
}
function versionView(row) {
  return { id: row.id, templateId: row.template_id, versionNumber: row.version_number,
    sourceDraftRevision: row.source_draft_revision, definition: row.definition, definitionHash: row.definition_hash,
    formatVersion: row.format_version, evaluatorVersion: row.evaluator_version, outputContract: row.output_contract,
    publishedByUserId: row.published_by_user_id, publishedAt: row.published_at };
}
function selectionView(row) {
  return { generation: row.generation, implementation: row.implementation, templateVersionId: row.template_version_id,
    changedByUserId: row.changed_by_user_id, changedAt: row.changed_at,
    metadataOnly: true, effectiveExporter: 'legacy' };
}
function verifyVersion(row) {
  const compiled = pureCall(() => compileDefinition(row.definition));
  if (compiled.hash !== row.definition_hash || row.format_version !== compiled.definition.formatVersion
    || row.evaluator_version !== compiled.definition.evaluatorVersion || row.output_contract !== compiled.definition.outputContract) {
    throw error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Stored version identity does not match its definition');
  }
  return compiled;
}
async function readTransaction(options, operation) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally { client.release(); }
}
async function mutation(capability, options, operation) {
  const mutationContext = createMutationContext(options.mutationContext);
  try {
    return await runAccessAdminMutation({ databasePool: options.databasePool || pool,
      actorUserId: mutationContext.actorUserId, requiredPermission: `export_templates.${capability}`,
      createError: error, operation: (client) => operation(client, mutationContext) });
  } catch (cause) {
    if (cause.code === '23505' && cause.constraint === 'export_templates_template_key_key') {
      throw error(409, 'TEMPLATE_KEY_CONFLICT', 'Template key is permanently reserved');
    }
    throw cause;
  }
}
async function audit(client, mutationContext, action, subjectId, details) {
  await writeAuditEvent(client, { mutationContext, eventKey: `export_template.${action}`,
    subjectType: 'export_template', subjectId, details });
}
async function loadDraft(client, templateId, lock = false) {
  if (lock) {
    // All mutation paths: access advisory lock -> family -> draft. No export/product locks.
    const family = await client.query('SELECT id FROM export_templates WHERE id = $1 FOR UPDATE', [templateId]);
    if (!family.rows.length) throw error(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
  }
  const result = await client.query(`SELECT * FROM export_template_drafts WHERE template_id = $1${lock ? ' FOR UPDATE' : ''}`, [templateId]);
  if (!result.rows.length) throw error(404, 'TEMPLATE_NOT_FOUND', 'Template draft not found');
  return result.rows[0];
}
async function loadVersion(client, versionId, templateId) {
  const result = await client.query('SELECT * FROM export_template_versions WHERE id = $1', [versionId]);
  if (!result.rows.length) throw error(404, 'TEMPLATE_VERSION_NOT_FOUND', 'Published version not found');
  const row = result.rows[0];
  if (templateId && row.template_id !== templateId) throw conflict('Published version belongs to another family');
  return row;
}
function assertDraft(row, revision, hash) {
  if (row.revision !== revision || (hash && hashJsonData(row.definition) !== hash)) throw conflict();
}
async function validateStored(client, row) {
  const compiled = pureCall(() => compileDefinition(row.definition));
  const diagnostics = validateSourceReferences(compiled.definition, await loadSourceEvidence(client));
  if (diagnostics.length) throw error(422, 'TEMPLATE_SOURCE_INVALID', 'Unresolved or unsupported source references', { diagnostics });
  return compiled;
}

async function listTemplates(options = {}) {
  const result = await (options.databasePool || pool).query(`
    SELECT t.*, d.revision AS draft_revision,
      (SELECT count(*)::int FROM export_template_versions v WHERE v.template_id = t.id) AS publication_count
    FROM export_templates t JOIN export_template_drafts d ON d.template_id = t.id
    ORDER BY t.template_key`);
  return result.rows;
}
async function getTemplate(templateId, options = {}) {
  templateId = identity(templateId);
  return readTransaction(options, async (client) => {
    const draft = await loadDraft(client, templateId);
    const family = (await client.query('SELECT * FROM export_templates WHERE id = $1', [templateId])).rows[0];
    const versions = (await client.query('SELECT * FROM export_template_versions WHERE template_id = $1 ORDER BY version_number', [templateId])).rows;
    // Reading old unsupported versions is allowed; their stored identity is never rewritten.
    return { ...family, draft: draftView(draft), versions: versions.map(versionView) };
  });
}
async function createTemplate(input, options = {}) {
  command(input, ['key', 'displayName'], ['definition']);
  if (typeof input.key !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(input.key)
    || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 160) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Invalid template key/display name');
  }
  const prepared = prepareDraft(Object.hasOwn(input, 'definition') ? input.definition : {});
  return mutation('manage', options, async (client, context) => {
    const id = randomUUID();
    const family = (await client.query(`INSERT INTO export_templates (id, template_key, display_name, created_by_user_id)
      VALUES ($1, $2, $3, $4) RETURNING *`, [id, input.key, input.displayName.trim(), context.actorUserId])).rows[0];
    const row = (await client.query(`INSERT INTO export_template_drafts (template_id, definition, modified_by_user_id)
      VALUES ($1, $2::jsonb, $3) RETURNING *`, [id, JSON.stringify(prepared.definition), context.actorUserId])).rows[0];
    const draft = draftView(row);
    if (draft.definitionHash !== prepared.hash) throw error(409, 'TEMPLATE_VERSION_INTEGRITY', 'JSONB changed draft identity');
    await audit(client, context, 'created', id, { templateId: id, draftRevision: row.revision, definitionHash: prepared.hash });
    return { ...family, draft };
  });
}
async function replaceDraft(client, row, prepared, baseVersionId, context) {
  if (hashJsonData(row.definition) === prepared.hash && row.base_version_id === baseVersionId) return draftView(row);
  const next = (await client.query(`UPDATE export_template_drafts SET definition = $2::jsonb,
    base_version_id = $3, revision = revision + 1, modified_by_user_id = $4, modified_at = CURRENT_TIMESTAMP
    WHERE template_id = $1 AND revision = $5 RETURNING *`,
  [row.template_id, JSON.stringify(prepared.definition), baseVersionId, context.actorUserId, row.revision])).rows[0];
  if (!next) throw conflict();
  const result = draftView(next);
  if (result.definitionHash !== prepared.hash) throw error(409, 'TEMPLATE_VERSION_INTEGRITY', 'JSONB changed draft identity');
  await audit(client, context, 'draft_updated', row.template_id, { templateId: row.template_id,
    revisionFrom: row.revision, revisionTo: next.revision, definitionHash: prepared.hash, baseVersionId });
  return result;
}
async function saveDraft(templateId, input, options = {}) {
  templateId = identity(templateId);
  command(input, ['expectedRevision', 'definition']);
  const revision = counter(input.expectedRevision);
  const prepared = prepareDraft(input.definition);
  return mutation('manage', options, async (client, context) => {
    const row = await loadDraft(client, templateId, true);
    assertDraft(row, revision);
    return replaceDraft(client, row, prepared, row.base_version_id, context);
  });
}
async function cloneDraft(templateId, input, options = {}) {
  templateId = identity(templateId);
  command(input, ['expectedRevision', 'versionId']);
  const revision = counter(input.expectedRevision);
  const versionId = identity(input.versionId);
  return mutation('manage', options, async (client, context) => {
    const row = await loadDraft(client, templateId, true);
    assertDraft(row, revision);
    const version = await loadVersion(client, versionId, templateId);
    verifyVersion(version);
    return replaceDraft(client, row, prepareDraft(version.definition), version.id, context);
  });
}
async function validateDraft(templateId, input, options = {}) {
  templateId = identity(templateId);
  command(input, ['expectedRevision', 'expectedDefinitionHash']);
  const revision = counter(input.expectedRevision);
  const hash = expectedHash(input.expectedDefinitionHash);
  return readTransaction(options, async (client) => {
    const row = await loadDraft(client, templateId);
    assertDraft(row, revision, hash);
    const compiled = await validateStored(client, row);
    return { valid: true, revision, definitionHash: compiled.hash, metrics: compiled.metrics, productionAcceptanceVerified: false };
  });
}
async function testPreview(templateId, input, options = {}) {
  templateId = identity(templateId);
  command(input, ['expectedRevision', 'expectedDefinitionHash', 'productIds']);
  const revision = counter(input.expectedRevision);
  const hash = expectedHash(input.expectedDefinitionHash);
  if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 100
    || input.productIds.some((id) => !Number.isInteger(id) || id <= 0 || id > 2147483647)
    || new Set(input.productIds).size !== input.productIds.length) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Provide 1–100 unique positive product IDs');
  }
  return readTransaction(options, async (client) => {
    const row = await loadDraft(client, templateId);
    assertDraft(row, revision, hash);
    const compiled = await validateStored(client, row);
    const { products, missingProductIds } = await loadDraftPreviewProducts(client, input.productIds);
    if (missingProductIds.length) throw error(422, 'TEMPLATE_PRODUCTS_MISSING', 'Requested products not found', { missingProductIds });
    return { revision, definitionHash: compiled.hash, draftOnly: true,
      result: pureCall(() => evaluateBatch(compiled, products)) };
  });
}
async function publishTemplate(templateId, input, options = {}) {
  templateId = identity(templateId);
  command(input, ['expectedRevision', 'expectedDefinitionHash']);
  const revision = counter(input.expectedRevision);
  const hash = expectedHash(input.expectedDefinitionHash);
  return mutation('publish', options, async (client, context) => {
    const row = await loadDraft(client, templateId, true);
    // Completed retries precede checking today's draft. Preserve original actor/time/version.
    const prior = (await client.query(`SELECT * FROM export_template_versions
      WHERE template_id = $1 AND source_draft_revision = $2`, [templateId, revision])).rows[0];
    if (prior) {
      if (prior.definition_hash !== hash) throw conflict('Source revision already published with another hash');
      verifyVersion(prior);
      return versionView(prior);
    }
    assertDraft(row, revision, hash);
    const compiled = await validateStored(client, row);
    if (compiled.hash !== hash) throw conflict();
    // MAX is protected by the family lock (and the shared access lock), never allocated unlocked.
    const version = (await client.query(`INSERT INTO export_template_versions
      (id, template_id, version_number, source_draft_revision, definition, definition_hash,
       format_version, evaluator_version, output_contract, published_by_user_id)
      SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3, $4::jsonb, $5, $6, $7, $8, $9
      FROM export_template_versions WHERE template_id = $2 RETURNING *`,
    [randomUUID(), templateId, revision, JSON.stringify(compiled.definition), compiled.hash,
      compiled.definition.formatVersion, compiled.definition.evaluatorVersion, compiled.definition.outputContract, context.actorUserId])).rows[0];
    verifyVersion(version);
    await audit(client, context, 'published', templateId, { templateId, templateVersionId: version.id,
      version: version.version_number, draftRevision: revision, definitionHash: hash });
    return versionView(version);
  });
}
async function getActivation(options = {}) {
  const row = (await (options.databasePool || pool).query('SELECT * FROM export_template_activation WHERE id = 1')).rows[0];
  return selectionView(row);
}
async function updateActivation(input, options = {}) {
  command(input, ['expectedGeneration', 'implementation', 'templateVersionId'], ['reason']);
  const generation = counter(input.expectedGeneration);
  const versionId = input.templateVersionId === null ? null : identity(input.templateVersionId);
  if (!['legacy', 'template'].includes(input.implementation) || (input.implementation === 'legacy') !== (versionId === null)
    || (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500))) {
    throw error(400, 'TEMPLATE_COMMAND_INVALID', 'Invalid selection pairing or reason');
  }
  return mutation('activate', options, async (client, context) => {
    const row = (await client.query('SELECT * FROM export_template_activation WHERE id = 1 FOR UPDATE')).rows[0];
    if (row.generation !== generation) throw error(409, 'TEMPLATE_ACTIVATION_CONFLICT', 'Selection generation changed');
    if (versionId) verifyVersion(await loadVersion(client, versionId));
    if (row.implementation === input.implementation && row.template_version_id === versionId) return selectionView(row);
    const next = (await client.query(`UPDATE export_template_activation SET generation = generation + 1,
      implementation = $1, template_version_id = $2, changed_by_user_id = $3, changed_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND generation = $4 RETURNING *`, [input.implementation, versionId, context.actorUserId, generation])).rows[0];
    await audit(client, context, 'activated', 'selection', { implementation: input.implementation,
      templateVersionId: versionId, previousTemplateVersionId: row.template_version_id,
      generationFrom: generation, generationTo: next.generation, reason: input.reason || null });
    return selectionView(next);
  });
}
async function listSources(options = {}) {
  return readTransaction(options, getSourceRegistry);
}

module.exports = { prepareDraft, counter, listTemplates, getTemplate, createTemplate, saveDraft, cloneDraft,
  validateDraft, testPreview, publishTemplate, getActivation, updateActivation, listSources };
