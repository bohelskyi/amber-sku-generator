const lifecycleGate = require('./full-product-cutover-gate');
const { APPLICATION_USER_ADMIN_LOCK_KEY, assertActorStillAuthorized } = require('./access-admin-transaction');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { readFullProductStates } = require('./full-product-export.service');
const { readRepairInput, loadRepairInput } = require('./export-exposure/repair-loader');
const { buildRepairManifest, verifyManifest, digest } = require('./export-exposure/repair-manifest');
const { stableJson } = require('./export-exposure/evidence');

const error = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const conflict = (message) => error(409,'REPAIR_MANIFEST_STALE',message);
const orderedIds = (ids) => [...new Set(ids)].sort((a,b) => a-b);

// No HTTP route, startup hook or default pool: every caller must supply its
// database and actor explicitly. The CLI deliberately exposes only dry run.
async function repairTransaction(options, operation) {
  const context = createMutationContext(options.mutationContext);
  const client = await options.databasePool.connect(); let boundary = false;
  try {
    // Shared pre-transaction authority lock follows capture's established order
    // and allows real product/state contention with other domain operations.
    await client.query('SELECT pg_advisory_lock_shared(hashtext($1))',[APPLICATION_USER_ADMIN_LOCK_KEY]); boundary = true;
    await lifecycleGate.begin(client, 'BEGIN', { maintenance: options.maintenance === true, exclusive: options.exclusive === true });
    await assertActorStillAuthorized(client,context.actorUserId,'exports.reconcile',error);
    const database = (await client.query('SELECT current_database() name')).rows[0].name;
    if (!options.expectedDatabase || options.expectedDatabase !== database) throw error(422,'REPAIR_DATABASE_MISMATCH','Exact expected database required');
    const result = await operation(client,context);
    await lifecycleGate.commit(client); return result;
  } catch (cause) { await lifecycleGate.rollback(client); throw cause; }
  finally {
    if (boundary) await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))',[APPLICATION_USER_ADMIN_LOCK_KEY]);
    await lifecycleGate.release(client); client.release();
  }
}
async function lockRepairProducts(client, ids) {
  const sorted = orderedIds(ids);
  const result = await client.query('SELECT id FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[sorted]);
  if (result.rows.length !== sorted.length) throw conflict('Affected product disappeared');
  await readFullProductStates(client,sorted,{lock:true});
}
async function dryRunRepair(databasePool, options) {
  return buildRepairManifest(await loadRepairInput(databasePool,options));
}
async function receipt(client, key, eventKey) {
  const rows = (await client.query(`SELECT details FROM audit_events WHERE event_key=$1 AND subject_id=$2 ORDER BY id`,[eventKey,key])).rows;
  if (rows.length > 1) throw conflict('Conflicting immutable repair receipts');
  return rows[0]?.details;
}

async function applyRepair({ manifest, manifestHash, productIds = [], indexHistorical = false }, options) {
  try { verifyManifest(manifest,manifestHash); } catch (cause) { throw error(422,'REPAIR_MANIFEST_INVALID',cause.message); }
  if (!manifest.schema.applyEligible) throw conflict('Projected migration baseline is diagnostic only; migrate and generate a fresh manifest');
  if (!Array.isArray(productIds) || productIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(productIds).size !== productIds.length || typeof indexHistorical !== 'boolean'
    || (!productIds.length && !indexHistorical)) throw error(422,'REPAIR_SCOPE_INVALID','Explicit nonempty scope required');
  // Phase-3A v2 remains a diagnostic/single-entry compatibility command.
  // Production batches use the approved, gate-bound cutover service.
  if (productIds.length > 1) throw error(409,'CUTOVER_BATCH_COMMAND_REQUIRED','Use the approved manifest-bound cutover batch command');
  const ids = orderedIds(productIds);
  const approved = ids.map((id) => manifest.repairEntries.find((e) => e.productId === id));
  if (approved.some((e) => !e?.wouldMutate)) throw error(422,'REPAIR_SCOPE_INVALID','Scope contains an absent or non-actionable repair entry');
  const commandHash = digest({ manifestHash,productIds:ids,indexHistorical });
  return repairTransaction(options,async (client,context) => {
    const gate = await lifecycleGate.readGate(client);
    if (gate.phase === 'preparing') throw error(409,'CUTOVER_COMMAND_REQUIRED','Use the manifest-bound cutover commands after preparation');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_repair:${commandHash}`]);
    const previous = await receipt(client,commandHash,'recount_repair.applied');
    if (previous) return { ...previous.result,alreadyApplied:true };
    const lockIds = orderedIds([...approved.flatMap((e) => e.lineageProductIds),
      ...(indexHistorical ? manifest.indexing.proposed.map((m) => m.product_id) : [])]);
    await lockRepairProducts(client,lockIds);
    const current = buildRepairManifest(await readRepairInput(client));
    if (current.database !== manifest.database || stableJson(current.schema) !== stableJson(manifest.schema)) throw conflict('Database/schema changed');
    for (const entry of approved) {
      const fresh = current.repairEntries.find((e) => e.productId === entry.productId);
      if (stableJson(fresh) !== stableJson(entry)) throw conflict(`Product ${entry.productId} evidence changed`);
    }
    if (indexHistorical && (current.indexing.diagnostics.length || stableJson(current.indexing) !== stableJson(manifest.indexing))) {
      throw conflict('Historical snapshot evidence changed or failed validation');
    }
    if (approved.some((e) => Number(e.expectedAfter.exclude_from_export) === 0)) await lifecycleGate.requireActive(client);
    const members = indexHistorical ? current.indexing.proposed : [];
    for (const m of members) await client.query(`INSERT INTO export_snapshot_products
      (snapshot_id,product_id,sku_at_capture,full_revision,delivery_version,capture_kind,evidence_origin,evidence_hash)
      VALUES ($1,$2,$3,NULL,NULL,'legacy_compatibility','verified_stored_csv',$4)`,
    [m.snapshot_id,m.product_id,m.sku_at_capture,m.evidence_hash]);
    for (const entry of approved) {
      const after = entry.expectedAfter;
      await client.query(`UPDATE products SET exclude_from_export=$2,magento_name_subject_ua=$3,
        magento_name_subject_en=$4,magento_name_review_required=$5 WHERE id=$1`,
      [entry.productId,after.exclude_from_export,after.names.ua,after.names.en,after.names.reviewRequired]);
      const evidence = { origin:'phase3_repair',classification:entry.exposure.classification,
        reasonCodes:entry.reasonCodes,beforeFingerprint:entry.beforeFingerprint,manifestHash,
        independentExclusion:entry.independentExclusion.provenance === 'unknown' ? null : entry.independentExclusion.provenance === 'independent_exclusion',
        exclusionProvenance:entry.independentExclusion.provenance };
      const updated = await client.query(`UPDATE product_full_export_state SET route=$2,hold_reason=$3,
        delivery_version=delivery_version+1,evidence=$4::jsonb,repair_manifest_hash=$5,updated_at=CURRENT_TIMESTAMP
        WHERE product_id=$1 AND revision=$6::bigint AND confirmed_revision=$7::bigint AND delivery_version=$8::bigint RETURNING product_id`,
      [entry.productId,after.route,after.hold_reason,JSON.stringify(evidence),manifestHash,
        entry.lifecycle.revision,entry.lifecycle.confirmed_revision,entry.lifecycle.delivery_version]);
      if (updated.rows.length !== 1) throw conflict('Lifecycle CAS failed');
      await writeAuditEvent(client,{mutationContext:context,eventKey:'product.full_export_repaired',subjectType:'product',subjectId:entry.productId,
        details:{ repair_manifest_hash:manifestHash,beforeFingerprint:entry.beforeFingerprint,
          before:{route:entry.lifecycle.route,holdReason:entry.lifecycle.hold_reason,deliveryVersion:entry.lifecycle.delivery_version},
          after,reasonCodes:entry.reasonCodes } });
    }
    const result = { manifestHash,productIds:ids,indexedMemberships:members.length };
    await writeAuditEvent(client,{mutationContext:context,eventKey:'recount_repair.applied',subjectType:'repair_manifest',subjectId:commandHash,
      details:{ repair_manifest_hash:manifestHash,commandHash,result,
        indexedSnapshotIds:[...new Set(members.map((m) => m.snapshot_id))].sort() } });
    return { ...result,alreadyApplied:false };
  });
}
module.exports = { dryRunRepair, applyRepair, repairTransaction, lockRepairProducts, receipt, error, conflict };
