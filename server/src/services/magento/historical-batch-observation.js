const { createMagentoClient, readResponseBytes } = require('./client');
const { auditMagentoSchema } = require('./schema-audit');
const { readCategoryObservation } = require('./sync-preview');
const { readBatches } = require('./schema-read-batches');
const s = require('../historical-reactivation-state');

// Private to one explicit review/revalidation. No product evidence or metadata
// survives into a later operation, confirmation, enqueue or dispatch.
function createBatchObservation(config, options = {}) {
  const controller = new AbortController();
  const deadline = options.deadlineAt || Date.now() + 5 * 60 * 1000;
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let active = 0, requests = 0, observation;
  const waiters = [];
  const check = () => { if (signal.aborted || Date.now() >= deadline) s.fail('HISTORICAL_OPERATION_DEADLINE'); };
  const fetchImpl = async (url, init) => {
    if (init.method !== 'GET') s.fail('HISTORICAL_PREVIEW_GET_ONLY');
    check();
    if (active >= 4) await new Promise(resolve => waiters.push(resolve));
    else active++;
    let response;
    try {
      check();
      if (++requests > 512) s.fail('HISTORICAL_OPERATION_READ_LIMIT');
      response = await (options.fetchImpl || globalThis.fetch)(url, { ...init,
        signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
      // Hold the global slot until the bounded body is consumed, not just until
      // headers arrive. Each caller receives its own detached response bytes.
      const bytes = await readResponseBytes(response);
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      const next = waiters.shift();
      if (next) next(); else active--;
    }
  };
  async function get() {
    check();
    observation ||= (async () => {
      const schema = await (options.discover || auditMagentoSchema)(config, { fetchImpl, storeCode: 'all', concurrency: 4 });
      const categories = await readCategoryObservation(createMagentoClient(config, { fetchImpl }), schema, 4);
      check();
      return { schema, categories };
    })();
    return observation;
  }
  return { fetchImpl, get, check, async map(items, read, consume) { await readBatches(items, 2, read, consume); },
    close() { clearTimeout(timer); controller.abort(); } };
}

module.exports = { createBatchObservation };
