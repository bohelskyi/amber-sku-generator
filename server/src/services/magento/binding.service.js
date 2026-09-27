const { randomUUID } = require('node:crypto');
const pool = require('../../db/pool');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { compileDefinition } = require('../export-templates/definition');
const { loadSourceEvidence, validateSourceReferences } = require('../export-templates/source-references');
const c = require('./binding-contract');
const { normalizeBindings, requirements, validateBindings } = require('./binding-validation');
const repository = require('./binding-repository');

const conflict = () => { throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Binding revision or current publication changed'); };
async function read(options, operation) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (cause) { await client.query('ROLLBACK'); throw cause; }
  finally { client.release(); }
}
async function mutate(capability, options, operation) {
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: `export_templates.${capability}`, createError: c.error,
    operation: (client) => operation(client, context) });
}
async function lockInstallation(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${key}`]);
}
async function audit(client, context, action, row) {
  await writeAuditEvent(client, { mutationContext: context, eventKey: `magento_binding.${action}`,
    subjectType: 'magento_binding', subjectId: row.id, details: { bindingRevision: row.revision,
      versionNumber: row.version_number, templateVersionId: row.template_version_id } });
}
async function template(client, id) {
  const row = (await client.query('SELECT * FROM export_template_versions WHERE id=$1', [id])).rows[0];
  if (!row) throw c.error(404, 'TEMPLATE_VERSION_NOT_FOUND', 'Published template not found');
  const compiled = compileDefinition(row.definition);
  if (compiled.hash !== row.definition_hash || row.evaluator_version !== compiled.definition.evaluatorVersion
    || row.output_contract !== compiled.definition.outputContract || row.format_version !== compiled.definition.formatVersion) {
    throw c.error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Stored template identity is inconsistent');
  }
  return { row, compiled };
}
async function load(client, id, lock = false) {
  const loaded = await repository.load(client, id, lock);
  if (!loaded) throw c.error(404, 'MAGENTO_BINDING_NOT_FOUND', 'Binding revision not found');
  loaded.schema = c.normalizeSchema(loaded.schema);
  if (c.hash(loaded.schema) !== loaded.row.schema_fingerprint
    || c.hash(loaded.schema.storeTopology) !== loaded.row.topology_fingerprint) {
    throw c.error(409, 'MAGENTO_BINDING_OBSERVATION_INTEGRITY', 'Stored schema observation is inconsistent');
  }
  loaded.bindings = normalizeBindings(loaded.bindings);
  return loaded;
}
function view({ row, bindings, schema }) {
  return { id: row.id, installationKey: row.installation_key, originHash: row.origin_hash,
    state: row.state, revision: row.revision, versionNumber: row.version_number,
    templateId: row.template_id, templateVersionId: row.template_version_id, definitionHash: row.template_definition_hash,
    evaluatorVersion: row.evaluator_version, outputContract: row.output_contract, formatVersion: row.format_version,
    schemaFingerprint: row.schema_fingerprint, topologyFingerprint: row.topology_fingerprint,
    observedAt: row.observed_at, createdAt: row.created_at, modifiedAt: row.modified_at, publishedAt: row.published_at,
    createdByUserId: row.created_by_user_id, modifiedByUserId: row.modified_by_user_id, publishedByUserId: row.published_by_user_id,
    bindings, schema };
}
function assertValid(result) {
  if (!result.valid) throw c.error(422, 'MAGENTO_BINDING_INVALID', 'Binding validation failed', { diagnostics: result.diagnostics });
}
async function createDraft(input, options = {}) {
  return mutate('manage', options, (client, context) => createDraftOnClient(client, context, input));
}
// Internal: caller owns the authorized transaction, lifecycle gate and permission rechecks.
async function createDraftOnClient(client, context, input) {
  c.command(input, ['installationKey','origin','templateVersionId','observedAt','schema'], ['bindings']);
  const key = c.installation(input.installationKey); const origin = c.originHash(input.origin);
  const versionId = c.identity(input.templateVersionId);
  if (typeof input.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(input.observedAt)
    || !Number.isFinite(Date.parse(input.observedAt))) c.invalid();
  const schema = c.normalizeSchema(input.schema);

    await lockInstallation(client, key);
    const existing = (await client.query('SELECT origin_hash FROM magento_binding_revisions WHERE installation_key=$1 LIMIT 1', [key])).rows[0];
    if (existing && existing.origin_hash !== origin) conflict();
    const t = await template(client, versionId);
    const plans = requirements(t.compiled.definition, schema);
    const seeded = input.bindings ? normalizeBindings(input.bindings) : null;
    if (seeded) {
      if (Object.values(seeded).flat().some((r) => r.reviewState === 'approved'
        || r.evidence?.categories?.some((v) => v.reviewState === 'approved'))) c.invalid();
      assertValid(validateBindings(seeded, t.compiled.definition, schema));
    }
    const row = (await client.query(`INSERT INTO magento_binding_revisions
      (id, installation_key, origin_hash, template_id, template_version_id, template_definition_hash,
       evaluator_version, output_contract, format_version, schema_fingerprint, topology_fingerprint,
       observed_at, observation_store_code, created_by_user_id, modified_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
    [randomUUID(), key, origin, t.row.template_id, versionId, t.row.definition_hash, t.row.evaluator_version,
      t.row.output_contract, t.row.format_version, c.hash(schema), c.hash(schema.storeTopology), input.observedAt,
      schema.storeCode, context.actorUserId])).rows[0];
    await repository.insertSchema(client, row.id, schema);
    // Scope starts disabled and unresolved. No schema-label candidate is ever approved here.
    const bindings = seeded || normalizeBindings({ routes: plans.map((p) => ({ routeKey: p.routeKey, enabled: false,
      setId: null, reviewState: 'review_required' })), attributes: [], options: [], policies: [] });
    await repository.replaceBindings(client, row.id, bindings, plans);
    await audit(client, context, 'created', row);
    return view(await load(client, row.id));

}
async function updateDraft(id, input, options = {}) {
  c.identity(id); c.command(input, ['expectedRevision','bindings']);
  const expected = c.counter(input.expectedRevision); const bindings = normalizeBindings(input.bindings);
  return mutate('manage', options, async (client, context) => {
    const loaded = await load(client, id, true);
    if (loaded.row.state !== 'draft' || loaded.row.revision !== expected) conflict();
    const t = await template(client, loaded.row.template_version_id);
    const validated = validateBindings(bindings, t.compiled.definition, loaded.schema);
    assertValid(validated);
    await repository.replaceBindings(client, id, bindings, validated.requirements);
    loaded.row = (await client.query(`UPDATE magento_binding_revisions SET revision=revision+1,
      modified_by_user_id=$2, modified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id, context.actorUserId])).rows[0];
    await audit(client, context, 'draft_updated', loaded.row);
    return view(await load(client, id));
  });
}
async function validateStored(client, loaded) {
  const t = await template(client, loaded.row.template_version_id);
  const result = validateBindings(loaded.bindings, t.compiled.definition, loaded.schema, { publish: true });
  // Reuse authoritative repository semantic evidence. No SKU-digit or label inference.
  const evidence = await loadSourceEvidence(client);
  const sourceDiagnostics = validateSourceReferences(t.compiled.definition, evidence);
  for (const option of loaded.bindings.options.filter((o) => o.sourceKind === 'semantic')) {
    const current = evidence.questions.filter((q) => q.category_code === option.amberGroup && q.key === option.questionKey);
    // A reviewed unsupported identity may exist only in the current catalog (AR 29-31).
    // This permits recording a refusal, never approving a mapping without SKU history.
    const known = current.length <= 1 && (current.some((q) => (Number(q.include_in_sku) === 0 || option.reviewState === 'blocked') && q.value_ids.includes(option.valueId))
      || evidence.schemas.some((s) => s.category_code === option.amberGroup && s.questions.some((q) => q.key === option.questionKey && q.value_ids.includes(option.valueId))));
    const enabled = loaded.bindings.routes.some((r) => r.enabled && r.reviewState !== 'blocked'
      && loaded.bindings.attributes.some((a) => a.routeKey === r.routeKey && a.bindingKey === option.bindingKey && a.reviewState !== 'blocked'));
    if (!known && (enabled || ['approved','blocked'].includes(option.reviewState))) sourceDiagnostics.push({ code: 'SEMANTIC_IDENTITY_UNRESOLVED', bindingKey: option.bindingKey, sourceKey: option.sourceKey });
  }
  result.diagnostics.push(...sourceDiagnostics);
  result.valid = result.diagnostics.length === 0;
  return result;
}
async function validateDraft(id, options = {}) {
  c.identity(id);
  return read(options, async (client) => {
    const loaded = await load(client, id);
    return { id, revision: loaded.row.revision, ...await validateStored(client, loaded) };
  });
}
async function publishDraft(id, input, options = {}) {
  c.identity(id); c.command(input, ['expectedRevision','expectedCurrentId']);
  const expected = c.counter(input.expectedRevision);
  if (input.expectedCurrentId !== null) c.identity(input.expectedCurrentId);
  return mutate('publish', options, async (client, context) => {
    const summary = (await client.query('SELECT installation_key FROM magento_binding_revisions WHERE id=$1', [id])).rows[0];
    if (!summary) throw c.error(404, 'MAGENTO_BINDING_NOT_FOUND', 'Binding revision not found');
    await lockInstallation(client, summary.installation_key);
    const loaded = await load(client, id, true);
    // A completed retry returns the original immutable receipt, even after supersession.
    if (loaded.row.state === 'published') {
      if (BigInt(loaded.row.revision) !== BigInt(expected) + 1n) conflict();
      return view(loaded);
    }
    if (loaded.row.revision !== expected) conflict();
    const current = await repository.current(client, loaded.row.installation_key);
    if ((current?.id || null) !== input.expectedCurrentId) conflict();
    assertValid(await validateStored(client, loaded));
    loaded.row = (await client.query(`UPDATE magento_binding_revisions SET state='published', revision=revision+1,
      version_number=$2, published_by_user_id=$3, modified_by_user_id=$3,
      published_at=CURRENT_TIMESTAMP, modified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`,
    [id, current ? (BigInt(current.version_number) + 1n).toString() : '1', context.actorUserId])).rows[0];
    await audit(client, context, 'published', loaded.row);
    return view(loaded);
  });
}
// Trusted server readers can include the revision in their own coherent read-only snapshot.
async function readRevisionOnClient(client, id) { c.identity(id); return view(await load(client, id)); }
async function getRevision(id, options = {}) { return read(options, (client) => readRevisionOnClient(client, id)); }
async function getCurrentPublished(key, options = {}) {
  c.installation(key);
  return read(options, async (client) => { const row = await repository.current(client, key); return row ? view(await load(client, row.id)) : null; });
}
async function listRevisions(key, options = {}) {
  c.installation(key);
  return read(options, async (client) => (await client.query(`SELECT id, state, revision, version_number,
    template_version_id, created_at, published_at, created_by_user_id, published_by_user_id,
    CASE WHEN state='published' AND version_number < max(version_number) OVER () THEN 'superseded' ELSE state END AS lifecycle
    FROM magento_binding_revisions WHERE installation_key=$1 ORDER BY created_at DESC, id`, [key])).rows);
}
module.exports = { createDraftOnClient, createDraft, updateDraft, validateDraft, publishDraft, getRevision, getCurrentPublished, listRevisions, readRevisionOnClient };
