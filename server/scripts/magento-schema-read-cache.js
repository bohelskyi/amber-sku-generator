'use strict';
// Operator scripts only (never the server, worker or UI): reuse identical GET
// responses of slowly changing Magento schema/topology endpoints for a short TTL
// inside one run. Product, inventory and any other reads are always fresh.
const { readResponseBytes } = require('../src/services/magento/client');
const SCHEMA = [/^store\/(?:websites|storeGroups|storeViews|storeConfigs)$/, /^products\/attribute-sets\/sets\/list$/,
  /^products\/attribute-sets\/\d+\/attributes$/, /^products\/attributes$/, /^products\/attributes\/[^/]+\/options$/,
  /^categories$/];
const MAX_TTL_SECONDS = 600;
function schemaRoute(url) {
  try {
    const match = /^\/rest\/[^/]+\/V1\/(.*)$/.exec(new URL(String(url)).pathname);
    return Boolean(match && SCHEMA.some(pattern => pattern.test(match[1])));
  } catch { return false; }
}
function parseSeconds(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value) || Number(value) > MAX_TTL_SECONDS) return null;
  return Number(value);
}
function schemaReadCache(fetchImpl, seconds, now = Date.now) {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_TTL_SECONDS) throw Object.assign(Error('SCHEMA_CACHE_TTL_INVALID'), { code: 'SCHEMA_CACHE_TTL_INVALID' });
  if (!seconds) return fetchImpl;
  const cache = new Map(), ttl = seconds * 1000;
  const snapshot = async (url, init) => {
    const response = await fetchImpl(url, init);
    try {
      return { ok: response.ok, bytes: await readResponseBytes(response),
        init: { status: response.status, statusText: response.statusText, headers: [...response.headers] } };
    } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  };
  return async (url, init = {}) => {
    const method = String(init.method || (typeof url === 'object' && url?.method) || 'GET').toUpperCase();
    if (method !== 'GET' || init.body != null || typeof url === 'object' && !(url instanceof URL) || !schemaRoute(url)) return fetchImpl(url, init);
    const key = String(url);
    let entry = cache.get(key);
    if (entry && now() - entry.at >= ttl) { cache.delete(key); entry = null; }
    if (!entry) { entry = { at: now(), value: snapshot(url, init) }; cache.set(key, entry); }
    try {
      const value = await entry.value;
      // Failures are never reused; the next caller observes Magento again.
      if (!value.ok && cache.get(key) === entry) cache.delete(key);
      return new Response([204, 205, 304].includes(value.init.status) ? null : value.bytes, value.init);
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
  };
}
module.exports = { schemaReadCache, schemaRoute, parseSeconds, MAX_TTL_SECONDS };
