const { validateBaseUrl } = require('../../config/magento');
const { signSyncRequest, percentEncode } = require('./oauth');
const { readJson } = require('./client');
const { error, safeData } = require('./binding-contract');

// Separate from the closed GET client. Only durable worker operations reach this transport.
async function dispatch(config, operation, { apply, fetchImpl = globalThis.fetch } = {}) {
  if (apply !== true) throw error(422, 'MAGENTO_SYNC_APPLY_REQUIRED', 'Explicit apply required');
  safeData(operation);
  let scope = 'all'; let endpoint = 'products';
  if (operation.domain === 'inventory') endpoint = 'inventory/source-items';
  else if (operation.domain === 'websites') endpoint = `products/${percentEncode(operation.payload.productWebsiteLink.sku)}/websites`;
  else if (operation.domain === 'storeViews') scope = 'en';
  else if (!['coreProduct', 'categories'].includes(operation.domain)) throw error(422, 'MAGENTO_SYNC_OPERATION_INVALID', 'Unsupported operation');
  const url = `${validateBaseUrl(config.baseUrl)}/rest/${scope}/V1/${endpoint}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: signSyncRequest(url, config) },
      body: JSON.stringify(operation.payload) });
    if (!response.ok) throw new Error();
    await readJson(response); // A successful response alone is never acknowledgement.
  } catch { throw error(502, 'MAGENTO_SYNC_MUTATION_UNCERTAIN', 'Mutation outcome requires read verification'); }
  finally {
    controller.abort(); clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
module.exports = { dispatch };
