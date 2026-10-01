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
  MAGENTO_PRODUCT_NOT_FOUND: 'Magento product was not found for the exact SKU.',
  MAGENTO_PRODUCT_AMBIGUOUS: 'Magento returned multiple products for the exact SKU.',
  MAGENTO_PROBE_ARGUMENTS: 'Invalid probe arguments; use --help for supported options.',
  MAGENTO_PROBE_FAILED: 'Magento probe failed.',
  MAGENTO_AUDIT_ARGUMENTS: 'Invalid schema audit arguments; use --help for supported options.',
  MAGENTO_AUDIT_FAILED: 'Magento schema audit failed; no complete artifact was produced.',
  MAGENTO_AUDIT_SENSITIVE_DATA: 'Schema evidence contains sensitive data; no artifact was produced.',
  MAGENTO_BINDING_EVIDENCE_INVALID: 'Amber binding evidence is incomplete, ambiguous or exceeds the audit limits.',
  MAGENTO_BINDING_AUDIT_FAILED: 'Magento binding evidence audit failed; no complete artifact was produced.',
  MAGENTO_BINDING_AUDIT_ARGUMENTS: 'Invalid binding evidence audit arguments; use --help for supported options.',
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
