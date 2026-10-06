const e = require('./correction-request-batch-evidence');
const receipts = require('./correction-request-batch-receipts');
const requests = require('./correction-request.service');
const gate = require('./full-product-cutover-gate');
const access = require('./access-admin-transaction');
const { observeUsdRate } = require('./currency.service');

async function preflight(options) {
  const { databasePool, expectedDatabase, actorUserId } = options;
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0 || !expectedDatabase) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
  if ((await databasePool.query('SELECT current_database() name')).rows[0].name !== expectedDatabase) {
    throw e.error(503, 'CORRECTION_BATCH_DATABASE_MISMATCH');
  }
  // HTTP and fallback cache reads finish before opening the snapshot transaction.
  const rateObservation = await (options.observeRate || observeUsdRate)({ databasePool });
  const client = await databasePool.connect();
  let accessHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]); accessHeld = true;
    await gate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await access.assertActorStillAuthorized(client, actorUserId, 'corrections.view', e.error, { readOnly: true });
    const databaseIdentity = await receipts.databaseIdentity(client, options.connectionTargetHash);
    if (databaseIdentity.name !== expectedDatabase) throw e.error(503, 'CORRECTION_BATCH_DATABASE_MISMATCH');
    let requestIds;
    if (options.allActive) {
      const limit = options.limit;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > e.MAX_REQUESTS || options.requestIds) throw e.error(422, 'CORRECTION_BATCH_SCOPE_INVALID');
      const rows = (await client.query("SELECT id FROM correction_requests WHERE status IN ('pending','in_progress') ORDER BY id LIMIT $1", [limit + 1])).rows;
      if (rows.length > limit) throw e.error(422, 'CORRECTION_BATCH_SCOPE_OVERFLOW');
      requestIds = e.ids(rows.map(r => Number(r.id)));
    } else requestIds = e.ids(options.requestIds);
    const permissions = (await client.query(`SELECT DISTINCT rp.permission_key FROM user_role_assignments a
      JOIN roles r ON r.id=a.role_id AND r.status='active' JOIN role_permissions rp ON rp.role_id=r.id
      WHERE a.application_user_id=$1 AND a.revoked_at IS NULL`, [actorUserId])).rows.map(r => r.permission_key);
    const entries = [];
    for (const requestId of requestIds) {
      const { row, requestHash } = await receipts.readRequest(client, requestId);
      const sourceEvidence = await receipts.readSource(client, Number(row.source_product_id));
      const requiredPermissions = ['corrections.view', 'corrections.complete',
        ...((row.claimed_by_user_id == null && row.claim_token_hash == null) ? ['corrections.claim'] : [])];
      let classification = e.classify(row, sourceEvidence, null, actorUserId), derived;
      const product = sourceEvidence?.product;
      const nativeOwnership = product?.characteristic_version_id != null
        && ['full_sku','base_sku','sequence_number','sku_schema_version_id'].every(key => product[key] == null);
      const legacyOwnership = sourceEvidence?.sku_count === 1
        && sourceEvidence.reservation?.first_product_id === Number(row.source_product_id);
      if (!classification && sourceEvidence && (sourceEvidence.deletion_fence || !sourceEvidence.lifecycle
        || sourceEvidence.current_identity_count !== 1 || !(nativeOwnership || legacyOwnership))) {
        classification = { classification: 'INVALID_OR_BLOCKED', reasons: ['PRODUCT_IDENTITY_OR_DELETION_BLOCKED'] };
      }
      if (!classification) {
        // A savepoint permits a known validation error without retaining an
        // aborted snapshot. Unexpected database errors invalidate the whole plan.
        await client.query('SAVEPOINT correction_batch_preview');
        try {
          derived = await requests.deriveCorrectionRequestRefresh(row, { queryable: client, rateObservation });
          classification = e.classify(row, sourceEvidence, derived.preview, actorUserId);
          await client.query('RELEASE SAVEPOINT correction_batch_preview');
        } catch (cause) {
          await client.query('ROLLBACK TO SAVEPOINT correction_batch_preview');
          if (![404,409,422].includes(cause.statusCode)) throw cause;
          const code = cause.publicCode || cause.code || 'TARGET_VALIDATION_FAILED';
          classification = { classification: code === 'PRODUCT_PRICE_UNCHANGED' ? 'STALE_OR_OBSOLETE' : 'INVALID_OR_BLOCKED', reasons: [code],
            validationMessage: String(cause.message).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500) };
        }
      }
      const missingPermissions = requiredPermissions.filter(p => !permissions.includes(p));
      if (missingPermissions.length && e.eligible(classification)) classification = { classification: 'INVALID_OR_BLOCKED', reasons: ['REQUIRED_PERMISSION_MISSING'] };
      const entry = { requestId, requestType: row.request_type || 'recount', status: row.status,
        sourceProductId: Number(row.source_product_id), publicArticle: sourceEvidence?.product.public_sku || null,
        publicIdentityId: sourceEvidence?.product.public_product_identity_id || null, sourceInternalSku: sourceEvidence?.product.full_sku || null,
        claimVersion: String(row.claim_version), ownerUserId: row.claimed_by_user_id == null ? null : Number(row.claimed_by_user_id),
        requestHash, sourceEvidence, storedIntent: { oldPayload: row.old_payload, proposedPayload: row.proposed_payload,
          pricingMode: row.pricing_mode, pricingUsdPerGram: row.pricing_usd_per_gram, pricingManualUah: row.pricing_manual_uah,
          pricingRoundingEnabled: row.pricing_rounding_enabled, pricingOrigin: row.pricing_origin, comment: row.comment },
        refreshedResult: derived ? e.resultProjection(derived.preview, row.request_type) : null,
        refreshedSignature: derived?.signature || null, rateEvidence: e.rateEvidence(rateObservation),
        requiredPermissions, missingPermissions, ...classification,
        reason: classification.validationMessage || classification.reasons.map(code => code.toLowerCase().replaceAll('_', ' ')).join('; '),
        postDeliveryReviewRequired: Boolean(derived?.preview.corrected?.delivery?.route === 'hold') };
      entries.push({ ...entry, entryHash: e.hash(entry) });
    }
    const summary = Object.fromEntries(['SAFE_TO_COMPLETE','REFRESH_SAME_INTENT','REVIEW_REQUIRED','STALE_OR_OBSOLETE',
      'OWNERSHIP_BLOCKED','INVALID_OR_BLOCKED'].map(c => [c, entries.filter(x => x.classification === c).length]));
    summary.postDeliveryReview = entries.filter(x => e.eligible(x) && x.postDeliveryReviewRequired).length;
    const body = { format: e.FORMAT, policyVersion: e.POLICY_VERSION, actorUserId, databaseIdentity,
      toolContract: e.TOOL_CONTRACT, buildId: options.buildId || 'development',
      generatedAt: new Date().toISOString(), requestIds, selection: options.allActive
        ? { kind: 'all_active', bound: options.limit } : { kind: 'explicit' }, rateObservation, entries, summary };
    await gate.commit(client);
    return { ...body, planHash: e.hash(body) };
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally {
    await gate.release(client);
    if (accessHeld) await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
    client.release();
  }
}

