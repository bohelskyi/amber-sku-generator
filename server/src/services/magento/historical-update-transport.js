const { validateBaseUrl } = require('../../config/magento');
const { signGetRequest, signExistingProductUpdateRequest, percentEncode } = require('./oauth');
const { readJson } = require('./client');
const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const CAPABILITY = Object.freeze({ contract: 'amber-existing-product-update-v1', version: 1,
  atomic: true, productCreateAllowed: false, identity: ['sku', 'entity_id'], scopes: ['all', 'en'] });
async function request(config, path, method, body, options) {
  if (!config.configured) s.fail('HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED');
  const url = `${validateBaseUrl(config.baseUrl)}${path}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await (options.fetchImpl || globalThis.fetch)(url, { method, redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: method === 'GET' ? signGetRequest(url, config)
          : signExistingProductUpdateRequest(url, config, body.product.sku, body.product.id) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error();
    return await readJson(response);
  } catch { s.fail(method === 'GET' ? 'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED' : 'HISTORICAL_ATOMIC_UPDATE_UNCERTAIN', 502); }
  finally { clearTimeout(timer); controller.abort(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}
async function capability(config, options = {}) {
  const value = await request(config, '/rest/all/V1/amber/products/existing-update-capability', 'GET', null, options);
  if (c.hash(value) !== c.hash(CAPABILITY)) s.fail('HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED');
  return CAPABILITY;
}
async function updateProduct(config, proof, product, scope, options = {}) {
  if (options.apply !== true || !['all','en'].includes(scope) || !product || product.sku !== proof.public_sku
    || !Number.isSafeInteger(Number(proof.remote_product_id)) || Number(proof.remote_product_id) <= 0
    || proof.origin_hash !== c.originHash(config.baseUrl)) s.fail('HISTORICAL_ATOMIC_UPDATE_INPUT_INVALID', 422);
  c.identity(proof.id); c.safeData(product);
  if (product.id != null && Number(product.id) !== Number(proof.remote_product_id)) s.fail('HISTORICAL_REMOTE_IDENTITY_MISMATCH');
  await capability(config, options);
  const exact = { ...product, id: Number(proof.remote_product_id), sku: proof.public_sku };
  const body = { contract: CAPABILITY.contract, intentId: proof.id,
    operationKey: c.hash({ intentId: proof.id, jobId: options.jobId || null, scope, product: exact }), product: exact };
  return request(config, `/rest/${scope}/V1/amber/products/${percentEncode(proof.public_sku)}/existing/${exact.id}`, 'PUT', body, options);
}
async function hideExisting(config, proof, options = {}) {
  return updateProduct(config, proof, { sku: proof.public_sku, status: 2 }, 'all', options);
}
async function dispatchExisting(config, proof, operation, options = {}) {
  c.safeData(operation);
  if (['coreProduct','categories','storeViews'].includes(operation.domain)) {
    if (Object.keys(operation.payload || {}).some(key => key !== 'product')) s.fail('HISTORICAL_ATOMIC_UPDATE_INPUT_INVALID', 422);
    return updateProduct(config, proof, operation.payload?.product, operation.domain === 'storeViews' ? 'en' : 'all', options);
  }
  if (!['categoryLinkSave','categoryLinkDelete','inventory','websites'].includes(operation.domain)
    || options.apply !== true || typeof options.dispatchOther !== 'function') s.fail('HISTORICAL_CREATE_FORBIDDEN');
  const referenced = operation.domain === 'categoryLinkSave' ? [operation.payload?.productLink?.sku]
    : operation.domain === 'categoryLinkDelete' ? [operation.payload?.sku]
      : operation.domain === 'websites' ? [operation.payload?.productWebsiteLink?.sku]
        : operation.payload?.sourceItems?.map(item => item.sku);
  if (!Array.isArray(referenced) || !referenced.length || referenced.some(sku => sku !== proof.public_sku)
    || proof.origin_hash !== c.originHash(config.baseUrl)) s.fail('HISTORICAL_REMOTE_IDENTITY_MISMATCH');
  await capability(config, options);
  return options.dispatchOther(config, operation, { apply: true, fetchImpl: options.fetchImpl });
}
module.exports = { CAPABILITY, capability, updateProduct, hideExisting, dispatchExisting };
