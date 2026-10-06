const { MagentoIntegrationError } = require('./errors');

// Each invocation owns its budget and reads fresh evidence. Batches finish before
// errors propagate, so failed discovery cannot leave reads running during APPLY.
async function readBatches(items, concurrency, read, consume) {
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map((item) => Promise.resolve().then(() => read(item))));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    for (let offset = 0; offset < batch.length; offset++) {
      await consume(batch[offset], results[offset].value);
    }
  }
}

async function withReadBudget(fetchImpl, operation) {
  const controller = new AbortController();
  const deadline = performance.now() + 60000;
  const timer = setTimeout(() => controller.abort(), 60000);
  timer.unref?.();
  let requests = 0;
  const bounded = async (url, options) => {
    if (options.method !== 'GET' || controller.signal.aborted || performance.now() >= deadline || ++requests > 512) {
      throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
    }
    return fetchImpl(url, { ...options, signal: options.signal
      ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
  };
  try { return await operation(bounded); }
  catch (cause) {
    if (controller.signal.aborted) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
    throw cause;
  } finally { clearTimeout(timer); controller.abort(); }
}

module.exports = { readBatches, withReadBudget };
