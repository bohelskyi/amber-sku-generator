const pool = require('../db/pool');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { runAccessAdminMutation } = require('./access-admin-transaction');
const { retireFullProduct } = require('./full-product-export.service');

const FORMAT = 'amber-legacy-sku-repair-plan-v1';
const EVENT = 'legacy_sku_repair.staged';
const RECEIPT_FORMAT = 'amber-legacy-sku-repair-staging-receipt-v2';
const REQUIRED_MIGRATIONS = Object.freeze([
  '039_full_product_export_lifecycle.sql',
  '040_full_product_export_cutover.sql',
  '041_magento_binding_revisions.sql',
  '042_magento_sync_jobs.sql',
  '043_magento_literal_question_keys.sql',
  '044_magento_automatic_sync.sql',
  '045_magento_delivery_cutover.sql',
]);

function fail(code, message, details, statusCode = 409) {
  throw Object.assign(new Error(message), { code, details, statusCode });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactObject(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

async function sealJson(client, value) {
  const row = (await client.query(`SELECT canonical,
      encode(sha256(convert_to(canonical,'UTF8')),'hex') AS hash
    FROM (SELECT $1::jsonb::text AS canonical) sealed`, [JSON.stringify(value)])).rows[0];
  return { canonical: row.canonical, hash: row.hash };
}

async function hashJson(client, value) {
  return (await sealJson(client, value)).hash;
}

function normalizeDecisions(input) {
  if (!exactObject(input, ['version', 'groups']) || input.version !== 1
    || !Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 100) {
    fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'Decision artifact must use version 1 with bounded groups', null, 422);
  }
  const seenSkus = new Set();
  const seenProducts = new Set();
  const groups = input.groups.map((group) => {
    if (!group || Object.getPrototypeOf(group) !== Object.prototype) {
      fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'Decision group is invalid', null, 422);
    }
    const allowed = group.action === 'deduplicate'
      ? ['sku', 'action', 'keeperProductId', 'retireProductIds', 'reason']
      : group.action === 'split_public_identity'
        ? ['sku', 'action', 'keeperProductId', 'splitProductIds', 'reason'] : [];
    if (!allowed.length || !exactObject(group, allowed)) {
      fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'Decision group shape or action is invalid', null, 422);
    }
    const sku = String(group.sku || '');
    const reason = String(group.reason || '').trim();
    const targetKey = group.action === 'deduplicate' ? 'retireProductIds' : 'splitProductIds';
    const targetProductIds = group[targetKey];
    if (!sku || sku !== sku.trim().toUpperCase() || sku.length > 256
      || !positiveInteger(group.keeperProductId) || !reason || reason.length > 500
      || !Array.isArray(targetProductIds) || targetProductIds.length < 1 || targetProductIds.length > 100
      || targetProductIds.some((id) => !positiveInteger(id))
      || new Set(targetProductIds).size !== targetProductIds.length
      || targetProductIds.includes(group.keeperProductId)) {
      fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'Decision values are invalid', null, 422);
    }
    if (seenSkus.has(sku)) fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'Each SKU may appear once', null, 422);
    seenSkus.add(sku);
    for (const id of [group.keeperProductId, ...targetProductIds]) {
      if (seenProducts.has(id)) fail('LEGACY_SKU_REPAIR_DECISIONS_INVALID', 'A product may appear in only one decision', null, 422);
      seenProducts.add(id);
    }
    return {
      sku,
      action: group.action,
      keeperProductId: group.keeperProductId,
      targetProductIds: [...targetProductIds].sort((a, b) => a - b),
      reason,
    };
  }).sort((left, right) => left.sku.localeCompare(right.sku, 'en'));
  return Object.freeze({ version: 1, groups });
}

function withoutBusinessIdentity(row) {
  const copy = { ...row };
  delete copy.id;
  delete copy.created_at;
  return copy;
}

async function actorState(client, actorUserId) {
  return (await client.query(`SELECT u.status,
    EXISTS(SELECT 1 FROM user_role_assignments a
      JOIN roles r ON r.id=a.role_id AND r.status='active'
      JOIN role_permissions p ON p.role_id=r.id
      WHERE a.application_user_id=u.id AND a.revoked_at IS NULL
        AND p.permission_key='exports.reconcile') AS authorized
    FROM application_users u WHERE u.id=$1`, [actorUserId])).rows[0] || null;
}