function reviewContext(plan, selection, entry, actorUserId) {
  return { planHash: plan.planHash, selectionHash: selection.selectionHash, actorUserId: plan.actorUserId,
    mutationActorUserId: actorUserId, databaseIdentity: plan.databaseIdentity, entry };
}

async function applyEntry(plan, selection, entry, options) {
  // Sampling is outside every business transaction and before the lane lock.
  const rateObservation = await (options.observeRate || observeUsdRate)({ databasePool: options.databasePool });
  const client = await options.databasePool.connect();
  const lane = `amber_correction_batch_request:${entry.requestId}`;
  let laneHeld = false;
  const borrowed = { query: (...args) => client.query(...args), release() {} };
  const review = reviewContext(plan, selection, entry, options.actorUserId);
  const stepOptions = { databasePool: { connect: async () => borrowed, query: (...args) => client.query(...args) },
    batchReview: review, rateObservation, mutationContext: { actorUserId: options.actorUserId, requestId: `correction-batch:${plan.planHash}` } };
  try {
    laneHeld = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) held', [lane])).rows[0].held;
    if (!laneHeld) throw e.error(409, 'CORRECTION_BATCH_BUSY');
    await receipts.begin(borrowed, stepOptions, 'corrections.complete');
    let steps = await receipts.steps(client, review);
    const completed = steps.find(s => s.details.phase === 'completed');
    if (completed) {
      await gate.commit(borrowed); await receipts.release(borrowed);
      return { status: 'skipped', reason: 'ALREADY_APPLIED', result: completed.details.result };
    }
    const row = await receipts.guard(client, review);
    await gate.commit(borrowed); await receipts.release(borrowed);
    if (options.signal?.aborted) throw e.error(503, 'CORRECTION_BATCH_INTERRUPTED');
    if (!steps.length && row.claimed_by_user_id == null && row.claim_token_hash == null) {
      await requests.claimCorrectionRequest(entry.requestId, stepOptions);
    } else if (!steps.some(s => s.details.phase === 'refreshed')) {
      await requests.refreshCorrectionRequest(entry.requestId, Number(row.claim_version), null, stepOptions);
    }
    if (options.signal?.aborted) throw e.error(503, 'CORRECTION_BATCH_INTERRUPTED');
    const refreshed = await receipts.readRequest(client, entry.requestId);
    let warnings = [];
    try {
      const result = await requests.completeCorrectionRequest(entry.requestId, Number(refreshed.row.claim_version), null, stepOptions);
      warnings = result.draftSyncFailures || [];
    } catch (cause) {
      // A reply/follow-up failure after COMMIT is recovered from the atomic
      // completion receipt. Never label it a failed product mutation.
      steps = await receipts.steps(client, review);
      if (!steps.some(s => s.details.phase === 'completed')) throw cause;
      warnings.push({ code: 'POST_COMMIT_FOLLOWUP_FAILED' });
    }
    steps = await receipts.steps(client, review);
    const receipt = steps.find(s => s.details.phase === 'completed');
    if (!receipt) throw e.error(503, 'CORRECTION_BATCH_RECEIPT_MISSING');
    return { status: 'completed', reason: 'COMMITTED', result: receipt.details.result, warnings };
  } catch (cause) {
    await gate.rollback(borrowed);
    throw cause;
  } finally {
    try {
      await receipts.release(borrowed);
      if (laneHeld) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lane]);
    } finally { client.release(); }
  }
}

