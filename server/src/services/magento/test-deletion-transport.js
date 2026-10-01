const { validateBaseUrl } = require('../../config/magento');
const { signTestDeleteRequest } = require('./oauth');
const { error, originHash } = require('./binding-contract');

// This transport accepts only the service's committed dispatch record, never an HTTP body.
async function deleteSealedProduct(config, intent, { fetchImpl = globalThis.fetch } = {}) {
  if (intent.state !== 'dispatched' || !intent.dispatched_at || !intent.id
    || !/^AG-[0-9]{6,}$/.test(intent.public_sku) || !intent.remote_product_id
    || intent.origin_hash !== originHash(config.baseUrl)) throw error(422, 'TEST_DELETE_INTENT_REQUIRED', 'Sealed dispatch required');
  const url = `${validateBaseUrl(config.baseUrl)}/rest/all/V1/products/${intent.public_sku}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(url, { method: 'DELETE', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: signTestDeleteRequest(url, config) } });
    if (!response.ok) throw new Error();
    // Neither HTTP status nor response body is proof of absence.
  } catch { throw error(502, 'TEST_DELETE_UNCERTAIN', 'Deletion requires exact read verification'); }
  finally { controller.abort(); clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}
module.exports = { deleteSealedProduct };
