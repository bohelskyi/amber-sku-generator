const { hashPayload: hash } = require('./pricing/pricing-context-fingerprint');

const FORMAT = 'amber-correction-batch-plan-v1';
const SELECTION_FORMAT = 'amber-correction-batch-selection-v1';
const MAX_REQUESTS = 1000;
const error = (statusCode, code, message = code) => Object.assign(new Error(message), { statusCode, code, publicCode: code });
const conflict = (code = 'CORRECTION_BATCH_DRIFT') => { throw error(409, code); };
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b);
const eligible = e => ['SAFE_TO_COMPLETE', 'REFRESH_SAME_INTENT'].includes(e.classification);

function ids(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_REQUESTS
    || values.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(values).size !== values.length) {
    throw error(422, 'CORRECTION_BATCH_SCOPE_INVALID');
  }
  return [...values].sort((a, b) => a - b);
}

// Only volatile observation age/time and presentation explanations are omitted.
// Rate value/date/source/stale, all result values and dependency tokens stay bound.
function stableResult(value) {
  if (Array.isArray(value)) return value.map(stableResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    'fetchedAt', 'uahRateFetchedAt', 'uahRateAgeMs', 'ageMs', 'logMessage',
  ].includes(key)).map(([key, v]) => [key, stableResult(v)]));
}

function rateEvidence(observation) {
  const r = observation?.rateInfo;
  return r ? { rate: r.rate, rateDate: r.rateDate, source: r.source, stale: r.stale }
    : { unavailable: true };
}

function resultProjection(preview, requestType) {
  if (requestType === 'price_change') return stableResult({
    productId: preview.productId, sku: preview.sku, publicSku: preview.publicSku,
    decision: preview.pricingDecision, currentPriceUah: preview.currentPriceUah,
    currentPricing: preview.currentPricing, resultingPriceUah: preview.resultingPriceUah,
    resultingPricing: preview.resultingPricing, previewToken: preview.previewToken,
    productStateSignature: preview.productStateSignature,
    pricingContextFingerprint: preview.pricingContextFingerprint, uahRateDate: preview.uahRateDate,
  });
  const c = preview.corrected;
  return stableResult({ source: preview.source, corrected: c });
}

function assertReviewedResult(entry, preview, observation) {
  if (!same(resultProjection(preview, entry.requestType), entry.refreshedResult)
    || !same(rateEvidence(observation), entry.rateEvidence)) conflict();
}

function assertReviewedClassification(entry, row, preview, actorUserId) {
  const current = classify(row, entry.sourceEvidence, preview, actorUserId);
  if (!eligible(current) || current.classification !== entry.classification) {
    conflict('CORRECTION_BATCH_CLASSIFICATION_DRIFT');
  }
}

const RECOUNT_PRICE_KEYS = ['pricePerGram', 'pricePerGramUah', 'fixedPriceUah', 'priceMode', 'usesWeight',
  'totalPrice', 'totalPriceUah', 'calculatedPriceUah', 'autoPriceUah', 'uahRate', 'manualPriceUah'];
function recountMaterial(payload) {
  const fields = ['categoryCode', 'skuSchemaVersionId', 'weight', 'fullSku', 'publicSku',
    'exactNames', 'nameInheritance', 'delivery', ...RECOUNT_PRICE_KEYS];
  const missing = fields.filter(key => !Object.hasOwn(payload, key));
  return { missing, value: { ...Object.fromEntries(fields.map(k => [k, payload[k] ?? null])),
    answers: payload.answers, pricingBasis: payload.pricingDetails ?? null } };
}

function hiddenCleanup(old, stored, fresh) {
  // Removal is permissible only for inherited (unchanged) answers. The fresh
  // payload has already passed the ordinary omitHiddenRecountAnswers validator.
  const before = { ...stored }, removed = [];
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(fresh, key)) {
      if (!Object.hasOwn(old || {}, key) || !same(old[key], before[key])) return { answers: stored, removed: [] };
      delete before[key]; removed.push(key);
    }
  }
  return { answers: before, removed };
}

