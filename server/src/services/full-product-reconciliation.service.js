const gate = require('./full-product-cutover-gate');
const { repairTransaction, lockRepairProducts, receipt, error, conflict } = require('./recount-repair.service');
const { readRepairInput } = require('./export-exposure/repair-loader');
const { buildRepairManifest, digest } = require('./export-exposure/repair-manifest');
const { stableJson } = require('./export-exposure/evidence');
const { writeAuditEvent } = require('../audit/audit-events');

const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
function requireDispositions(actual, expected, identity, allowed) {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || new Set(actual.map((x) => x?.[identity])).size !== actual.length
    || actual.some((x) => !expected.includes(x?.[identity]) || !allowed.includes(x.disposition) || !text(x.evidence))) {
    throw error(422,'RECONCILIATION_UNRESOLVED','Every old SKU and retained file requires explicit disposition and evidence; unknown remains held');
  }
}

// Backend domain command only. Local snapshot confirmation is evidence of an
// application export, never a Magento import receipt. Human external evidence
// cannot revoke a downloaded file; the command records that responsibility.
async function reconcileFullProduct(input, options) {
  if (!Number.isSafeInteger(input?.successorId) || input.successorId <= 0
    || !text(input.reason) || !text(input.resolutionKey) || input.resolutionKey.length > 200
    || !/^[1-9]\d*$/.test(String(input.deliveryVersion)) || !/^[a-f0-9]{64}$/.test(input.beforeFingerprint)) {
    throw error(422,'RECONCILIATION_INVALID','Successor, version, exact evidence, reason and resolution key required');
  }
  const action = input.action || 'replacement';
  if (!['replacement','unexposed_first_delivery','generated_first_delivery'].includes(action)) throw error(422,'RECONCILIATION_INVALID','Unknown resolution action');
  const commandHash = digest(input); const key = digest({ resolutionKey:input.resolutionKey });
  return repairTransaction(options,async (client,context) => {
    await gate.requireActive(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_reconciliation:${key}`]);
    const previous = await receipt(client,key,'full_product.reconciled');
    if (previous) {
      if (previous.commandHash !== commandHash) throw error(409,'RECONCILIATION_KEY_CONFLICT','Resolution key already identifies another reviewed command');
      return { ...previous.result,alreadyResolved:true };
    }
    // Read to discover lock IDs, then rebuild after waits and compare the exact
    // reviewed component. A new descendant invalidates the reviewed terminal.
    const discovered = buildRepairManifest(await readRepairInput(client));
    const known = discovered.repairEntries.find((e) => e.productId === input.successorId);
    if (!known) throw conflict('Successor missing');
    await lockRepairProducts(client,known.lineageProductIds);
    const manifest = buildRepairManifest(await readRepairInput(client));
    const entry = manifest.repairEntries.find((e) => e.productId === input.successorId);
    if (!entry || entry.beforeFingerprint !== input.beforeFingerprint
      || String(entry.lifecycle.delivery_version) !== String(input.deliveryVersion)) throw conflict('Reconciliation evidence changed');
    if (entry.status !== 'active' || entry.lifecycle.route !== 'hold' || (action !== 'generated_first_delivery' && !entry.correctionId)
      || stableJson(entry.terminalDescendants) !== stableJson([entry.productId]) || entry.exposure.issues.length) {
      throw error(409,'RECONCILIATION_UNRESOLVED','Only a valid held terminal successor with intact evidence can be released');
    }
    const firstDeliveryExclusionDecision = entry.lifecycle.business_exclusion_state === 'excluded' ? 'release' : 'recount_only_attested';
    if (action === 'unexposed_first_delivery' && (entry.exposure.classification !== 'reliably_unexposed'
      || input.exclusionResolution?.disposition !== firstDeliveryExclusionDecision || !text(input.exclusionResolution.evidence))) {
      throw error(422,'RECONCILIATION_UNRESOLVED','Retained unexposed evidence and explicit recount-only exclusion attestation required');
    }
    if (action === 'generated_first_delivery' && (entry.correctionId || entry.ancestorChain.length
      || !['generated_exact','confirmed_exact'].includes(entry.exposure.classification)
      || input.redeliveryAuthorization?.disposition !== 'authorized' || !text(input.redeliveryAuthorization.evidence))) {
      throw error(422,'RECONCILIATION_UNRESOLVED','Ordinary retained-file reconciliation and explicit full delivery authorization required');
    }
    const ancestorSkus = entry.ancestorChain.map((a) => a.sku).sort();
    if (!Array.isArray(input.ancestorSkus) || stableJson([...input.ancestorSkus].sort()) !== stableJson(ancestorSkus)) {
      throw conflict('Complete ancestor SKU set required');
    }
    const exact = [...entry.generatedMemberships,...entry.confirmedMemberships];
    const riskSkus = [...new Set([...ancestorSkus,...exact.map((m) => m.sku)])].sort();
    const files = [...new Set(exact.map((m) => m.snapshotId))].sort();
    requireDispositions(input.oldSkus,riskSkus,'sku',['verified_absent','retired_reconciled']);
    requireDispositions(input.files,files,'snapshotId',['quarantined_do_not_import','consumed_and_reconciled']);
    if (entry.exposure.classification === 'historical_ambiguous'
      && (input.externalHistory?.disposition !== 'resolved' || !text(input.externalHistory.evidence))) {
      throw error(422,'RECONCILIATION_UNRESOLVED','Ambiguous external history requires explicit resolution evidence');
    }
    if (['unknown','independent_exclusion'].includes(entry.independentExclusion.provenance)
      && (!['release', ...(action === 'unexposed_first_delivery' ? ['recount_only_attested'] : [])].includes(input.exclusionResolution?.disposition) || !text(input.exclusionResolution.evidence))) {
      throw error(422,'RECONCILIATION_UNRESOLVED','Independent or unknown exclusion requires explicit business release evidence');
    }
    const restoredNames = action === 'unexposed_first_delivery' ? entry.conditionalFirstDelivery?.names : null;
    await client.query(`UPDATE products SET exclude_from_export=0,
      magento_name_subject_ua=CASE WHEN $2 THEN $3 ELSE magento_name_subject_ua END,
      magento_name_subject_en=CASE WHEN $2 THEN $4 ELSE magento_name_subject_en END,
      magento_name_review_required=CASE WHEN $2 THEN $5 ELSE magento_name_review_required END WHERE id=$1`,
    [entry.productId,Boolean(restoredNames),restoredNames?.ua,restoredNames?.en,restoredNames?.reviewRequired]);
    const route = action === 'replacement' ? 'replacement' : 'normal';
    const evidence = { origin:'reconciliation',action,historicalCoverage:action === 'unexposed_first_delivery' ? 'retained_evidence_unexposed' : 'historical_exposure',commandHash,resolutionKey:input.resolutionKey,
      beforeFingerprint:entry.beforeFingerprint,classification:entry.exposure.classification,
      ancestorSkus,snapshotIds:files,confirmationIsNotImportReceipt:true };
    const changed = await client.query(`UPDATE product_full_export_state SET route=$6,hold_reason=NULL,business_exclusion_state='none',recount_compatibility_excluded=FALSE,
      delivery_version=delivery_version+1,evidence=$2::jsonb,last_resolution_key=$3,
      resolved_by_user_id=$4,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE product_id=$1 AND route='hold' AND delivery_version=$5::bigint RETURNING delivery_version`,
    [entry.productId,JSON.stringify(evidence),input.resolutionKey,context.actorUserId,String(input.deliveryVersion),route]);
    if (changed.rows.length !== 1) throw conflict('Reconciliation lifecycle CAS failed');
    const result = { successorId:entry.productId,route,deliveryVersion:changed.rows[0].delivery_version };
    await writeAuditEvent(client,{mutationContext:context,eventKey:'full_product.reconciled',subjectType:'full_product_resolution',subjectId:key,
      details:{commandHash,action,redeliveryAuthorization:input.redeliveryAuthorization ?? null,beforeFingerprint:entry.beforeFingerprint,reason:input.reason,ancestorSkus,
        oldSkus:input.oldSkus,files:input.files,externalHistory:input.externalHistory ?? null,
        exclusionResolution:input.exclusionResolution ?? null,resolutionKey:input.resolutionKey,result,
        confirmationIsNotImportReceipt:true} });
    return { ...result,alreadyResolved:false };
  });
}
async function setBusinessExclusion(input, options) {
  if (!Number.isSafeInteger(input?.productId) || input.productId <= 0 || typeof input.excluded !== 'boolean'
    || !text(input.reason) || !text(input.resolutionKey) || !/^[1-9]\d*$/.test(String(input.deliveryVersion))) {
    throw error(422,'EXCLUSION_RESOLUTION_INVALID','Product, delivery version, boolean policy, reason and resolution key required');
  }
  const commandHash = digest(input); const key = digest({ resolutionKey: input.resolutionKey });
  return repairTransaction(options, async (client, context) => {
    await gate.requireActive(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_business_exclusion:${key}`]);
    const previous = await receipt(client,key,'product.business_exclusion_resolved');
    if (previous) {
      if (previous.commandHash !== commandHash) throw conflict('Resolution key already used');
      return { ...previous.result,alreadyApplied:true };
    }
    await lockRepairProducts(client,[input.productId]);
    const state = (await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[input.productId])).rows[0];
    if (state.delivery_version !== String(input.deliveryVersion) || state.route === 'retired') throw conflict('Exclusion policy changed or product retired');
    // Resolving this policy never clears a lifecycle hold or compatibility bit.
    const result = (await client.query(`UPDATE product_full_export_state SET business_exclusion_state=$2,
      delivery_version=delivery_version+1,updated_at=CURRENT_TIMESTAMP WHERE product_id=$1 RETURNING delivery_version`,
    [input.productId,input.excluded ? 'excluded' : 'none'])).rows[0];
    await client.query('UPDATE products SET exclude_from_export=$2 WHERE id=$1',
      [input.productId,input.excluded || state.recount_compatibility_excluded ? 1 : 0]);
    await writeAuditEvent(client,{mutationContext:context,eventKey:'product.business_exclusion_resolved',subjectType:'exclusion_resolution',
      subjectId:key,details:{commandHash,input,result}});
    return { ...result,alreadyApplied:false };
  });
}
module.exports = { reconcileFullProduct, setBusinessExclusion };