function summary(plan, selection, outcomes, stoppedReason = null, finished = false) {
  const ids = Object.fromEntries(['completed','skipped','conflicted','failed','pending'].map(status => [status,
    status === 'pending' ? selection.requestIds.filter(id => !outcomes.some(o => o.requestId === id))
      : outcomes.filter(o => o.status === status).map(o => o.requestId)]));
  return { format: 'amber-correction-batch-receipt-v1', planHash: plan.planHash, selectionHash: selection.selectionHash,
    databaseIdentity: plan.databaseIdentity, actorUserId: plan.actorUserId, updatedAt: new Date().toISOString(),
    finished, stoppedReason, counts: Object.fromEntries(Object.entries(ids).map(([k,v]) => [k,v.length])), ids,
    postDeliveryReviewCandidates: outcomes.filter(o => o.result?.postDeliveryReviewRequired).map(o => ({
      requestId: o.requestId, productId: o.result.productId, publicSku: o.result.publicSku,
      holdReason: o.result.lifecycle.hold_reason, stableRecountReviewCandidate: o.result.lifecycle.hold_reason === 'historical_ambiguity' })), outcomes };
}

async function apply(plan, selection, options) {
  e.verifyPlan(plan, options.expectedHash); e.verifySelection(plan, selection, options.expectedSelectionHash);
  if (options.actorUserId !== plan.actorUserId) throw e.error(403, 'CORRECTION_BATCH_ACTOR_MISMATCH');
  if (options.buildId && options.buildId !== plan.buildId) throw e.error(503, 'CORRECTION_BATCH_BUILD_MISMATCH');
  if (options.expectedDatabase !== plan.databaseIdentity.name || options.connectionTargetHash !== plan.databaseIdentity.connectionTargetHash) {
    throw e.error(503, 'CORRECTION_BATCH_DATABASE_MISMATCH');
  }
  if (typeof options.checkpoint !== 'function') throw e.error(422, 'CORRECTION_BATCH_RECEIPT_REQUIRED');
  const outcomes = [];
  await options.checkpoint(summary(plan, selection, outcomes));
  for (const requestId of selection.requestIds) {
    if (options.signal?.aborted) {
      const report = summary(plan, selection, outcomes, 'CORRECTION_BATCH_INTERRUPTED'); await options.checkpoint(report); return report;
    }
    const entry = plan.entries.find(x => x.requestId === requestId);
    let outcome, fatal;
    try { outcome = await applyEntry(plan, selection, entry, options); }
    catch (cause) {
      const code = cause.publicCode || cause.code || 'CORRECTION_BATCH_INTERNAL_FAILURE';
      const business = [404,409,422].includes(cause.statusCode) && !['CORRECTION_BATCH_RECEIPT_CONFLICT'].includes(code);
      outcome = { status: business ? 'conflicted' : 'failed', reason: code };
      // Preserve visible ownership/phase where reads remain possible.
      try {
        const current = await receipts.readRequest(options.databasePool, requestId);
        outcome.currentClaim = { status: current.row.status, ownerUserId: current.row.claimed_by_user_id,
          claimVersion: String(current.row.claim_version) };
      } catch { /* Infrastructure failure leaves recovery to the immutable DB receipt. */ }
      if (!business) fatal = code;
    }
    outcomes.push({ requestId, publicArticle: entry.publicArticle, ...outcome });
    const report = summary(plan, selection, outcomes, fatal || null, !fatal && outcomes.length === selection.requestIds.length);
    // Disk failure must escape immediately, never become a row conflict.
    await options.checkpoint(report);
    if (fatal) return report;
  }
  return summary(plan, selection, outcomes, null, true);
}

module.exports = { preflight, select: e.select, apply, applyEntry, summary, reviewContext };