async function productEvidence(client, productId) {
  const lineage = await client.query(`SELECT
    ARRAY(SELECT id FROM product_corrections WHERE source_product_id=$1 OR corrected_product_id=$1 ORDER BY id) AS corrections,
    ARRAY(SELECT id FROM correction_requests WHERE source_product_id=$1 OR corrected_product_id=$1 ORDER BY id) AS requests`, [productId]);
  const snapshots = await client.query(`SELECT
    ARRAY(SELECT snapshot_id FROM export_snapshot_products WHERE product_id=$1 ORDER BY snapshot_id) AS exact_memberships,
    ARRAY(SELECT s.id FROM export_snapshots s, LATERAL jsonb_array_elements(s.reexport_revisions) item
      WHERE item->>'productId'=$1::text ORDER BY s.id) AS reexport_snapshots,
    ARRAY(SELECT s.id FROM price_export_snapshots s, LATERAL jsonb_array_elements(s.captured_revisions) item
      WHERE item->>'productId'=$1::text ORDER BY s.id) AS price_snapshots`, [productId]);
  const price = await client.query(`SELECT revision,confirmed_revision,has_product_snapshot
    FROM product_export_revisions WHERE product_id=$1`, [productId]);
  const sync = await client.query(`SELECT
    ARRAY(SELECT id FROM magento_sync_jobs WHERE product_id=$1 ORDER BY id) AS jobs,
    EXISTS(SELECT 1 FROM magento_product_sync_requests WHERE product_id=$1) AS request`, [productId]);
  const result = {
    lineage: lineage.rows[0],
    external: {
      ...snapshots.rows[0],
      priceRevision: price.rows[0] || null,
      magentoJobs: sync.rows[0].jobs,
      magentoRequest: sync.rows[0].request,
    },
  };
  const exactIndependentEvidence = Boolean(
    result.external.exact_memberships.length
    || result.external.reexport_snapshots.length
    || result.external.price_snapshots.length
    || result.external.magentoJobs.length
    || result.external.magentoRequest
  );
  const strongerRevisionEvidence = Boolean(
    Number(result.external.priceRevision?.revision || 0) > 0
    || Number(result.external.priceRevision?.confirmed_revision || 0) > 0
  );
  result.external.coarseLegacyExposure = Boolean(
    result.external.priceRevision?.has_product_snapshot
    && !strongerRevisionEvidence
    && !exactIndependentEvidence
  );
  result.external.independentlyRepresented = exactIndependentEvidence || strongerRevisionEvidence;
  return result;
}

function blocker(code, group, details = {}) {
  return { code, sku: group.sku, ...details };
}

