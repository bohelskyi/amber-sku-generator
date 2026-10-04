const { validateBaseUrl } = require('../../config/magento');
const { MagentoIntegrationError } = require('./errors');
const { percentEncode, signGetRequest } = require('./oauth');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 100;

function inputError() { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value)) inputError();
  return value;
}
function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) inputError();
  return String(value);
}
function validatedSku(sku) {
  if (typeof sku !== 'string' || !sku.trim() || sku.length > 256 || /^[.]{1,2}$/.test(sku)
    || /[\u0000-\u001f\u007f]/.test(sku)) inputError();
  try { percentEncode(sku); } catch { return inputError(); }
  return sku;
}

async function readResponseBytes(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new MagentoIntegrationError('MAGENTO_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType) || !response.body) {
    throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
  }
  const bytes = await readResponseBytes(response);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID'); }
}

function createMagentoClient(config, { fetchImpl = globalThis.fetch, storeCode = 'all', timeoutMs = 10000,
  oauthOptions } = {}) {
  if (!config?.configured) throw new MagentoIntegrationError('MAGENTO_NOT_CONFIGURED');
  const baseUrl = validateBaseUrl(config.baseUrl);
  const credentials = { ...config }; // Snapshot; later caller mutation cannot redirect signed requests.
  identifier(storeCode);
  positiveInteger(timeoutMs, 60000);
  if (typeof fetchImpl !== 'function') inputError();
  const prefix = `${baseUrl}/rest/${storeCode}/V1/`;

  async function get(path, query) {
    const url = new URL(`${prefix}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const transmittedUrl = url.toString();
    const authorization = signGetRequest(transmittedUrl, credentials, oauthOptions);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
    let response;
    try {
      response = await fetchImpl(transmittedUrl, { method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json', Authorization: authorization }, signal: controller.signal });
      if (!response.ok) throw new MagentoIntegrationError('MAGENTO_HTTP_ERROR', response.status);
      return await readJson(response);
    } catch (error) {
      if (controller.signal.aborted) throw new MagentoIntegrationError('MAGENTO_TIMEOUT');
      if (error instanceof MagentoIntegrationError) throw error;
      throw new MagentoIntegrationError('MAGENTO_NETWORK_ERROR');
    } finally {
      // Abort releases unread error bodies too. Redirect targets never receive credentials.
      controller.abort();
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  function list(path, page = 1) {
    return get(path, { 'searchCriteria[pageSize]': String(PAGE_SIZE),
      'searchCriteria[currentPage]': positiveInteger(page, 100) });
  }

  function findProductBySku(sku) {
    const requestedSku = validatedSku(sku);
    return get('products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': requestedSku,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': '2',
      'searchCriteria[currentPage]': '1',
    }).then((result) => {
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total_count)
        || result.total_count < 0 || result.total_count > 2
        || result.items.length !== result.total_count
        || result.items.some((item) => !item || typeof item !== 'object' || item.sku !== requestedSku)) {
        throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
      }
      if (result.total_count === 0) throw new MagentoIntegrationError('MAGENTO_PRODUCT_NOT_FOUND');
      if (result.total_count === 2) throw new MagentoIntegrationError('MAGENTO_PRODUCT_AMBIGUOUS');
      return result.items[0];
    });
  }

  // No arbitrary URL, method, headers, body, or public transport escape hatch.
  return Object.freeze({
    getWebsites: () => get('store/websites'),
    getStoreGroups: () => get('store/storeGroups'),
    getStoreViews: () => get('store/storeViews'),
    getStoreConfigs: () => get('store/storeConfigs'),
    getInventoryStockForWebsite: (code) => get(`inventory/stock-resolver/website/${identifier(code)}`),
    getInventorySourcesForStock: (id) => get(`inventory/get-sources-assigned-to-stock-ordered-by-priority/${positiveInteger(id)}`),
    getInventorySourceItemsBySku: (sku) => get('inventory/source-items', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': validatedSku(sku),
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': String(PAGE_SIZE), 'searchCriteria[currentPage]': '1',
    }),
    getCategoryTree: (rootCategoryId) => get('categories', { rootCategoryId: positiveInteger(rootCategoryId) }),
    getCategory: (id) => get(`categories/${positiveInteger(id)}`),
    listAttributeSets: (page) => list('products/attribute-sets/sets/list', page),
    getAttributeSet: (id) => get(`products/attribute-sets/${positiveInteger(id)}`),
    getAttributeSetAttributes: (id) => get(`products/attribute-sets/${positiveInteger(id)}/attributes`),
    getAttributeSetGroups: (id) => get('products/attribute-sets/groups/list', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'attribute_set_id',
      'searchCriteria[filter_groups][0][filters][0][value]': positiveInteger(id),
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': '100', 'searchCriteria[currentPage]': '1',
    }),
    listProductAttributes: (page) => list('products/attributes', page),
    getProductAttribute: (code) => get(`products/attributes/${identifier(code)}`),
    findProductAttribute: (code) => get('products/attributes', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'attribute_code',
      'searchCriteria[filter_groups][0][filters][0][value]': identifier(code),
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': '2', 'searchCriteria[currentPage]': '1',
    }).then((result) => {
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total_count)
        || result.total_count < 0 || result.total_count > 1 || result.items.length !== result.total_count
        || result.items.some((item) => item?.attribute_code !== code)) inputError();
      return result.items[0] || null;
    }),
    getProductAttributeOptions: (code) => get(`products/attributes/${identifier(code)}/options`),
    getScopedOptionLabels: (code,id) => get(`amber/attributes/${identifier(code)}/options/${positiveInteger(id)}/labels`),
    findProductBySku,
    // Diagnostic route only: Magento 2.4.6 can reject signed encoded-slash paths.
    getProductBySkuPathDiagnostic: (sku) => get(`products/${percentEncode(validatedSku(sku))}`),
  });
}

module.exports = { createMagentoClient, PAGE_SIZE, MAX_RESPONSE_BYTES, readJson, readResponseBytes };
