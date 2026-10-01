const pool = require('../../db/pool');
const c = require('./binding-contract');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation } = require('../access-admin-transaction');

const REQUIRED_MIGRATIONS = Object.freeze([
  '041_magento_binding_revisions.sql',
  '042_magento_sync_jobs.sql',
  '043_magento_literal_question_keys.sql',
  '044_magento_automatic_sync.sql',
  '045_magento_delivery_cutover.sql',
  '046_stable_public_product_sku.sql',
  '048_external_magento_delivery_acknowledgement.sql',
]);

function fail(code, message, details) {
  throw c.error(409, code, message, details);
}

async function assertDatabase(client, expectedDatabase) {
  if (typeof expectedDatabase !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(expectedDatabase)) c.invalid();
  const actual = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (actual !== expectedDatabase) fail('MAGENTO_CUTOVER_DATABASE_MISMATCH', 'Target database differs', { expectedDatabase, actualDatabase: actual });
  return actual;
}

async function actorState(client, actorUserId) {
  return (await client.query(`SELECT u.status,
    EXISTS(SELECT 1 FROM user_role_assignments a JOIN roles r ON r.id=a.role_id AND r.status='active'
      JOIN role_permissions p ON p.role_id=r.id
      WHERE a.application_user_id=u.id AND a.revoked_at IS NULL AND p.permission_key='export_templates.publish') AS authorized
    FROM application_users u WHERE u.id=$1`, [actorUserId])).rows[0] || null;
}

async function idSummary(client, sql, values = []) {
  const rows = (await client.query(sql, values)).rows;
  const ids = rows.map((row) => String(row.id));
  return { count: ids.length, identityHash: c.hash(ids), examples: ids.slice(0, 100) };
}