async function inspectGroup(client, group, blockers) {
  const rows = (await client.query(`SELECT to_jsonb(p) AS product
    FROM products p WHERE p.full_sku=$1 ORDER BY p.id`, [group.sku])).rows.map((row) => row.product);
  const registryRows = (await client.query('SELECT to_jsonb(r) AS reservation FROM sku_registry r WHERE r.full_sku=$1',
    [group.sku])).rows.map((row) => row.reservation);
  const ids = rows.map((row) => Number(row.id));
  const relevantIds = [group.keeperProductId, ...group.targetProductIds].sort((a, b) => a - b);
  const currentIds = rows.filter((row) => row.status === 'active' && row.corrected_to_product_id === null)
    .map((row) => Number(row.id)).sort((a, b) => a - b);
  if (!rows.length || relevantIds.some((id) => !ids.includes(id))) {
    blockers.push(blocker('LEGACY_SKU_REPAIR_PRODUCT_MISSING', group));
  }
  if (JSON.stringify(currentIds) !== JSON.stringify(relevantIds)) {
    blockers.push(blocker('LEGACY_SKU_REPAIR_CURRENT_SET_MISMATCH', group, { currentProductIds: currentIds }));
  }
  if (registryRows.length !== 1 || Number(registryRows[0]?.first_product_id) !== group.keeperProductId) {
    blockers.push(blocker('LEGACY_SKU_REPAIR_REGISTRY_OWNER_MISMATCH', group));
  }
  const lifecycleRows = ids.length ? (await client.query(`SELECT to_jsonb(f) AS lifecycle
    FROM product_full_export_state f WHERE f.product_id=ANY($1::int[]) ORDER BY f.product_id`, [ids]))
    .rows.map((row) => row.lifecycle) : [];
  if (lifecycleRows.length !== ids.length) blockers.push(blocker('LEGACY_SKU_REPAIR_LIFECYCLE_MISSING', group));
  const lifecycleById = new Map(lifecycleRows.map((row) => [Number(row.product_id), row]));
  const products = [];
  for (const row of rows) {
    const evidence = await productEvidence(client, Number(row.id));
    const lifecycle = lifecycleById.get(Number(row.id)) || null;
    const product = {
      id: Number(row.id),
      row,
      rowHash: await hashJson(client, row),
      businessRowHash: await hashJson(client, withoutBusinessIdentity(row)),
      lifecycle,
      lifecycleHash: lifecycle ? await hashJson(client, lifecycle) : null,
      ...evidence,
    };
    products.push(product);
    if (relevantIds.includes(product.id)) {
      if (row.status !== 'active' || row.corrected_to_product_id !== null) {
        blockers.push(blocker('LEGACY_SKU_REPAIR_PRODUCT_NOT_CURRENT', group, { productId: product.id }));
      }
      if (row.corrected_from_product_id !== null || row.corrected_to_product_id !== null
        || product.lineage.corrections.length || product.lineage.requests.length) {
        blockers.push(blocker('LEGACY_SKU_REPAIR_LINEAGE_AMBIGUOUS', group, { productId: product.id }));
      }
    }
  }
  const keeper = products.find((product) => product.id === group.keeperProductId);
  if (group.action === 'deduplicate' && keeper) {
    for (const id of group.targetProductIds) {
      const target = products.find((product) => product.id === id);
      if (target && target.businessRowHash !== keeper.businessRowHash) {
        blockers.push(blocker('LEGACY_SKU_REPAIR_DUPLICATE_MISMATCH', group, { productId: id }));
      }
      if (target?.external.independentlyRepresented) {
        blockers.push(blocker('LEGACY_SKU_REPAIR_EXTERNAL_EVIDENCE', group, { productId: id }));
      }
    }
  }
  const result = {
    ...group,
    registry: registryRows,
    currentProductIds: currentIds,
    products,
  };
  result.groupHash = await hashJson(client, { registryRows, products });
  return result;
}

async function inspect(client, input) {
  if (typeof input.expectedDatabase !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(input.expectedDatabase)
    || !positiveInteger(input.actorUserId)) {
    fail('LEGACY_SKU_REPAIR_COMMAND_INVALID', 'Expected database and actor are required', null, 422);
  }
  const decisions = normalizeDecisions(input.decisions);
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (database !== input.expectedDatabase) fail('LEGACY_SKU_REPAIR_DATABASE_MISMATCH', 'Target database differs');
  const applied = (await client.query(`SELECT name FROM schema_migrations
    WHERE name=ANY($1::text[]) ORDER BY name`, [[...REQUIRED_MIGRATIONS,
    '046_stable_public_product_sku.sql', '047_finalize_legacy_sku_repair.sql']])).rows.map((row) => row.name);
  const missingMigrations = REQUIRED_MIGRATIONS.filter((name) => !applied.includes(name));
  const lifecycleGate = (await client.query(`SELECT phase,generation,selector_version,required_writer_version
    FROM full_product_export_activation WHERE singleton`)).rows[0] || null;
  const magentoGate = (await client.query(`SELECT enabled,legacy_product_csv_enabled,cutover_at
    FROM magento_auto_sync_activation WHERE singleton`)).rows[0] || null;
  const actor = await actorState(client, input.actorUserId);
  const blockers = [];
  if (missingMigrations.length || applied.includes('046_stable_public_product_sku.sql')
    || applied.includes('047_finalize_legacy_sku_repair.sql')) {
    blockers.push({ code: 'LEGACY_SKU_REPAIR_SCHEMA_CHECKPOINT_INVALID', missingMigrations,
      migration046Applied: applied.includes('046_stable_public_product_sku.sql'),
      migration047Applied: applied.includes('047_finalize_legacy_sku_repair.sql') });
  }
  if (!lifecycleGate || lifecycleGate.phase !== 'active' || Number(lifecycleGate.selector_version) !== 1
    || Number(lifecycleGate.required_writer_version) !== 1) {
    blockers.push({ code: 'LEGACY_SKU_REPAIR_LIFECYCLE_GATE_UNSAFE' });
  }
  if (!magentoGate || magentoGate.enabled || !magentoGate.legacy_product_csv_enabled || magentoGate.cutover_at) {
    blockers.push({ code: 'LEGACY_SKU_REPAIR_MAGENTO_GATE_UNSAFE' });
  }
  if (!actor || actor.status !== 'active' || !actor.authorized) {
    blockers.push({ code: 'LEGACY_SKU_REPAIR_ACTOR_UNAUTHORIZED' });
  }
  const groups = [];
  for (const group of decisions.groups) groups.push(await inspectGroup(client, group, blockers));
  return {
    database,
    format: FORMAT,
    schemaCheckpoint: '045-pre-046',
    actorUserId: input.actorUserId,
    decisions: groups,
    environment: {
      appliedMigrations: applied,
      lifecycleGate,
      magentoGate,
      actor: actor ? { active: actor.status === 'active', authorized: actor.authorized } : null,
    },
    blockers,
  };
}

