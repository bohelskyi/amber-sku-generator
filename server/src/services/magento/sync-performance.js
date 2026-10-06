const { AsyncLocalStorage } = require('node:async_hooks');

const phases = new Set(['observation', 'schema_discovery', 'precondition_read', 'dispatch', 'step_readback', 'final_readback']);
const codes = new Set(['MAGENTO_TIMEOUT', 'MAGENTO_NETWORK_ERROR', 'MAGENTO_HTTP_ERROR', 'MAGENTO_RESPONSE_INVALID',
  'MAGENTO_RESPONSE_TOO_LARGE', 'MAGENTO_DISCOVERY_LIMIT', 'MAGENTO_INPUT_INVALID', 'MAGENTO_NOT_CONFIGURED',
  'MAGENTO_SYNC_READ_FAILED', 'MAGENTO_SYNC_OBSERVATION_REQUIRED', 'MAGENTO_SYNC_AMBER_CHANGED',
  'MAGENTO_SYNC_BINDING_CHANGED', 'MAGENTO_SYNC_MUTATION_UNCERTAIN', 'MAGENTO_SYNC_VERIFICATION_MISMATCH',
  'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED', 'ADMIN_PERMISSION_REVOKED']);
const storage = new AsyncLocalStorage();
const wrapped = new WeakSet();
const round = (value) => Number(Math.max(0, value).toFixed(3));

function identity(options) {
  try {
    const automatic = options?.automatic;
    if (!automatic || !Number.isSafeInteger(automatic.productId) || automatic.productId <= 0) return null;
    const publicIdentityId = String(automatic.publicIdentityId), generation = String(automatic.generation);
    if (!/^[1-9]\d{0,19}$/.test(publicIdentityId) || !/^[1-9]\d{0,19}$/.test(generation)) return null;
    return { productId: automatic.productId, publicIdentityId, generation };
  } catch { return null; }
}

function log(options, event, value) {
  try {
    const pending = options.logger.info(event, value);
    pending?.catch?.(() => {});
  } catch { /* Logging cannot authorize, block or retry an operation. */ }
}

function canLog(options) {
  try { return typeof options.logger?.info === 'function'; } catch { return false; }
}

function endpoint(url, method) {
  const path = new URL(url).pathname;
  const match = /^\/rest\/([^/]+)\/V1\/(.*)$/.exec(path);
  if (!match) return { kind: 'other', scope: 'other' };
  const scope = ['all', 'en'].includes(match[1]) ? match[1] : 'other';
  const route = match[2];
  const known = [
    [/^store\/websites$/, 'websites'], [/^store\/storeGroups$/, 'store_groups'], [/^store\/storeViews$/, 'store_views'],
    [/^products\/attribute-sets\/sets\/list$/, 'attribute_sets'], [/^products\/attributes$/, 'attributes'],
    [/^products\/attribute-sets\/\d+\/attributes$/, 'set_membership'], [/^products\/attributes\/[^/]+\/options$/, 'attribute_options'],
    [/^categories$/, 'category_tree'], [/^inventory\/stock-resolver\//, 'inventory_stock'],
    [/^inventory\/get-sources-assigned-to-stock-ordered-by-priority\//, 'inventory_sources'],
    [/^inventory\/source-items$/, 'inventory_items'], [/^products(?:\/[^/]+)?$/, method === 'GET' ? 'product_lookup' : 'product_write'],
  ];
  return { kind: known.find(([pattern]) => pattern.test(route))?.[1] || 'other', scope };
}

function telemetryFetch(original = globalThis.fetch) {
  if (wrapped.has(original)) return original;
  const fetchImpl = async (...args) => {
    const started = performance.now(); let failed = false;
    try { return await original(...args); }
    catch (cause) { failed = true; throw cause; }
    finally {
      try {
        const rawMethod = args[1]?.method || 'GET';
        const method = ['GET', 'POST', 'PUT', 'DELETE'].includes(rawMethod) ? rawMethod : 'other';
        const descriptor = endpoint(args[0], method), elapsed = performance.now() - started;
        const current = storage.getStore();
        for (let collector = current; collector; collector = collector.parent) {
          if (collector.owner !== current.owner) break;
          const key = `${method}:${descriptor.kind}:${descriptor.scope}`;
          const overflow = !collector.kinds.has(key) && collector.kinds.size >= 31;
          const bucketKey = overflow ? 'other' : key;
          const item = collector.kinds.get(bucketKey) || { ...(overflow ? { kind: 'other', scope: 'other', method: 'other' }
            : { ...descriptor, method }), count: 0, headersDurationMs: 0, maxHeadersDurationMs: 0, fetchFailures: 0 };
          item.count++; item.headersDurationMs += elapsed; item.maxHeadersDurationMs = Math.max(item.maxHeadersDurationMs, elapsed);
          item.fetchFailures += Number(failed); collector.kinds.set(bucketKey, item);
        }
      } catch { /* Diagnostic metadata cannot change fetch arguments, response, failure or cancellation. */ }
    }
  };
  wrapped.add(fetchImpl); return fetchImpl;
}

// Phase duration includes body parsing/local work; transport timings stop at response headers.
// No URL, query, header, payload, body or SKU enters the bounded aggregate (at most 32 kinds).
async function measurePhase(options, phase, operation) {
  const owner = identity(options);
  if (!owner || !phases.has(phase) || !canLog(options)) return operation(options.fetchImpl || globalThis.fetch);
  const stage = ['enqueue', 'apply'].includes(options.telemetryStage) ? options.telemetryStage : 'unspecified';
  const collector = { owner: `${owner.productId}:${owner.publicIdentityId}:${owner.generation}:${stage}`, parent: storage.getStore(), kinds: new Map() };
  const started = performance.now(), startedUtc = new Date().toISOString(); let code = null;
  try { return await storage.run(collector, () => operation(telemetryFetch(options.fetchImpl))); }
  catch (cause) {
    try { code = codes.has(cause?.code) ? cause.code : 'LOCAL_OPERATION_FAILED'; }
    catch { code = 'LOCAL_OPERATION_FAILED'; }
    throw cause;
  }
  finally {
    const kinds = [...collector.kinds.values()].map((entry) => ({ ...entry,
      headersDurationMs: round(entry.headersDurationMs), maxHeadersDurationMs: round(entry.maxHeadersDurationMs) }));
    log(options, 'magento.auto_sync.phase', { phase, stage, ...owner, startedUtc, finishedUtc: new Date().toISOString(),
      durationMs: round(performance.now() - started), code,
      transportHeaders: { count: kinds.reduce((sum, item) => sum + item.count, 0), kinds } });
  }
}

function recordRequestClaim(options, request, claimedAt = Date.now()) {
  try {
    const owner = identity(options);
    if (!owner || !canLog(options)) return;
    const date = (value) => { const result = new Date(value); return Number.isFinite(result.getTime()) ? result : null; };
    const updated = date(request.updated_at), due = date(request.next_attempt_at);
    log(options, 'magento.auto_sync.request_claimed', { ...owner, claimedUtc: new Date(claimedAt).toISOString(),
      requestUpdatedAt: updated?.toISOString() || null, nextAttemptAt: due?.toISOString() || null,
      requestAgeAtClaimMs: updated ? Math.max(0, claimedAt - updated.getTime()) : null,
      dueDelayAtClaimMs: due ? Math.max(0, claimedAt - due.getTime()) : null });
  } catch { /* Invalid diagnostic metadata cannot interrupt the worker. */ }
}

module.exports = { measurePhase, recordRequestClaim };
