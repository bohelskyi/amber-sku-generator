const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { PublicHttpError } = require('../../http/errors');

const PURPOSE = 'amber:published-export-preview:v1';
const TTL_SECONDS = 15 * 60;
const MAX_TOKEN_BYTES = 8192;
const error = (status, code, message, details) => new PublicHttpError(status, message, { code, details });
const conflict = () => error(409, 'EXPORT_IDEMPOTENCY_CONFLICT', 'Idempotency-Key belongs to a different export operation');
const stale = () => error(409, 'EXPORT_PREVIEW_STALE', 'Export inputs or selection changed; preview again');
const anchor = (value) => String(value || '').trim().toUpperCase() || null;

function requestContract(input) {
  if (input.requestContract === undefined) return 'legacy';
  if (input.requestContract !== 'template-v1') {
    throw error(422, 'EXPORT_CONTRACT_INVALID', 'Unsupported export request contract');
  }
  return 'template-v1';
}
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
    throw error(422, 'EXPORT_SELECTION_INVALID', 'Explicit selection requires template and published version UUIDs');
  }
  return value.toLowerCase();
}
function normalizeIntent(input, { allowInternalProfile = false } = {}) {
  requestContract(input);
  if (input.profile && input.profile !== 'magento-products-v1'
    && !(allowInternalProfile && input.profile === 'internal-legacy')) {
    throw error(422, 'EXPORT_PROFILE_INVALID', 'Template exports require magento-products-v1');
  }
  if (input.mode !== undefined && !['manual', 'new'].includes(input.mode)) {
    throw error(422, 'EXPORT_MODE_INVALID', 'Unsupported export mode');
  }
  const s = input.selection === undefined ? { mode: 'active' } : input.selection;
  if (!s || typeof s !== 'object' || Array.isArray(s)
    || !['active', 'explicit'].includes(s.mode)
    || Object.keys(s).some((k) => !(s.mode === 'active' ? ['mode'] : ['mode', 'templateId', 'versionId']).includes(k))) {
    throw error(422, 'EXPORT_SELECTION_INVALID', 'Use active or explicitly pinned selection');
  }
  const selection = s.mode === 'active' ? { mode: 'active' }
    : { mode: 'explicit', templateId: uuid(s.templateId), versionId: uuid(s.versionId) };
  return { requestContract: 'template-v1', profile: input.profile || 'magento-products-v1', mode: input.mode || 'manual',
    fromSku: anchor(input.fromSku), toSku: anchor(input.toSku), selection };
}

// Streaming tagged canonicalization has no definition-size cap. Array order and
// missing/null/blank/zero remain distinct; database bigint strings stay strings.
function fingerprint(value) {
  const hash = createHash('sha256');
  function visit(item) {
    if (item === undefined) { hash.update('undefined;'); return; }
    if (item === null) { hash.update('null;'); return; }
    if (Array.isArray(item)) {
      hash.update('['); item.forEach(visit); hash.update(']'); return;
    }
    if (typeof item === 'object') {
      hash.update('{');
      for (const key of Object.keys(item).sort()) { hash.update(JSON.stringify(key)); visit(item[key]); }
      hash.update('}'); return;
    }
    hash.update(`${typeof item}:${JSON.stringify(item)};`);
  }
  visit(value);
  return hash.digest('hex');
}

