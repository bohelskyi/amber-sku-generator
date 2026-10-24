import { repairContext, withRepairContext } from './magento-repair-context.js';

const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const code = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value);
const categoryCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
const localPath = (value) => bounded(value, 500) && /^\/(?!\/)/.test(value) && !/[\\?#]/.test(value);
const keys = ['review', 'binding', 'category', 'reviewEntry', 'route', 'language', 'reviewField', 'reviewStore'];
const commandKeys = ['policy', 'approve', 'apply', 'previewToken', 'reviewHash', 'token', 'reason'];

// A navigation intent is never a choice or approval. The returned binding DTO
// supplies the only row identity; absent/ambiguous evidence cannot pick a row.
export function parsePolicyReview(params, category) {
  if (params.get('review') !== 'policies') return null;
  const invalid = { valid: false, category };
  if (keys.some((key) => params.getAll(key).length > 1) || !categoryCode(category)
    || params.has('category') && params.get('category') !== category || !bounded(params.get('binding'), 256)) return invalid;
  const intent = { valid: true, kind: 'general', category, binding: params.get('binding') };
  for (const [key, name, valid] of [
    ['reviewEntry', 'entryId', (v) => bounded(v, 256)], ['route', 'route', (v) => bounded(v, 200)],
    ['language', 'row', (v) => ['base', 'english'].includes(v)], ['reviewField', 'target', code], ['reviewStore', 'store', code],
  ]) {
    if (!params.has(key)) continue;
    if (!valid(params.get(key))) return invalid;
    intent[name] = params.get(key);
  }
  if (intent.entryId) intent.kind = 'id';
  else if (intent.target || intent.store) {
    if (![intent.route, intent.row, intent.target, intent.store].every(Boolean)) return invalid;
    intent.kind = 'tuple';
  }
  return intent;
}

export function resolvePolicyEntry(intent, data) {
  if (!intent?.valid || intent.kind === 'general' || data?.revision?.id !== intent.binding || !Array.isArray(data.entries)) return null;
  const matches = data.entries.filter((entry) => entry?.kind === 'policy' && bounded(entry.id, 256) && entry.group === intent.category
    && (!intent.entryId || entry.id === intent.entryId) && (!intent.route || entry.routeKey === intent.route)
    && (!intent.row || entry.row === intent.row) && (!intent.target || entry.target === intent.target)
    && (!intent.store || entry.label === intent.store));
  return matches.length === 1 ? matches[0] : null;
}

export function policyReviewUrl(path, params, { category, binding, source, entry } = {}) {
  if (!localPath(path) || !categoryCode(category) || !bounded(binding, 256) || source != null && !bounded(source, 256)) return null;
  const next = new URLSearchParams(params);
  for (const key of ['reviewEntry', 'reviewField', 'reviewStore', ...commandKeys]) next.delete(key);
  next.set('category', category); next.set('binding', binding); next.set('review', 'policies');
  if (source) next.set('source', source);
  if (entry) {
    if (entry.kind !== 'policy' || entry.group !== category || !bounded(entry.id, 256)
      || !bounded(entry.routeKey, 200) || !['base', 'english'].includes(entry.row) || !code(entry.target) || !code(entry.label)) return null;
    next.set('reviewEntry', entry.id); next.set('route', entry.routeKey); next.set('language', entry.row);
    next.set('reviewField', entry.target); next.set('reviewStore', entry.label);
  }
  // The generic repair context permits only160 route characters. Preserve the
  // independently validated category API scope (max200) after that sanitizer.
  const route = next.get('route');
  if (route !== null && !bounded(route, 200)) return null;
  const safe = withRepairContext(`${path}?${next}`, repairContext(next));
  const query = new URLSearchParams(safe.split('?')[1]);
  if (route !== null) query.set('route', route);
  if (!parsePolicyReview(query, category)?.valid) return null;
  return `${safe.split('?')[0]}?${query}`;
}

export function closePolicyReviewUrl(path, params) {
  if (!localPath(path)) return null;
  const next = new URLSearchParams(params);
  for (const key of ['reviewEntry', 'reviewField', 'reviewStore', ...commandKeys]) next.delete(key);
  next.set('review', 'closed');
  return `${path}?${next}`;
}