async function inspectClient(client, { expectedDatabase, installationKey, actorUserId, origin }) {
  const database = await assertDatabase(client, expectedDatabase);
  const installation = c.installation(installationKey);
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) c.invalid();
  const expectedOriginHash = c.originHash(origin);
  const migrations = (await client.query('SELECT name FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name', [REQUIRED_MIGRATIONS])).rows.map((r) => r.name);
  const missingMigrations = REQUIRED_MIGRATIONS.filter((name) => !migrations.includes(name));
  const gatePresent = (await client.query("SELECT to_regclass('magento_auto_sync_activation') IS NOT NULL AS present")).rows[0].present;
  if (!gatePresent || missingMigrations.includes('045_magento_delivery_cutover.sql')
    || missingMigrations.includes('046_stable_public_product_sku.sql')) return { database, installationKey: installation, expectedOriginHash, missingMigrations,
    blockers: [{ code: 'MAGENTO_CUTOVER_SCHEMA_NOT_READY' }] };
  const gate = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  const publicActivation = (await client.query('SELECT * FROM public_sku_activation WHERE singleton')).rows[0];
  const published = (await client.query(`SELECT r.id,r.revision,r.version_number,r.origin_hash,r.template_version_id,
      v.evaluator_version,v.definition->>'sourceContractVersion' AS source_contract_version
    FROM magento_binding_revisions r JOIN export_template_versions v ON v.id=r.template_version_id
    WHERE r.installation_key=$1 AND r.state='published'
    ORDER BY version_number DESC LIMIT 1`, [installation])).rows[0] || null;
  const actor = await actorState(client, actorUserId);
  const automaticJobs = await idSummary(client, `SELECT id FROM magento_sync_jobs
    WHERE automatic_generation IS NOT NULL AND state NOT IN ('succeeded','superseded') ORDER BY id`);
  const automaticRequests = await idSummary(client, `SELECT public_product_identity_id AS id FROM magento_product_sync_requests
    WHERE state<>'synced' ORDER BY public_product_identity_id`);
  const generatedProductSnapshots = await idSummary(client, `SELECT DISTINCT s.id
    FROM export_snapshots s JOIN magento_export_artifacts a ON a.snapshot_id=s.id
    WHERE s.status<>'confirmed' ORDER BY s.id`);
  const activeSessionAttempts = await idSummary(client, `SELECT a.id FROM export_session_attempts a
    JOIN export_sessions s ON s.current_attempt_id=a.id
    WHERE a.state NOT IN ('succeeded','superseded') ORDER BY a.id`);
  const lifecycle = (await client.query(`SELECT
    count(*) FILTER (WHERE f.route='normal' AND f.revision>GREATEST(f.confirmed_revision,f.cutover_baseline_revision,f.externally_delivered_revision,f.csv_retired_revision))::int AS pending_normal,
    count(*) FILTER (WHERE f.route='replacement' AND f.revision>GREATEST(f.confirmed_revision,f.cutover_baseline_revision,f.externally_delivered_revision,f.csv_retired_revision))::int AS pending_replacement,
    count(*) FILTER (WHERE f.route='hold' OR f.business_exclusion_state<>'none' OR f.recount_compatibility_excluded)::int AS held
    FROM product_full_export_state f JOIN products p ON p.id=f.product_id
    WHERE p.status='active' AND p.corrected_to_product_id IS NULL`)).rows[0];
  const fullProductGate = (await client.query('SELECT phase,generation,selector_version FROM full_product_export_activation WHERE singleton')).rows[0];
  const blockers = [];
  if (missingMigrations.length) blockers.push({ code: 'MAGENTO_CUTOVER_SCHEMA_NOT_READY', missingMigrations });
  if (!published) blockers.push({ code: 'MAGENTO_CUTOVER_PUBLICATION_REQUIRED' });
  else if (published.origin_hash !== expectedOriginHash) blockers.push({ code: 'MAGENTO_CUTOVER_ORIGIN_MISMATCH' });
  else if (published.evaluator_version !== 'magento-declarative-3'
    || published.source_contract_version !== 'public-product-identity-v1') {
    blockers.push({ code: 'MAGENTO_CUTOVER_PUBLIC_SKU_PUBLICATION_REQUIRED' });
  }
  if (!publicActivation?.enabled) blockers.push({ code: 'MAGENTO_CUTOVER_PUBLIC_SKU_ACTIVATION_REQUIRED' });
  if (!actor || actor.status !== 'active' || !actor.authorized) blockers.push({ code: 'MAGENTO_CUTOVER_WORKER_ACTOR_INVALID' });
  if (automaticJobs.count || automaticRequests.count) blockers.push({ code: 'MAGENTO_CUTOVER_AUTOMATIC_WORK_UNRESOLVED' });
  if (generatedProductSnapshots.count) blockers.push({ code: 'MAGENTO_CUTOVER_UNCONFIRMED_PRODUCT_FILES' });
  if (activeSessionAttempts.count) blockers.push({ code: 'MAGENTO_CUTOVER_SHARED_WORK_UNRESOLVED' });
  if (Number(lifecycle.pending_normal) || Number(lifecycle.pending_replacement)) blockers.push({ code: 'MAGENTO_CUTOVER_LEGACY_QUEUE_UNRESOLVED' });
  if (gate.installation_key && gate.installation_key !== installation) blockers.push({ code: 'MAGENTO_CUTOVER_INSTALLATION_MISMATCH' });
  return {
    database, installationKey: installation, expectedOriginHash,
    gate: { enabled: gate.enabled, installationKey: gate.installation_key,
      actorUserId: gate.actor_user_id === null ? null : Number(gate.actor_user_id),
      legacyProductCsvEnabled: gate.legacy_product_csv_enabled,
      cutoverAt: gate.cutover_at, cutoverByUserId: gate.cutover_by_user_id === null ? null : Number(gate.cutover_by_user_id),
      cutoverEventId: gate.cutover_event_id === null ? null : Number(gate.cutover_event_id) },
    published: published ? { id: published.id, revision: published.revision, versionNumber: published.version_number,
      templateVersionId: published.template_version_id, evaluatorVersion: published.evaluator_version,
      sourceContractVersion: published.source_contract_version } : null,
    publicSkuActivation: { enabled: Boolean(publicActivation?.enabled), activatedAt: publicActivation?.activated_at || null },
    actor: actor ? { active: actor.status === 'active', authorized: actor.authorized } : null,
    fullProductGate,
    legacy: { generatedProductSnapshots, activeSessionAttempts,
      pendingNormal: Number(lifecycle.pending_normal), pendingReplacement: Number(lifecycle.pending_replacement),
      held: Number(lifecycle.held) },
    automatic: { jobs: automaticJobs, requests: automaticRequests },
    missingMigrations, blockers,
  };
}

