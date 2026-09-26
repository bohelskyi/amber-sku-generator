const { loadVersion, verifyVersion, pureCall } = require('./template.service');
const { loadSourceEvidence, validateSourceReferences } = require('./source-references');
const { evaluateBatch } = require('./evaluate');
const { loadSupportInputs } = require('./support-inputs');
const { error, fingerprint, stale } = require('./snapshot-binding');
const { assertActorStillAuthorized, APPLICATION_USER_ADMIN_LOCK_KEY } = require('../access-admin-transaction');

// Acquire before BEGIN: waiting for access administration must not freeze an old
// RR permission snapshot. Shared readers coexist; writers retain their existing
// exclusive lock. Always release on the same connection, after commit/rollback.
async function protectAuthority(client, actor, permission) {
  await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
  try { await assertActorStillAuthorized(client, actor, permission, error); }
  catch (cause) { await releaseAuthority(client); throw cause; }
}
async function releaseAuthority(client) {
  await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
}

async function resolvePublished(client, intent, actor, { lock = false, expected } = {}) {
  const selection = (await client.query(`SELECT * FROM export_template_activation WHERE id = 1${lock ? ' FOR SHARE' : ''}`)).rows[0];
  if (intent.selection.mode === 'active' && expected
    && (selection?.generation !== expected.activationGeneration || selection.template_version_id !== expected.versionId)) throw stale();
  const versionId = intent.selection.mode === 'explicit' ? intent.selection.versionId : selection?.template_version_id;
  if (!versionId) throw error(422, 'EXPORT_TEMPLATE_NOT_SELECTED', 'No published template selected for template-v1 exports');
  if (intent.selection.mode === 'explicit' && versionId !== selection?.template_version_id) {
    // Read-only permission query: protectAuthority already holds the access boundary.
    const result = await client.query(`SELECT EXISTS (
      SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id = u.id AND a.revoked_at IS NULL
      JOIN roles r ON r.id = a.role_id AND r.status = 'active'
      JOIN role_permissions p ON p.role_id = r.id
      WHERE u.id = $1 AND u.status = 'active' AND p.permission_key = 'export_templates.activate') AS allowed`, [actor]);
    if (!result.rows[0].allowed) throw error(403, 'INSUFFICIENT_PERMISSION', 'Selecting a non-active version requires export_templates.activate');
  }
  const row = await loadVersion(client, versionId, intent.selection.templateId);
  const compiled = verifyVersion(row);
  return { compiled, effective: { templateId: row.template_id, versionId: row.id,
    definitionHash: row.definition_hash, evaluatorVersion: row.evaluator_version,
    outputContract: row.output_contract, formatVersion: row.format_version,
    activationGeneration: intent.selection.mode === 'active' ? selection.generation : null } };
}

function relevantReferences(definition, evidence, products) {
  const sources = Object.values(definition.sources).filter((s) => s.kind !== 'product');
  const relevant = (category, key) => sources.some((s) => s.category === category && s.key === key);
  const schemaIds = new Set(products.map((p) => String(p.sku_schema_version_id)));
  return {
    categories: evidence.categories.filter((c) => definition.groups.some((g) => g.route === c)),
    questions: evidence.questions.filter((q) => relevant(q.category_code, q.key))
      .map(({ id, category_code, key, include_in_sku, input_type, value_ids }) =>
        ({ id, category_code, key, include_in_sku, input_type, value_ids })),
    schemas: evidence.schemas.map((s) => ({ ...s,
      questions: s.questions.filter((q) => schemaIds.has(String(s.id)) || relevant(s.category_code, q.key)) }))
      .filter((s) => schemaIds.has(String(s.id)) || s.questions.length),
  };
}

async function capturePublished(client, intent, resolved, exportData, newRange, presentation = {}) {
  const evidence = await loadSourceEvidence(client);
  const diagnostics = validateSourceReferences(resolved.compiled.definition, evidence);
  if (diagnostics.length) throw error(422, 'TEMPLATE_SOURCE_INVALID', 'Unresolved or conflicting source references', { diagnostics });
  const supported = await loadSupportInputs(client, resolved.compiled.definition, exportData.rows);
  const inputFingerprint = fingerprint({ intent, effective: resolved.effective,
    fullProductLifecycle: exportData.fullProductLifecycle,
    range: exportData.range, cursor: newRange ? String(newRange.cursor) : null,
    products: exportData.rows.map((p) => ({ id: String(p.id), full_sku: p.full_sku, category: p.category,
      exclude_from_export: p.exclude_from_export, weight: p.weight, total_price_uah: p.total_price_uah,
      answers: p.details?.answers, magento_name_subject_ua: p.magento_name_subject_ua,
      magento_name_subject_en: p.magento_name_subject_en, magento_name_review_required: p.magento_name_review_required,
      sku_schema_version_id: p.sku_schema_version_id })),
    references: relevantReferences(resolved.compiled.definition, evidence, exportData.rows),
    internalCatalog: exportData.internalCatalog,
    ...(resolved.compiled.definition.sourceSupport ? { supportSchemas: supported.schemas } : {}),
  });
  const binding = { intent, effective: resolved.effective, inputFingerprint,
    range: exportData.range, cursor: newRange ? String(newRange.cursor) : null };
  return { binding, magento: pureCall(() => evaluateBatch(resolved.compiled, supported.products, undefined, presentation)) };
}

module.exports = { protectAuthority, releaseAuthority, resolvePublished, capturePublished };
