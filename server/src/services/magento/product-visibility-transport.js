const { validateBaseUrl } = require('../../config/magento');
const { signProductVisibilityRequest, percentEncode } = require('./oauth');
const { readJson } = require('./client');
const c = require('./binding-contract');

// Status-only exact-SKU PUT; no DELETE, POST/upsert, arbitrary scope or payload.
async function setVisibility(config, { sku, status }, { apply, fetchImpl = globalThis.fetch } = {}) {
  if (apply !== true || !config.configured || typeof sku !== 'string' || !sku.trim() || sku.length > 256
    || /[\u0000-\u001f\u007f]/.test(sku) || /^[.]{1,2}$/.test(sku) || ![1, 2].includes(status)) {
    throw c.error(422, 'PRODUCT_VISIBILITY_INPUT_INVALID', 'Некоректний намір видимості товару.');
  }
  const url = `${validateBaseUrl(config.baseUrl)}/rest/all/V1/products/${percentEncode(sku)}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(url, { method: 'PUT', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: signProductVisibilityRequest(url, config, sku) }, body: JSON.stringify({ product: { sku, status } }) });
    if (!response.ok) throw new Error();
    await readJson(response);
  } catch { throw c.error(502, 'PRODUCT_VISIBILITY_UNCERTAIN', 'Результат зміни видимості потрібно перевірити без повторного надсилання.'); }
  finally {
    clearTimeout(timer); controller.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
module.exports = { setVisibility };
