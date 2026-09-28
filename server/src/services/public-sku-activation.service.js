const pool = require('../db/pool');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { runAccessAdminMutation } = require('./access-admin-transaction');
const { hash } = require('./magento/binding-contract');

function fail(code, message, details) {
  throw Object.assign(new Error(message), { statusCode: 409, code, details });
}

async function inspect(client, input) {
  if (typeof input.expectedDatabase !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(input.expectedDatabase)) {
    fail('PUBLIC_SKU_COMMAND_INVALID', 'Invalid expected database');
  }
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (database !== input.expectedDatabase) fail('PUBLIC_SKU_DATABASE_MISMATCH', 'Target database differs');
  const migration = (await client.query(
    "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='046_stable_public_product_sku.sql') AS applied"
  )).rows[0].applied;
  if (!migration) return { database, blockers: [{ code: 'PUBLIC_SKU_SCHEMA_NOT_READY' }] };
  const gate = (await client.query('SELECT * FROM public_sku_activation WHERE singleton')).rows[0];
  const delivery = (await client.query('SELECT enabled,legacy_product_csv_enabled FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  const inventory = (await client.query(`SELECT
    count(*)::int AS products,
    count(*) FILTER (WHERE p.public_product_identity_id IS NULL)::int AS missing_identity,
    count(*) FILTER (WHERE i.public_sku IS NULL OR btrim(i.public_sku)='')::int AS invalid_public_sku
    FROM products p LEFT JOIN public_product_identities i ON i.id=p.public_product_identity_id`)).rows[0];
  const duplicateCurrent = (await client.query(`SELECT count(*)::int AS count FROM (
    SELECT public_product_identity_id FROM products
    WHERE status='active' AND corrected_to_product_id IS NULL
    GROUP BY public_product_identity_id HAVING count(*)>1) d`)).rows[0].count;
  const lifecycle = (await client.query(`SELECT
    count(*) FILTER (WHERE f.route='normal' AND f.revision>GREATEST(f.confirmed_revision,f.cutover_baseline_revision,f.csv_retired_revision))::int AS pending_normal,
    count(*) FILTER (WHERE f.route='replacement' AND f.revision>GREATEST(f.confirmed_revision,f.cutover_baseline_revision,f.csv_retired_revision))::int AS pending_replacement
    FROM product_full_export_state f JOIN products p ON p.id=f.product_id
    WHERE p.status='active' AND p.corrected_to_product_id IS NULL`)).rows[0];
  const generated = (await client.query(`SELECT count(DISTINCT s.id)::int AS count
    FROM export_snapshots s JOIN magento_export_artifacts a ON a.snapshot_id=s.id
    WHERE s.status<>'confirmed'`)).rows[0].count;
  const activeSessions = (await client.query(`SELECT count(*)::int AS count FROM export_session_attempts a
    JOIN export_sessions s ON s.current_attempt_id=a.id
    WHERE a.state NOT IN ('succeeded','superseded')`)).rows[0].count;
  const automatic = (await client.query(`SELECT
    (SELECT count(*) FROM magento_product_sync_requests WHERE state<>'synced')::int AS requests,
    (SELECT count(*) FROM magento_sync_jobs
      WHERE state NOT IN ('succeeded','superseded'))::int AS jobs`)).rows[0];
  const blockers = [];
  if (Number(inventory.missing_identity) || Number(inventory.invalid_public_sku)) blockers.push({ code: 'PUBLIC_SKU_BACKFILL_INVALID' });
  if (Number(duplicateCurrent)) blockers.push({ code: 'PUBLIC_SKU_CURRENT_REVISION_AMBIGUOUS', count: Number(duplicateCurrent) });
  if (Number(lifecycle.pending_normal) || Number(lifecycle.pending_replacement)) blockers.push({ code: 'PUBLIC_SKU_LEGACY_QUEUE_PENDING' });
  if (Number(generated)) blockers.push({ code: 'PUBLIC_SKU_UNCONFIRMED_PRODUCT_FILES' });
  if (Number(activeSessions)) blockers.push({ code: 'PUBLIC_SKU_SHARED_EXPORT_ACTIVE' });
  if (Number(automatic.requests) || Number(automatic.jobs)) blockers.push({ code: 'PUBLIC_SKU_AUTOMATIC_WORK_UNRESOLVED' });
  if (delivery.enabled || !delivery.legacy_product_csv_enabled) blockers.push({ code: 'PUBLIC_SKU_DELIVERY_GATE_UNEXPECTED' });
  return { database, gate: { enabled: gate.enabled, activatedAt: gate.activated_at },
    delivery: { automaticEnabled: delivery.enabled, legacyProductCsvEnabled: delivery.legacy_product_csv_enabled },
    inventory: { products: Number(inventory.products), duplicateCurrent: Number(duplicateCurrent) },
    legacy: { pendingNormal: Number(lifecycle.pending_normal), pendingReplacement: Number(lifecycle.pending_replacement),
      generatedUnconfirmedSnapshots: Number(generated), activeSharedAttempts: Number(activeSessions) },
    automatic: { requests: Number(automatic.requests), jobs: Number(automatic.jobs) }, blockers };
}

function planFor(report) {
  const stable = { ...report };
  delete stable.blockers;
  delete stable.gate;
  return { ...stable, gate: report.gate ? { enabled: report.gate.enabled } : null };
}

async function preflight(input, options = {}) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await inspect(client, input);
    await client.query('COMMIT');
    const plan = planFor(report);
    return { artifactVersion: 1, kind: 'amber-public-sku-activation-preflight', checkedAt: new Date().toISOString(),
      plan, planHash: hash(plan), blockers: report.blockers };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function apply(input, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(input.planHash || '')) fail('PUBLIC_SKU_COMMAND_INVALID', 'Invalid plan hash');
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish',
    createError: (statusCode, code, message, details) => Object.assign(new Error(message), { statusCode, code, details }),
    operation: async (client) => {
      const gate = (await client.query('SELECT * FROM public_sku_activation WHERE singleton FOR UPDATE')).rows[0];
      if (gate.enabled) return { alreadyApplied: true, enabled: true, activatedAt: gate.activated_at };
      const report = await inspect(client, input);
      if (hash(planFor(report)) !== input.planHash) fail('PUBLIC_SKU_PREFLIGHT_STALE', 'Activation preflight changed');
      if (report.blockers.length) fail('PUBLIC_SKU_ACTIVATION_BLOCKED', 'Activation preflight has blockers', { blockers: report.blockers });
      const event = await writeAuditEvent(client, { mutationContext: context, eventKey: 'public_sku.activated',
        subjectType: 'public_sku_activation', subjectId: 'singleton', details: { planHash: input.planHash,
          productCount: report.inventory.products } });
      await client.query("SET LOCAL amber.public_sku_activation='on'");
      const updated = (await client.query(`UPDATE public_sku_activation SET enabled=TRUE,
        activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2
        WHERE singleton RETURNING *`, [context.actorUserId, event.id])).rows[0];
      return { alreadyApplied: false, enabled: true, activatedAt: updated.activated_at,
        activationEventId: Number(updated.activation_event_id), writersRemainFrozen: true };
    } });
}

module.exports = { inspect, planFor, preflight, apply };
