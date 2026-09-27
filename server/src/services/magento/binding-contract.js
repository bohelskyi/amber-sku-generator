const { createHash } = require('node:crypto');
const { PublicHttpError } = require('../../http/errors');
const { validateBaseUrl } = require('../../config/magento');
const { normalizeAttribute, normalizeOptions } = require('./schema-audit');
const { percentEncode } = require('./oauth');

const error = (status, code, message, details) => new PublicHttpError(status, message, { code, details });
const invalid = () => { throw error(422, 'MAGENTO_BINDING_INVALID', 'Invalid Magento binding data'); };
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const hash = (v) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const originHash = (origin) => hash(validateBaseUrl(origin));
const code = (v) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const semanticId = (v) => typeof v === 'string' && /^(0|-?[1-9][0-9]*)$/.test(v)
  && Number.isSafeInteger(Number(v)) && Number(v) >= -2147483648 && Number(v) <= 2147483647;
function command(v, required, optional = []) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype
    || required.some((k) => !Object.hasOwn(v, k))
    || Object.keys(v).some((k) => ![...required, ...optional].includes(k))) invalid();
}
function counter(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9][0-9]{0,18}$/.test(s) || BigInt(s) > 9223372036854775806n) invalid();
  return s;
}
function identity(v) {
  if (typeof v !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)) invalid();
  return v;
}
function installation(v) {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(v)) invalid();
  return v;
}
function safeData(v, secrets = [], maxBytes = 4 * 1024 * 1024) {
  const forbidden = [...secrets, ...['MAGENTO_CONSUMER_KEY','MAGENTO_CONSUMER_SECRET','MAGENTO_ACCESS_TOKEN','MAGENTO_ACCESS_TOKEN_SECRET']
    .map((k) => process.env[k])].filter((s) => typeof s === 'string' && s.length).flatMap((s) => [s, percentEncode(s)]);
  let nodes = 0;
  function visit(x, depth = 0) {
    if (++nodes > 1000000 || depth > 40) invalid();
    if (typeof x === 'string') {
      if (x.length > 16384 || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x)
        || /OAuth\s|oauth_signature|Authorization\s*:|(?:postgres(?:ql)?|https?):\/\/[^\s/]+@/i.test(x)
        || forbidden.some((s) => x.includes(s))) invalid();
    } else if (x && typeof x === 'object') {
      if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype) invalid();
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(x))) {
        if (Array.isArray(x) && k === 'length') continue;
        if (!Object.hasOwn(d, 'value') || ['__proto__','constructor','prototype'].includes(k)
          || /password|secret|access.?token|consumer.?key|authorization/i.test(k)) invalid();
        visit(k, depth + 1); visit(d.value, depth + 1);
      }
    } else if (x !== null && typeof x !== 'boolean' && !(typeof x === 'number' && Number.isFinite(x))) invalid();
  }
  visit(v);
  if (Buffer.byteLength(JSON.stringify(v)) > maxBytes) invalid();
  return JSON.parse(JSON.stringify(v));
}
function unique(items, key) {
  if (new Set(items.map(key)).size !== items.length) invalid();
  return items;
}
function list(v, limit = 10000) { if (!Array.isArray(v) || v.length > limit) invalid(); return v; }
function normalizeSchema(report, secrets = []) {
  safeData(report, secrets, 64 * 1024 * 1024);
  if (!code(report.storeCode)) invalid();
  const attributes = unique(list(report.attributes).map((a) => ({ ...normalizeAttribute(a),
    options: normalizeOptions(a.options || []).map(({ value, label }) => ({ value, label, isEmpty: value === '' })) })), (a) => a.attribute_code)
    .sort((a, b) => a.attribute_code.localeCompare(b.attribute_code, 'en'));
  unique(attributes, (a) => a.attribute_id);
  const attributeSets = unique(list(report.attributeSets).map((s) => {
    if (!positive(s.attribute_set_id) || typeof s.attribute_set_name !== 'string' || !s.attribute_set_name || s.attribute_set_name.length > 4096) invalid();
    const attributeCodes = unique(list(s.attributeCodes).map((c) => {
      if (!attributes.some((a) => a.attribute_code === c)) invalid(); return c;
    }), (c) => c).sort();
    return { attribute_set_id: s.attribute_set_id, attribute_set_name: s.attribute_set_name, attributeCodes };
  }), (s) => s.attribute_set_id).sort((a, b) => a.attribute_set_id - b.attribute_set_id);
  const storeTopology = {};
  for (const kind of ['websites','storeGroups','storeViews']) {
    storeTopology[kind] = unique(list(report.storeTopology?.[kind]).map((v) => {
      if (!Number.isSafeInteger(v.id) || v.id < 0 || typeof v.name !== 'string') invalid();
      const out = { id: v.id, name: v.name };
      for (const key of ['code','website_id','root_category_id','default_store_id','store_group_id','default_group_id','is_active']) {
        if (!Object.hasOwn(v, key)) continue;
        if (key === 'code' ? !code(v[key]) : key === 'is_active' ? typeof v[key] !== 'boolean'
          : !Number.isSafeInteger(v[key]) || v[key] < 0) invalid();
        out[key] = v[key];
      }
      if (kind !== 'storeGroups' && !out.code) invalid();
      if (kind !== 'websites' && out.website_id === undefined) invalid();
      if (kind === 'storeViews' && out.store_group_id === undefined) invalid();
      return out;
    }), (v) => v.id).sort((a, b) => a.id - b.id);
    unique(storeTopology[kind].filter((v) => v.code !== undefined), (v) => v.code);
  }
  for (const g of storeTopology.storeGroups) if (!storeTopology.websites.some((w) => w.id === g.website_id)) invalid();
  for (const v of storeTopology.storeViews) if (!storeTopology.storeGroups.some((g) => g.id === v.store_group_id && g.website_id === v.website_id)) invalid();
  return { storeCode: report.storeCode, attributes, attributeSets, storeTopology };
}

module.exports = { error, invalid, hash, originHash, code, positive, semanticId, command, counter, identity,
  installation, safeData, unique, list, normalizeSchema };
