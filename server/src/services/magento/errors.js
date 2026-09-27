const MESSAGES = Object.freeze({
  MAGENTO_NOT_CONFIGURED: 'Magento integration is not configured.',
  MAGENTO_CONFIG_INVALID: 'Magento requires MAGENTO_BASE_URL and all four OAuth credential fields.',
  MAGENTO_BASE_URL_INVALID: 'MAGENTO_BASE_URL must be an HTTPS origin without credentials, path, query or fragment; HTTP loopback is allowed only outside production.',
  MAGENTO_INPUT_INVALID: 'Invalid Magento read request parameters.',
  MAGENTO_SIGNING_FAILED: 'Magento OAuth request signing failed.',
  MAGENTO_HTTP_ERROR: 'Magento returned an unsuccessful HTTP status.',
  MAGENTO_NETWORK_ERROR: 'Magento request failed; check connectivity and TLS.',
  MAGENTO_TIMEOUT: 'Magento request timed out.',
  MAGENTO_RESPONSE_INVALID: 'Magento returned an unexpected JSON response.',
  MAGENTO_RESPONSE_TOO_LARGE: 'Magento response exceeded the size limit.',
  MAGENTO_DISCOVERY_LIMIT: 'Magento discovery exceeded the pagination limit.',
  MAGENTO_PROBE_ARGUMENTS: 'Invalid probe arguments; use --help for supported options.',
  MAGENTO_PROBE_FAILED: 'Magento probe failed.',
});

class MagentoIntegrationError extends Error {
  constructor(code, status) {
    super(MESSAGES[code] || MESSAGES.MAGENTO_PROBE_FAILED);
    this.name = 'MagentoIntegrationError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'MAGENTO_PROBE_FAILED';
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

module.exports = { MagentoIntegrationError };