function validBinding(binding) {
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === expected;
  const id = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!keys(binding, 'cursor,effective,inputFingerprint,intent,range') || !digest(binding.inputFingerprint)) return false;
  try {
    if (binding.intent?.requestContract !== 'template-v1'
      || fingerprint(binding.intent) !== fingerprint(normalizeIntent(binding.intent))) return false;
  } catch { return false; }
  const e = binding.effective;
  const r = binding.range;
  if (!keys(e, 'activationGeneration,definitionHash,evaluatorVersion,formatVersion,outputContract,templateId,versionId')
    || !id(e.templateId) || !id(e.versionId) || !digest(e.definitionHash)
    || typeof e.evaluatorVersion !== 'string' || !e.evaluatorVersion || e.evaluatorVersion.length > 128
    || !['magento-products-v1', 'magento-products-columns-v2'].includes(e.outputContract) || !Number.isSafeInteger(e.formatVersion) || e.formatVersion < 1
    || !keys(r, 'exportedToProductId,fromSku,resolvedToSku,toSku')
    || typeof r.fromSku !== 'string' || !r.fromSku || typeof r.resolvedToSku !== 'string' || !r.resolvedToSku
    || (r.toSku !== null && (typeof r.toSku !== 'string' || !r.toSku))
    || !Number.isSafeInteger(r.exportedToProductId) || r.exportedToProductId < 1) return false;
  const s = binding.intent.selection;
  if (s.mode === 'active' ? typeof e.activationGeneration !== 'string' || !/^[1-9][0-9]*$/.test(e.activationGeneration)
    : e.activationGeneration !== null || e.templateId !== s.templateId || e.versionId !== s.versionId) return false;
  return binding.intent.mode === 'new'
    ? typeof binding.cursor === 'string' && /^(0|[1-9][0-9]*)$/.test(binding.cursor)
    : binding.cursor === null;
}

function makeSigner(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Configured server signing secret required');
  const key = createHmac('sha256', secret).update(PURPOSE).digest();
  const signature = (payload) => createHmac('sha256', key).update(`ep1.${payload}`).digest();
  function sign(binding, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    const payload = Buffer.from(JSON.stringify({ purpose: PURPOSE, iat, exp: iat + TTL_SECONDS, binding })).toString('base64url');
    const token = `ep1.${payload}.${signature(payload).toString('base64url')}`;
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw error(422, 'EXPORT_BINDING_LIMIT', 'Export binding is too large');
    return token;
  }
  function verify(token, { completed = false, now = Date.now() } = {}) {
    if (token === undefined || token === null || token === '') {
      throw error(422, 'EXPORT_PREVIEW_REQUIRED', 'A published export preview is required');
    }
    const invalid = () => error(422, 'EXPORT_PREVIEW_INVALID', 'Invalid published export preview binding');
    if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw invalid();
    const match = /^ep1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw invalid();
    const supplied = Buffer.from(match[2], 'base64url');
    if (supplied.length !== 32 || supplied.toString('base64url') !== match[2]
      || !timingSafeEqual(supplied, signature(match[1]))) throw invalid();
    let claims;
    try { claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (!claims || claims.purpose !== PURPOSE || Object.keys(claims).sort().join() !== 'binding,exp,iat,purpose'
      || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || !Number.isSafeInteger(claims.exp) || claims.exp !== claims.iat + TTL_SECONDS
      || !validBinding(claims.binding)) throw invalid();
    if (!completed && (claims.iat > Math.floor(now / 1000) || claims.exp <= Math.floor(now / 1000))) {
      throw error(409, 'EXPORT_PREVIEW_EXPIRED', 'Published export preview expired; preview again');
    }
    return claims.binding;
  }
  return { sign, verify };
}

function assertCompleted(snapshot, intent, suppliedBinding) {
  if (snapshot.request_contract !== 'template-v1' || fingerprint(snapshot.request_intent) !== fingerprint(intent)
    || (suppliedBinding && fingerprint(snapshot.binding_evidence) !== fingerprint(suppliedBinding))) throw conflict();
  return snapshot;
}
function manifestProvenance(snapshot) {
  if (snapshot.request_contract !== 'template-v1') return {};
  return { requestContract: 'template-v1', template: snapshot.binding_evidence.effective,
    inputFingerprint: snapshot.input_fingerprint };
}

module.exports = { PURPOSE, TTL_SECONDS, MAX_TOKEN_BYTES, error, conflict, stale, requestContract,
  normalizeIntent, fingerprint, makeSigner, assertCompleted, manifestProvenance };
