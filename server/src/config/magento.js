const { MagentoIntegrationError } = require('../services/magento/errors');

function validateBaseUrl(value, nodeEnv = process.env.NODE_ENV) {
  try {
    // Check the original text too: URL normalization must not hide /admin/..,
    // backslashes, control characters, userinfo, or empty query/fragment markers.
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s@]+\/?$/.test(value)) throw new Error();
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && nodeEnv !== 'production'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) throw new Error();
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new MagentoIntegrationError('MAGENTO_BASE_URL_INVALID');
  }
}

function parseMagentoConfig(env = process.env) {
  const names = ['MAGENTO_BASE_URL', 'MAGENTO_CONSUMER_KEY', 'MAGENTO_CONSUMER_SECRET',
    'MAGENTO_ACCESS_TOKEN', 'MAGENTO_ACCESS_TOKEN_SECRET'];
  const values = names.map((name) => String(env[name] ?? '').trim());
  if (values.every((value) => !value)) return Object.freeze({ configured: false });
  if (values.some((value) => !value)) throw new MagentoIntegrationError('MAGENTO_CONFIG_INVALID');
  const [baseUrl, consumerKey, consumerSecret, accessToken, accessTokenSecret] = values;
  return Object.freeze({ configured: true, baseUrl: validateBaseUrl(baseUrl, env.NODE_ENV),
    consumerKey, consumerSecret, accessToken, accessTokenSecret });
}

module.exports = { parseMagentoConfig, validateBaseUrl };
