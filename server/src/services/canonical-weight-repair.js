const crypto = require('node:crypto');
const manifest = require('./canonical-weight-manifest');
const { repairTransaction, lockRepairProducts } = require('./recount-repair.service');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { originHash, installation, identity, hash } = require('./magento/binding-contract');
const { readPreviewProductOnClient } = require('./magento/sync-preview-db');
const { loadSupportInputs } = require('./export-templates/support-inputs');
const { evaluate } = require('./magento/binding-evidence-products');
const gate = require('./full-product-cutover-gate');
const fail = code => { throw manifest.error(`SV_CANONICAL_WEIGHT_${code}`); };
function required(options) {
  if (!options.databasePool || !options.expectedDatabase || !options.config?.configured) fail('CONTEXT_REQUIRED');
  installation(options.installationKey); identity(options.bindingRevisionId);
  return createMutationContext(options.mutationContext);
}
async function context(client, options) {
  const schema = (await client.query(`SELECT current_database() name,
    to_regprocedure('sv_weight_repair_state(integer)') IS NOT NULL AND to_regclass('product_weight_repair_receipts') IS NOT NULL installed`)).rows[0];
  if (schema.name !== options.expectedDatabase) fail('DATABASE_MISMATCH');
  if (!schema.installed) fail('GUARD_NOT_INSTALLED');
  const text = (await client.query('SELECT sv_weight_repair_configuration($1)::text value', [options.bindingRevisionId])).rows[0].value;
  const value = text ? JSON.parse(text) : null;
  if (!value || value.activation?.installation_key !== options.installationKey || value.binding?.installation_key !== options.installationKey
    || value.binding.state !== 'published' || value.currentBinding !== options.bindingRevisionId
    || value.binding.origin_hash !== originHash(options.config.baseUrl)) fail('CONTEXT_STALE');
  return text;
}
async function state(client, productId, targetWeight) {
  const row = (await client.query(`SELECT evidence::text before,
    jsonb_set(evidence,'{product,weight}',to_jsonb($2::numeric(14,3)))::text after
    FROM (SELECT sv_weight_repair_state($1) evidence) x`, [productId,targetWeight])).rows[0];
  if (!row.before || Buffer.byteLength(row.before) > manifest.MAX_EVIDENCE_BYTES || Buffer.byteLength(row.after) > manifest.MAX_EVIDENCE_BYTES) fail('EVIDENCE_LIMIT');
  return row;
}
async function comparePublished(client, productId, bindingId, evidence, targetWeight) {
  const amber = await readPreviewProductOnClient(client, { productId, bindingRevisionId: bindingId });
  // Keep the PostgreSQL driver's exact NUMERIC strings used by ordinary delivery.
  // Raw JSON evidence is retained for the receipt, never used to reprice/render money.
  const raw = amber.product;
  if (raw.id !== JSON.parse(evidence).product.id) fail('STALE');
  const projected = await loadSupportInputs(client, amber.compiled.definition, [
    { ...raw, public_sku: amber.product.public_sku, is_test_product: amber.product.is_test_product, exportState: amber.product.exportState,
      magento_name_rule_pin: amber.product.magento_name_rule_pin },
    { ...raw, weight: targetWeight, public_sku: amber.product.public_sku, is_test_product: amber.product.is_test_product,
      exportState: amber.product.exportState, magento_name_rule_pin: amber.product.magento_name_rule_pin }
  ]);
  const before = evaluate(amber, projected.products[0]), after = evaluate(amber, projected.products[1]);
  if (before.failed || after.failed || hash(before) !== hash(after)) fail('PUBLISHED_RESULT_CHANGED');
  return hash(before);
}
async function preview(options) {
  const actor = required(options), client = await options.databasePool.connect(), started = Date.now();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15000ms'");
    await assertActorStillAuthorized(client, actor.actorUserId, 'exports.reconcile', (s,c) => manifest.error(c,s), { readOnly: true });
    await assertActorStillAuthorized(client, actor.actorUserId, 'products.recount', (s,c) => manifest.error(c,s), { readOnly: true });
    const configurationText = await context(client,options), entries = [];
    const rollback = options.rollbackReceiptIds !== undefined;
    let rows;
    if (rollback) {
      if (!Array.isArray(options.rollbackReceiptIds) || !options.rollbackReceiptIds.length || options.rollbackReceiptIds.length > manifest.LIMIT
        || options.rollbackReceiptIds.some(id => !manifest.uuid(id)) || new Set(options.rollbackReceiptIds).size !== options.rollbackReceiptIds.length) fail('SCOPE_INVALID');
      rows = (await client.query(`SELECT r.id original_receipt_id,p.id,sv_weight_repair_candidate(p,FALSE) source,
        r.after_state::text original_after,r.before_state::text original_before,
        EXISTS(SELECT 1 FROM product_weight_repair_receipts i WHERE i.inverse_of=r.id) reversed
        FROM product_weight_repair_receipts r JOIN products p ON p.id=r.product_id
        WHERE r.id=ANY($1::uuid[]) AND r.direction='apply' AND r.state='applied' ORDER BY p.id`, [options.rollbackReceiptIds])).rows;
      if (rows.length !== options.rollbackReceiptIds.length) fail('SCOPE_INVALID');
    } else {
      rows = (await client.query(`SELECT p.id,sv_weight_repair_candidate(p) source FROM products p
        WHERE p.category='SV' AND p.status='active' AND p.corrected_to_product_id IS NULL
          AND p.details#>>'{answers,souvenir}'='5' ORDER BY p.id LIMIT 1001`)).rows;
    }
    if (rows.length > manifest.LIMIT) fail('SCOPE_LIMIT');
    for (const row of rows) {
      if (Date.now()-started > 300000) fail('PREVIEW_LIMIT');
      const source = row.source, reasonCodes = [...source.reasonCodes];
      const result = { productId: row.id, eligible: false, reasonCodes };
      if (rollback && row.reversed) reasonCodes.push('ALREADY_ROLLED_BACK');
      if (!reasonCodes.length) {
        const targetWeight = rollback ? '0.000' : source.targetWeight;
        let evidence;
        try { evidence = await state(client,row.id,targetWeight); }
        catch (cause) { if (cause.code !== 'SV_CANONICAL_WEIGHT_EVIDENCE_LIMIT') throw cause; reasonCodes.push('EVIDENCE_LIMIT'); entries.push(result); continue; }
        const parsed = JSON.parse(evidence.before);
        if (rollback && (evidence.before !== row.original_after || evidence.after !== row.original_before)) reasonCodes.push('ROLLBACK_STATE_CHANGED');
        let publishedResultHash;
        if (!reasonCodes.length) {
          try { publishedResultHash = await comparePublished(client,row.id,options.bindingRevisionId,evidence.before,targetWeight); }
          catch (cause) { if (cause.code !== 'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED') throw cause; reasonCodes.push('PUBLISHED_RESULT_CHANGED'); }
        }
        if (!reasonCodes.length) Object.assign(result, { eligible: true, publicSku: parsed.identity.public_sku,
          beforeEvidence: evidence.before, afterEvidence: evidence.after, beforeFingerprint: manifest.digest(evidence.before),
          afterFingerprint: manifest.digest(evidence.after), targetWeight, sourceAnswer: source.sourceAnswer,
          weightQuestionId: source.weightQuestionId, publishedResultHash,
          ...(rollback ? { originalReceiptId: row.original_receipt_id } : {}) });
      }
      entries.push(result);
    }
    const observedAt = (await client.query('SELECT transaction_timestamp() time')).rows[0].time.toISOString();
    await client.query('COMMIT');
    return manifest.seal({ format: manifest.FORMAT, direction: rollback ? 'rollback' : 'apply', database: options.expectedDatabase,
      installationKey: options.installationKey, bindingRevisionId: options.bindingRevisionId, originHash: originHash(options.config.baseUrl),
      observedAt, configurationText, entries,
      provenance: 'Existing question answer; no independent measurement or proof of earlier canonical-weight loss.',
      summary: { scanned: entries.length, eligible: entries.filter(e => e.eligible).length, excluded: entries.filter(e => !e.eligible).length } });
  } catch (cause) { await client.query('ROLLBACK').catch(()=>{}); throw cause; }
  finally { client.release(); }
}
async function one(plan, entry, manifestText, options) {
  const lockClient = await options.databasePool.connect(), locks = [];
  const local = JSON.parse(entry.beforeEvidence);
  try {
    for (const key of [`amber_magento_public_identity:${local.identity.id}`,`amber_magento_sync:${plan.originHash}:${entry.publicSku}`]) {
      if (!(await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) held',[key])).rows[0].held) fail('BUSY');
      locks.push(key);
    }
    return await repairTransaction(options,async (client,actor) => {
      await assertActorStillAuthorized(client,actor.actorUserId,'products.recount',(s,c)=>manifest.error(c,s));
      if ((await gate.readGate(client)).phase === 'preparing') fail('LIFECYCLE_PREPARING');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${plan.installationKey}`]);
      if (await context(client,options) !== plan.configurationText) fail('CONTEXT_STALE');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_canonical_weight_plan:${plan.planHash}`]);
      await lockRepairProducts(client,[entry.productId]);
      await client.query('SELECT id FROM public_product_identities WHERE id=$1 FOR UPDATE',[local.identity.id]);
      await client.query('SELECT public_product_identity_id FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE',[local.identity.id]);
      const previous = (await client.query(`SELECT *,before_state::text before_evidence,after_state::text after_evidence
        FROM product_weight_repair_receipts WHERE plan_hash=$1 AND product_id=$2`,[plan.planHash,entry.productId])).rows[0];
      const evidence = await state(client,entry.productId,entry.targetWeight);
      if (previous) {
        if (previous.state !== 'applied' || previous.before_evidence !== entry.beforeEvidence || previous.after_evidence !== entry.afterEvidence
          || evidence.before !== previous.after_evidence) fail('RECEIPT_STALE');
        return { productId: entry.productId, receiptId: previous.id, status: 'already_applied', direction: plan.direction };
      }
      if (evidence.before !== entry.beforeEvidence || evidence.after !== entry.afterEvidence) fail('STALE');
      if (await comparePublished(client,entry.productId,plan.bindingRevisionId,evidence.before,entry.targetWeight) !== entry.publishedResultHash) fail('STALE');
      const receiptId = crypto.randomUUID();
      await client.query("SELECT set_config('amber.canonical_weight_repair_plan',$1,TRUE),set_config('amber.canonical_weight_repair',$2,TRUE)",[plan.planHash,receiptId]);
      await client.query(`INSERT INTO product_weight_repair_plans(plan_hash,manifest_text,actor_user_id)
        VALUES($1,$2,$3) ON CONFLICT(plan_hash) DO NOTHING`,[plan.planHash,manifestText,actor.actorUserId]);
      await client.query(`INSERT INTO product_weight_repair_receipts(id,plan_hash,product_id,actor_user_id,direction,inverse_of,
        before_state,after_state,source_answer,weight_question_id,target_weight)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::numeric(14,3))`,
      [receiptId,plan.planHash,entry.productId,actor.actorUserId,plan.direction,entry.originalReceiptId || null,
        entry.beforeEvidence,entry.afterEvidence,JSON.stringify(entry.sourceAnswer),entry.weightQuestionId,entry.targetWeight]);
      await client.query('UPDATE products SET weight=$2::numeric(14,3) WHERE id=$1',[entry.productId,entry.targetWeight]);
      const after = (await client.query('SELECT sv_weight_repair_state($1)::text value',[entry.productId])).rows[0].value;
      if (after !== entry.afterEvidence) fail('SIDE_EFFECT');
      const audit = await writeAuditEvent(client,{ mutationContext: actor,
        eventKey: plan.direction === 'apply' ? 'product.canonical_weight_repaired' : 'product.canonical_weight_rolled_back',
        subjectType: 'canonical_weight_repair', subjectId: receiptId,
        details: { planHash: plan.planHash, productId: entry.productId, publicSku: entry.publicSku,
          beforeFingerprint: entry.beforeFingerprint, afterFingerprint: entry.afterFingerprint,
          sourceAnswer: entry.sourceAnswer, weightQuestionId: entry.weightQuestionId, targetWeight: entry.targetWeight,
          publishedResultHash: entry.publishedResultHash, provenance: plan.provenance,
          inverseOf: entry.originalReceiptId || null, storedPricesAndDeliveryPreserved: true } });
      await client.query("UPDATE product_weight_repair_receipts SET state='applied',audit_event_id=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1",[receiptId,audit.id]);
      return { productId: entry.productId, receiptId, status: 'applied', direction: plan.direction };
    });
  } finally {
    for (const key of locks.reverse()) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
    lockClient.release();
  }
}
async function apply(plan, options) {
  required(options);
  if (plan.bindingRevisionId !== options.bindingRevisionId) fail('CONTEXT_STALE');
  const manifestText = manifest.verify(plan,options.expectedHash,options.expectedDatabase,options.installationKey);
  if (plan.originHash !== originHash(options.config.baseUrl)) fail('CONTEXT_STALE');
  const selected = manifest.selection(plan,options.productIds), outcomes = [];
  for (const entry of selected) {
    try { outcomes.push(await one(plan,entry,manifestText,options)); }
    catch (cause) {
      const code = /^SV_CANONICAL_WEIGHT_|^ADMIN_PERMISSION_REVOKED$/.test(cause.code || '') ? cause.code : 'SV_CANONICAL_WEIGHT_ROW_FAILED';
      outcomes.push({ productId: entry.productId, status: cause.statusCode === 409 ? 'conflicted' : 'failed', code });
      if (cause.statusCode === 403 || code === 'SV_CANONICAL_WEIGHT_CONTEXT_STALE') {
        for (const rest of selected.slice(outcomes.length)) outcomes.push({ productId: rest.productId, status: 'not_attempted', code });
        break;
      }
    }
    if (options.checkpoint) await options.checkpoint({ planHash: plan.planHash, direction: plan.direction, outcomes });
  }
  const result = { planHash: plan.planHash, direction: plan.direction, outcomes,
    counts: Object.fromEntries(['applied','already_applied','conflicted','failed','not_attempted'].map(status=>[status,outcomes.filter(row=>row.status===status).length])) };
  if (options.checkpoint) await options.checkpoint(result);
  return result;
}
module.exports = { preview, apply, verify: manifest.verify, comparePublished };