function planFor(report) {
  const plan = { ...report };
  delete plan.blockers;
  return plan;
}

async function preflight(input, options = {}) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await inspect(client, input);
    const plan = planFor(report);
    const sealed = await sealJson(client, plan);
    await client.query('COMMIT');
    return { artifactVersion: 1, kind: 'amber-legacy-sku-repair-preflight', checkedAt: new Date().toISOString(),
      plan, planHash: sealed.hash, blockers: report.blockers };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function decisionsFromPlan(plan) {
  return { version: 1, groups: plan.decisions.map((group) => ({
    sku: group.sku,
    action: group.action,
    keeperProductId: group.keeperProductId,
    ...(group.action === 'deduplicate'
      ? { retireProductIds: group.targetProductIds }
      : { splitProductIds: group.targetProductIds }),
    reason: group.reason,
  })) };
}

async function completedReceipt(client, planHash) {
  const rows = (await client.query(`SELECT details FROM audit_events
    WHERE event_key=$1 AND subject_type='legacy_sku_repair_plan' AND subject_id=$2 ORDER BY id`,
  [EVENT, planHash])).rows;
  if (rows.length > 1) fail('LEGACY_SKU_REPAIR_RECEIPT_CONFLICT', 'Multiple staging receipts exist');
  if (!rows.length) return null;
  const details = rows[0].details;
  let receipt;
  try { receipt = JSON.parse(details?.canonicalReceipt); } catch { receipt = null; }
  const sealed = receipt ? await sealJson(client, receipt) : null;
  if (details?.version !== 2 || details?.format !== RECEIPT_FORMAT || details?.planHash !== planHash
    || !sealed || sealed.canonical !== details.canonicalReceipt || sealed.hash !== details.receiptHash
    || receipt?.planHash !== planHash || !Array.isArray(receipt.targets)) {
    fail('LEGACY_SKU_REPAIR_RECEIPT_INVALID', 'Staging receipt is malformed');
  }
  return receipt;
}

