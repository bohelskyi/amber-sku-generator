const { createHmac, randomBytes } = require('node:crypto');
const { MagentoIntegrationError } = require('./errors');

function percentEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Only closed wrappers below select a method. JSON bodies are not OAuth parameters.
function signRequest(method, urlString, credentials, {
  nonce = randomBytes(24).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  try {
    const url = new URL(urlString);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
      || typeof nonce !== 'string' || !nonce || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error();
    for (const key of ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']) {
      if (typeof credentials[key] !== 'string' || !credentials[key].trim()) throw new Error();
    }
    const oauth = {
      oauth_consumer_key: credentials.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: String(timestamp),
      oauth_token: credentials.accessToken,
      oauth_version: '1.0',
    };
    const parameters = [...url.searchParams, ...Object.entries(oauth)]
      .filter(([key]) => key !== 'oauth_signature')
      .map(([key, value]) => [percentEncode(key), percentEncode(value)])
      .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
      .map(([key, value]) => `${key}=${value}`).join('&');
    const baseString = [method, `${url.origin}${url.pathname}`, parameters].map(percentEncode).join('&');
    const key = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
    oauth.oauth_signature = createHmac('sha256', key).update(baseString).digest('base64');
    return `OAuth ${Object.entries(oauth).sort(([a], [b]) => compare(a, b))
      .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`).join(', ')}`;
  } catch {
    // Never attach the underlying exception: crypto/URL errors can echo input.
    throw new MagentoIntegrationError('MAGENTO_SIGNING_FAILED');
  }
}

function signGetRequest(url, credentials, options) { return signRequest('GET', url, credentials, options); }
function signAttributeCreateRequest(url, credentials, options) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.search || !['/rest/all/V1/products/attributes', '/rest/all/V1/products/attribute-sets/attributes'].includes(parsed.pathname)) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('POST', url, credentials, options);
}
function signOptionCreateRequest(url, credentials, options) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.search || !/^\/rest\/all\/V1\/products\/attributes\/[a-zA-Z][a-zA-Z0-9_]{0,99}\/options$/.test(parsed.pathname)) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('POST', url, credentials, options);
}
function signScopedOptionLabelRequest(url, credentials, options) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.search || !/^\/rest\/all\/V1\/amber\/attributes\/[a-zA-Z][a-zA-Z0-9_]{0,99}\/options\/[1-9][0-9]*\/labels$/.test(parsed.pathname)) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('PUT', url, credentials, options);
}
function signCategoryCreateRequest(url, credentials, options) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.pathname !== '/rest/all/V1/categories' || parsed.search) throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  return signRequest('POST', url, credentials, options);
}
function signSyncRequest(url, credentials, method = 'POST', options) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  const ordinary = /^\/rest\/(all|en)\/V1\/(products|inventory\/source-items|products\/[^/]+\/websites)$/.test(parsed.pathname);
  const categorySave = /^\/rest\/all\/V1\/categories\/[1-9][0-9]*\/products$/.test(parsed.pathname);
  const categoryDelete = /^\/rest\/all\/V1\/categories\/[1-9][0-9]*\/products\/[^/]+$/.test(parsed.pathname);
  if (parsed.search || !((ordinary && method === 'POST') || (categorySave && method === 'POST')
    || (categoryDelete && method === 'DELETE'))) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest(method, url, credentials, options);
}
function signTestDeleteRequest(url, credentials, options) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.search || !/^\/rest\/all\/V1\/products\/(?:AG|TEST)-[0-9]{6,}$/.test(parsed.pathname)) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('DELETE', url, credentials, options);
}
function productSkuSegment(sku) {
  if (typeof sku !== 'string' || !sku.trim() || sku.length > 256 || ['.','..'].includes(sku)
    || /[\u0000-\u001f\u007f]/.test(sku)) throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  try { return percentEncode(sku); } catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
}
function signProductMediaRequest(url, credentials, method, options, sku) {
  let parsed;
  let expectedOrigin;
  try { parsed = new URL(url); expectedOrigin = new URL(credentials.baseUrl).origin; }
  catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  const prefix = `/rest/all/V1/products/${productSkuSegment(sku)}`;
  const upload = parsed.pathname === `${prefix}/media`;
  const metadata = parsed.pathname.startsWith(`${prefix}/media/`) && /^[1-9][0-9]*$/.test(parsed.pathname.slice(`${prefix}/media/`.length));
  const status = parsed.pathname === prefix;
  if (parsed.origin !== expectedOrigin || parsed.search || parsed.hash || !((upload && method === 'POST') || ((metadata || status) && method === 'PUT'))) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest(method, url, credentials, options);
}
function signProductVisibilityRequest(url, credentials, sku, options) {
  let parsed;
  let expectedOrigin;
  try { parsed = new URL(url); expectedOrigin = new URL(credentials.baseUrl).origin; }
  catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  if (parsed.origin !== expectedOrigin || parsed.search || parsed.hash || parsed.pathname !== `/rest/all/V1/products/${productSkuSegment(sku)}`) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('PUT', url, credentials, options);
}
function signExistingProductUpdateRequest(url, credentials, sku, expectedId, options) {
  let parsed, expectedOrigin;
  try { parsed = new URL(url); expectedOrigin = new URL(credentials.baseUrl).origin; }
  catch { throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID'); }
  const segment = productSkuSegment(sku);
  if (!Number.isSafeInteger(Number(expectedId)) || Number(expectedId) <= 0 || parsed.origin !== expectedOrigin
    || parsed.search || parsed.hash || !['all','en'].some(scope => parsed.pathname === `/rest/${scope}/V1/amber/products/${segment}/existing/${Number(expectedId)}`)) {
    throw new MagentoIntegrationError('MAGENTO_INPUT_INVALID');
  }
  return signRequest('PUT', url, credentials, options);
}
module.exports = { percentEncode, signGetRequest, signCategoryCreateRequest, signSyncRequest, signTestDeleteRequest, signOptionCreateRequest, signScopedOptionLabelRequest, signAttributeCreateRequest, signProductMediaRequest, signProductVisibilityRequest, signExistingProductUpdateRequest };
