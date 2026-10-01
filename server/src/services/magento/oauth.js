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
module.exports = { percentEncode, signGetRequest, signCategoryCreateRequest, signSyncRequest };