function planFor(report) {
  const stable = { ...report };
  delete stable.gate;
  delete stable.blockers;
  return { ...stable, gate: report.gate ? { enabled: report.gate.enabled,
    installationKey: report.gate.installationKey, actorUserId: report.gate.actorUserId,
    legacyProductCsvEnabled: report.gate.legacyProductCsvEnabled } : null };
}

async function preflight(input, options = {}) {
  const db = options.databasePool || pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await inspectClient(client, input);
    await client.query('COMMIT');
    const plan = planFor(report);
    return { artifactVersion: 1, kind: 'amber-magento-delivery-cutover-preflight', checkedAt: new Date().toISOString(),
      plan, planHash: c.hash(plan), blockers: report.blockers };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function apply(input, options = {}) {
  c.command(input, ['expectedDatabase','installationKey','actorUserId','origin','planHash']);
  if (!/^[a-f0-9]{64}$/.test(input.planHash)) c.invalid();
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish', createError: c.error, operation: async (client) => {
      const gate = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton FOR UPDATE')).rows[0];
      if (!gate.legacy_product_csv_enabled) {
        if (gate.enabled && gate.installation_key === input.installationKey && Number(gate.actor_user_id) === input.actorUserId) {
          return { alreadyApplied: true, enabled: true, installationKey: gate.installation_key,
            legacyProductCsvEnabled: false, cutoverAt: gate.cutover_at };
        }
        fail('MAGENTO_CUTOVER_ALREADY_RETIRED', 'CSV is already retired and automatic sync is not in the requested state');
      }
      const report = await inspectClient(client, input);
      const plan = planFor(report);
      if (c.hash(plan) !== input.planHash) fail('MAGENTO_CUTOVER_PREFLIGHT_STALE', 'Cutover preflight changed');
      if (report.blockers.length) fail('MAGENTO_CUTOVER_BLOCKED', 'Cutover preflight has unresolved risks', { blockers: report.blockers });
      const receipt = await writeAuditEvent(client, { mutationContext: context, eventKey: 'magento_delivery.cutover',
        subjectType: 'magento_delivery', subjectId: input.installationKey,
        details: { planHash: input.planHash, bindingRevisionId: report.published.id,
          bindingVersionNumber: report.published.versionNumber, heldLegacyCount: report.legacy.held } });
      await client.query("SET LOCAL amber.magento_delivery_cutover = 'on'");
      const updated = (await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,
        installation_key=$1,actor_user_id=$2,legacy_product_csv_enabled=FALSE,
        cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3
        WHERE singleton RETURNING *`, [input.installationKey, input.actorUserId, receipt.id])).rows[0];
      return { alreadyApplied: false, enabled: updated.enabled, installationKey: updated.installation_key,
        actorUserId: Number(updated.actor_user_id), legacyProductCsvEnabled: updated.legacy_product_csv_enabled,
        cutoverAt: updated.cutover_at, cutoverEventId: Number(updated.cutover_event_id) };
    } });
}

async function disable(input, options = {}) {
  c.command(input, ['expectedDatabase','actorUserId','reason']);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) c.invalid();
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish', createError: c.error, operation: async (client) => {
      await assertDatabase(client, input.expectedDatabase);
      const gate = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton FOR UPDATE')).rows[0];
      if (gate.legacy_product_csv_enabled) fail('MAGENTO_CUTOVER_NOT_APPLIED', 'CSV retirement has not been applied');
      if (!gate.enabled) return { alreadyDisabled: true, legacyProductCsvEnabled: false };
      await writeAuditEvent(client, { mutationContext: context, eventKey: 'magento_delivery.disabled',
        subjectType: 'magento_delivery', subjectId: gate.installation_key,
        details: { reason: input.reason.trim(), csvRemainsRetired: true } });
      await client.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton');
      return { alreadyDisabled: false, enabled: false, legacyProductCsvEnabled: false };
    } });
}

module.exports = { REQUIRED_MIGRATIONS, inspectClient, planFor, preflight, apply, disable };