function classify(row, source, preview, actorUserId) {
  const reasons = [];
  if (!source || source.product.status !== 'active' || source.product.corrected_to_product_id != null) {
    return { classification: 'STALE_OR_OBSOLETE', reasons: ['SOURCE_NOT_CURRENT'] };
  }
  if (!['pending', 'in_progress'].includes(row.status)) return { classification: 'STALE_OR_OBSOLETE', reasons: ['REQUEST_TERMINAL'] };
  if (row.claimed_by_user_id != null && Number(row.claimed_by_user_id) !== actorUserId) {
    return { classification: 'OWNERSHIP_BLOCKED', reasons: ['CLAIMED_BY_OTHER'] };
  }
  if (row.claimed_by_user_id == null && row.claim_token_hash != null) {
    return { classification: 'OWNERSHIP_BLOCKED', reasons: ['LEGACY_TOKEN_ONLY'] };
  }
  if (row.status === 'pending' && row.claimed_by_user_id != null) {
    return { classification: 'INVALID_OR_BLOCKED', reasons: ['INVALID_OWNERSHIP_SHAPE'] };
  }
  if (!preview) return null;
  const stored = row.proposed_payload || {};
  if ((row.request_type || 'recount') === 'price_change') {
    if (preview.unchanged) return { classification: 'STALE_OR_OBSOLETE', reasons: ['PRODUCT_PRICE_UNCHANGED'] };
    if (!stored.pricing || !Object.hasOwn(stored, 'totalPriceUah')) reasons.push('MISSING_REVIEW_EVIDENCE');
    else if (!same(stableResult(stored.pricing), stableResult(preview.resultingPricing))
      || stored.totalPriceUah !== preview.resultingPriceUah
      || !same(stored.pricingDecision, preview.pricingDecision)) reasons.push('PRICING_RESULT_CHANGED');
    if (row.old_payload?.stateSignature !== preview.productStateSignature) reasons.push('SOURCE_STATE_CHANGED');
  } else {
    const a = recountMaterial(stored), b = recountMaterial(preview.corrected);
    if (a.missing.length || b.missing.length || !stored.answers || !row.old_payload?.answers) reasons.push('MISSING_REVIEW_EVIDENCE');
    else {
      const cleanup = hiddenCleanup(row.old_payload.answers, stored.answers, preview.corrected.answers);
      a.value.answers = cleanup.answers;
      if (!same(stableResult(a.value), stableResult(b.value))) reasons.push('TARGET_OR_RESULT_CHANGED');
      // Fresh dependency format alone can change, but source business values cannot.
      const oldSource = row.old_payload, current = preview.source;
      for (const key of ['productId', 'sku', 'answers', 'weight', 'totalPrice', 'totalPriceUah', 'pricePerGram']) {
        if (!Object.hasOwn(oldSource, key)) reasons.push('MISSING_REVIEW_EVIDENCE');
        else if (!same(oldSource[key], current[key])) reasons.push('SOURCE_STATE_CHANGED');
      }
      if (!row.pricing_mode && !Object.hasOwn(stored, 'manualPriceUah')) reasons.push('LEGACY_PRICING_AMBIGUOUS');
    }
    const prior = stored.recountEvidence;
    if (row.pricing_mode && !same(stored.pricingDecision, preview.corrected.pricingDecision)) reasons.push('PRICING_DECISION_CHANGED');
    if (!prior?.names || !prior?.exposure || !prior?.target || !prior?.lifecycle || !prior?.lineage) reasons.push('MISSING_REVIEW_EVIDENCE');
    if (prior && preview.corrected.recountEvidence) {
      for (const key of ['names', 'sharedNames', 'route', 'holdReason', 'publicSkuActivation']) {
        if (!Object.hasOwn(prior, key)) reasons.push('MISSING_REVIEW_EVIDENCE');
        else if (!same(prior[key], preview.corrected.recountEvidence[key])) reasons.push('NAME_OR_DELIVERY_CHANGED');
      }
      if (!same(prior.lineage, preview.corrected.recountEvidence.lineage)) reasons.push('LINEAGE_CHANGED');
    }
  }
  if (reasons.length) return { classification: 'REVIEW_REQUIRED', reasons: [...new Set(reasons)] };
  const signature = preview.previewToken || require('./product/product-signatures').getCorrectionDecisionSignature(
    preview, require('./product/correction-pricing-decision').decisionFromRequest(row));
  const current = (row.request_type === 'price_change' || stored.recountEvidence?.version === 5) && signature === row.preview_signature;
  return { classification: current ? 'SAFE_TO_COMPLETE' : 'REFRESH_SAME_INTENT', reasons: [current ? 'CURRENT_REVIEW_MATCHES' : 'REFRESH_UNCHANGED_INTENT'] };
}

function verifyPlan(plan, expectedHash) {
  const { planHash, ...body } = plan || {};
  if (planHash !== expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash || '') || hash(body) !== expectedHash
    || plan.format !== FORMAT || plan.policyVersion !== 1 || plan.toolContract !== 'correction-batch-v1'
    || !Number.isSafeInteger(plan.actorUserId) || plan.actorUserId <= 0
    || !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > MAX_REQUESTS
    || !same(ids(plan.requestIds), plan.entries.map(e => e.requestId))
    || plan.entries.some(e => e.entryHash !== hash(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'entryHash'))))) {
    throw error(422, 'CORRECTION_BATCH_PLAN_INVALID');
  }
  return plan;
}

function select(plan, expectedHash, selectedIds, heldIds = []) {
  verifyPlan(plan, expectedHash);
  const selected = ids(selectedIds), held = heldIds.length ? ids(heldIds) : [];
  if (held.some(id => !selected.includes(id)) || selected.some(id => {
    const entry = plan.entries.find(e => e.requestId === id);
    return !entry || !eligible(entry) || (entry.postDeliveryReviewRequired && !held.includes(id))
      || (!entry.postDeliveryReviewRequired && held.includes(id));
  })) throw error(422, 'CORRECTION_BATCH_SELECTION_INVALID');
  const body = { format: SELECTION_FORMAT, planHash: plan.planHash, actorUserId: plan.actorUserId,
    requestIds: selected, postDeliveryReviewIds: held };
  return { ...body, selectionHash: hash(body) };
}

function verifySelection(plan, selection, expectedHash) {
  const fresh = select(plan, plan.planHash, selection?.requestIds, selection?.postDeliveryReviewIds);
  if (!same(fresh, selection) || fresh.selectionHash !== expectedHash) throw error(422, 'CORRECTION_BATCH_SELECTION_INVALID');
}

module.exports = { FORMAT, MAX_REQUESTS, hash, error, conflict, same, ids, eligible, stableResult,
  rateEvidence, resultProjection, assertReviewedResult, assertReviewedClassification, classify, verifyPlan, select, verifySelection };
