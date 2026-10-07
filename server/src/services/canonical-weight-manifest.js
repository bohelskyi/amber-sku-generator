const crypto = require('node:crypto');
const { stableJson } = require('./export-exposure/evidence');
const FORMAT = 'sv-canonical-weight-repair-v1';
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
    if (!plan || plan.format !== FORMAT || !['apply', 'rollback'].includes(plan.direction)
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
    }
    return stableJson(body(plan));
  } catch { throw error('SV_CANONICAL_WEIGHT_PLAN_INVALID', 422); }
}
function selection(plan, productIds) {
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > LIMIT
    || productIds.some(value => !id(value)) || new Set(productIds).size !== productIds.length) throw error('SV_CANONICAL_WEIGHT_SCOPE_INVALID', 422);
  const entries = [...productIds].sort((a,b) => a-b).map(value => plan.entries.find(e => e.productId === value));
  if (entries.some(e => !e?.eligible)) throw error('SV_CANONICAL_WEIGHT_SCOPE_INVALID', 422);
  return entries;
}
module.exports = { FORMAT, LIMIT, MAX_PLAN_BYTES, MAX_EVIDENCE_BYTES, digest, id, fingerprint, uuid, error, seal, verify, selection };
