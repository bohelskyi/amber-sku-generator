const crypto = require('node:crypto');
const { stableJson } = require('./export-exposure/evidence');
const { normalizeDecimal } = require('./magento/first-sync-field-plan');
const FORMAT = 'sv-canonical-weight-repair-v1', MAGENTO_FORMAT = 'sv-canonical-weight-magento-v1';
const MISSING_ONLY = 'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED';
const REMOTE_KEYS = ['bindingRevisionId','definitionHash','fieldReason','fieldStatus','remoteProductId','scope','sku','target','value'];
const LIMIT = 1000, MAX_PLAN_BYTES = 32 * 1024 * 1024, MAX_EVIDENCE_BYTES = 1024 * 1024;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const id = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const error = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
function body(plan) { const { planHash: ignored, ...value } = plan; void ignored; return value; }
function seal(value) {
  const text = stableJson(value);
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw error('SV_CANONICAL_WEIGHT_PLAN_LIMIT', 422);
  return { ...value, planHash: digest(text) };
}
function verify(plan, expectedHash, expectedDatabase, installationKey) {
  try {
    if (!plan || ![FORMAT, MAGENTO_FORMAT].includes(plan.format) || !['apply', 'rollback'].includes(plan.direction)
      || !fingerprint(expectedHash) || plan.planHash !== expectedHash || digest(stableJson(body(plan))) !== expectedHash
      || Buffer.byteLength(stableJson(body(plan))) > MAX_PLAN_BYTES || plan.database !== expectedDatabase
      || !expectedDatabase || !installationKey || plan.installationKey !== installationKey || !uuid(plan.bindingRevisionId)
      || !fingerprint(plan.originHash) || typeof plan.configurationText !== 'string'
      || !Array.isArray(plan.entries) || plan.entries.length > LIMIT || new Set(plan.entries.map(e => e.productId)).size !== plan.entries.length) throw 0;
    const configuration = JSON.parse(plan.configurationText);
    if (configuration.binding?.id !== plan.bindingRevisionId || configuration.currentBinding !== plan.bindingRevisionId
      || configuration.activation?.installation_key !== installationKey || configuration.binding.origin_hash !== plan.originHash) throw 0;
    for (const e of plan.entries) {
      if (!id(e.productId) || typeof e.eligible !== 'boolean' || !Array.isArray(e.reasonCodes)) throw 0;
      if (!e.eligible) continue;
      if (typeof e.beforeEvidence !== 'string' || typeof e.afterEvidence !== 'string'
        || Buffer.byteLength(e.beforeEvidence) > MAX_EVIDENCE_BYTES || Buffer.byteLength(e.afterEvidence) > MAX_EVIDENCE_BYTES
        || digest(e.beforeEvidence) !== e.beforeFingerprint || digest(e.afterEvidence) !== e.afterFingerprint
        || !fingerprint(e.publishedResultHash) || !id(e.weightQuestionId)
        || typeof e.targetWeight !== 'string' || !/^\d{1,11}\.\d{3}$/.test(e.targetWeight)
        || (plan.direction === 'apply' ? Number(e.targetWeight) <= 0 : e.targetWeight !== '0.000' || !uuid(e.originalReceiptId))) throw 0;
      const before = JSON.parse(e.beforeEvidence), after = JSON.parse(e.afterEvidence);
      if (before.product?.id !== e.productId || after.product?.id !== e.productId
        || before.identity?.public_sku !== e.publicSku || Number(after.product.weight) !== Number(e.targetWeight)) throw 0;
      if (plan.format === MAGENTO_FORMAT) magentoEntry(plan, e, before, after);
      else if (['sourceKind','targetAnswer','remoteEvidence'].some(key => Object.hasOwn(e, key))) throw 0;
    }
    return stableJson(body(plan));
  } catch { throw error('SV_CANONICAL_WEIGHT_PLAN_INVALID', 422); }
}
// Magento readback entries: strict remote evidence that normalizes to the exact target.
function magentoEntry(plan, e, before, after) {
  const r = e.remoteEvidence, apply = plan.direction === 'apply';
  const answer = apply ? normalizeDecimal(e.targetWeight, 3) : e.targetAnswer;
  if (e.sourceKind !== 'magento_readback' || typeof e.sourceAnswerPresent !== 'boolean'
    || typeof e.targetAnswer !== 'string' || e.targetAnswer !== answer || normalizeDecimal(e.targetAnswer, 3) !== e.targetAnswer || !(Number(e.targetAnswer) > 0)
    || !r || Object.getPrototypeOf(r) !== Object.prototype || Object.keys(r).sort().join() !== REMOTE_KEYS.join()
    || r.sku !== e.publicSku || !id(r.remoteProductId) || r.target !== 'decor_weight' || r.scope !== 'all'
    || !['string','number'].includes(typeof r.value) || normalizeDecimal(r.value, 3) !== e.targetAnswer
    || typeof r.fieldStatus !== 'string' || r.fieldReason !== MISSING_ONLY
    || r.bindingRevisionId !== plan.bindingRevisionId || !fingerprint(r.definitionHash)) throw 0;
  const answers = value => value.product?.details?.answers, own = value => Object.hasOwn(answers(value) || {}, 'weight');
  const [missing, repaired] = apply ? [before, after] : [after, before];
  if (Number(missing.product.weight) !== 0 || answers(repaired)?.weight !== e.targetAnswer
    || Number(repaired.product.weight) !== Number(e.targetAnswer) || own(missing) !== e.sourceAnswerPresent
    || (own(missing) ? JSON.stringify(answers(missing).weight) !== JSON.stringify(e.sourceAnswer) : e.sourceAnswer !== null)) throw 0;
}
function selection(plan, productIds) {
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > LIMIT
    || productIds.some(value => !id(value)) || new Set(productIds).size !== productIds.length) throw error('SV_CANONICAL_WEIGHT_SCOPE_INVALID', 422);
  const entries = [...productIds].sort((a,b) => a-b).map(value => plan.entries.find(e => e.productId === value));
  if (entries.some(e => !e?.eligible)) throw error('SV_CANONICAL_WEIGHT_SCOPE_INVALID', 422);
  return entries;
}
module.exports = { FORMAT, MAGENTO_FORMAT, MISSING_ONLY, LIMIT, MAX_PLAN_BYTES, MAX_EVIDENCE_BYTES, digest, id, fingerprint, uuid, error, seal, verify, selection };