async function stage(input, options = {}) {
  if (!input.plan || input.plan.format !== FORMAT || !/^[a-f0-9]{64}$/.test(input.planHash || '')
    || input.plan.database !== input.expectedDatabase
    || input.plan.actorUserId !== input.actorUserId) {
    fail('LEGACY_SKU_REPAIR_PLAN_INVALID', 'Exact preflight plan and hash are required', null, 422);
  }
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({
    databasePool: options.databasePool || pool,
    actorUserId: context.actorUserId,
    requiredPermission: 'exports.reconcile',
    createError: (statusCode, code, message, details) => Object.assign(new Error(message), { statusCode, code, details }),
    operation: async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_legacy_sku_repair:${input.planHash}`]);
      const previous = await completedReceipt(client, input.planHash);
      if (previous) return { alreadyApplied: true, planHash: input.planHash,
        stagedProductIds: previous.targets.map((target) => target.productId) };
      const allIds = input.plan.decisions.flatMap((group) => [group.keeperProductId, ...group.targetProductIds])
        .sort((a, b) => a - b);
      const locked = (await client.query('SELECT id FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [allIds])).rows;
      if (locked.length !== allIds.length) fail('LEGACY_SKU_REPAIR_PREFLIGHT_STALE', 'A planned product disappeared');
      const skus = input.plan.decisions.map((group) => group.sku).sort();
      await client.query('SELECT full_sku FROM sku_registry WHERE full_sku=ANY($1::text[]) ORDER BY full_sku FOR UPDATE', [skus]);
      await client.query(`SELECT product_id FROM product_full_export_state
        WHERE product_id=ANY($1::int[]) ORDER BY product_id FOR UPDATE`, [allIds]);
      const report = await inspect(client, { expectedDatabase: input.expectedDatabase,
        actorUserId: input.actorUserId, decisions: decisionsFromPlan(input.plan) });
      const freshPlan = planFor(report);
      const freshPlanSeal = await sealJson(client, freshPlan);
      if (report.blockers.length || freshPlanSeal.hash !== input.planHash) {
        fail('LEGACY_SKU_REPAIR_PREFLIGHT_STALE', 'Database state no longer matches the reviewed plan',
          { blockers: report.blockers });
      }
      const targets = [];
      for (const group of input.plan.decisions) {
        for (const productId of group.targetProductIds) {
          const original = group.products.find((product) => product.id === productId);
          const changed = await client.query(`UPDATE products SET status='archived',exclude_from_export=1,
            archived_by_user_id=$2 WHERE id=$1 AND status='active' AND corrected_to_product_id IS NULL RETURNING id`,
          [productId, context.actorUserId]);
          if (changed.rows.length !== 1) fail('LEGACY_SKU_REPAIR_PREFLIGHT_STALE', 'Product state changed during staging');
          await retireFullProduct(client, productId);
          const stagedProduct = (await client.query('SELECT to_jsonb(p) AS row FROM products p WHERE id=$1', [productId])).rows[0].row;
          const stagedLifecycle = (await client.query(`SELECT to_jsonb(f) AS row
            FROM product_full_export_state f WHERE product_id=$1`, [productId])).rows[0].row;
          const target = {
            action: group.action,
            sku: group.sku,
            keeperProductId: group.keeperProductId,
            productId,
            reason: group.reason,
            originalProduct: original.row,
            originalProductHash: original.rowHash,
            stagedProduct,
            stagedProductHash: await hashJson(client, stagedProduct),
            originalLifecycle: original.lifecycle,
            originalLifecycleHash: original.lifecycleHash,
            stagedLifecycle,
            stagedLifecycleHash: await hashJson(client, stagedLifecycle),
          };
          targets.push(target);
          await writeAuditEvent(client, { mutationContext: context,
            eventKey: group.action === 'deduplicate'
              ? 'product.legacy_duplicate_retired' : 'product.legacy_public_identity_staged',
            subjectType: 'product', subjectId: productId,
            details: { planHash: input.planHash, sku: group.sku, keeperProductId: group.keeperProductId,
              action: group.action, reason: group.reason, stagedProductHash: target.stagedProductHash,
              stagedLifecycleHash: target.stagedLifecycleHash } });
        }
      }
      const receiptPayload = {
        format: RECEIPT_FORMAT,
        planHash: input.planHash,
        database: input.expectedDatabase,
        actorUserId: context.actorUserId,
        plan: freshPlan,
        targets,
        magentoCreateProductIds: targets.filter((target) => target.action === 'split_public_identity')
          .map((target) => target.productId).sort((a, b) => a - b),
      };
      const sealedReceipt = await sealJson(client, receiptPayload);
      const details = { version: 2, format: RECEIPT_FORMAT, planHash: input.planHash,
        receiptHash: sealedReceipt.hash, canonicalReceipt: sealedReceipt.canonical };
      if (Buffer.byteLength(sealedReceipt.canonical) > 1024 * 1024) {
        fail('LEGACY_SKU_REPAIR_EVIDENCE_TOO_LARGE', 'Staging audit evidence exceeds the safety limit', null, 422);
      }
      const receipt = await writeAuditEvent(client, { mutationContext: context, eventKey: EVENT,
        subjectType: 'legacy_sku_repair_plan', subjectId: input.planHash, details });
      return { alreadyApplied: false, planHash: input.planHash, stagingAuditEventId: Number(receipt.id),
        stagedProductIds: targets.map((target) => target.productId),
        magentoCreateProductIds: receiptPayload.magentoCreateProductIds };
    },
  });
}

module.exports = { FORMAT, EVENT, RECEIPT_FORMAT, REQUIRED_MIGRATIONS, normalizeDecisions, inspect, planFor,
  preflight, stage, completedReceipt };
