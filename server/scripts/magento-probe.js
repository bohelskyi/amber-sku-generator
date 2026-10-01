const path = require('node:path');
const { parseMagentoConfig } = require('../src/config/magento');
const { createMagentoClient, PAGE_SIZE } = require('../src/services/magento/client');
const { MagentoIntegrationError } = require('../src/services/magento/errors');
const { percentEncode } = require('../src/services/magento/oauth');
const logger = require('../src/utils/logger');

const HELP = 'npm run magento:probe -- [--sku "KL3/11131351005"] [--store-code CODE] '
  + '[--attribute-set ID] [--attribute CODE]\n'
  + 'GET only. Repeat --attribute-set / --attribute up to 20 times each. No raw response output.';

function parseArguments(args) {
  const options = { storeCode: 'all', attributeSets: [], attributes: [] };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help' && args.length === 1) return { help: true };
    const value = args[++index];
    if (!['--sku', '--store-code', '--attribute-set', '--attribute'].includes(flag)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
    }
    if (flag === '--attribute-set') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
      }
      options.attributeSets.push(value);
    } else if (flag === '--attribute') {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value)) throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
      options.attributes.push(value);
    } else {
      if (seen.has(flag)) throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
      seen.add(flag);
      if (flag === '--sku') {
        if (value.length > 256 || /^[.]{1,2}$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
          throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
        }
        try { percentEncode(value); } catch { throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS'); }
        options.sku = value;
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value)) throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
        options.storeCode = value;
      }
    }
  }
  if (options.attributeSets.length > 20 || options.attributes.length > 20) {
    throw new MagentoIntegrationError('MAGENTO_PROBE_ARGUMENTS');
  }
  return options;
}

function arrayCount(value) {
  if (!Array.isArray(value)) throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
  return value.length;
}

function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

async function discoverPages(readPage, identityField) {
  let total;
  const identities = new Set();
  const sampleIds = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await readPage(page);
    if (!result || !Array.isArray(result.items) || result.items.length > PAGE_SIZE
      || safeInteger(result.total_count) === null || (total !== undefined && total !== result.total_count)) {
      throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
    }
    total = result.total_count;
    if (total > 100 * PAGE_SIZE) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
    for (const item of result.items) {
      const id = item?.[identityField];
      if ((typeof id !== 'string' && safeInteger(id) === null) || identities.has(id)) {
        throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
      }
      identities.add(id);
      if (sampleIds.length < 20 && safeInteger(id) !== null) sampleIds.push(id);
    }
    if (identities.size === total) return { count: total, sampleIds };
    if (identities.size > total || result.items.length === 0) throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
  }
  throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
}

function safeRequestedSku(sku, config) {
  let result = sku;
  const secrets = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']
    .flatMap((key) => [config[key], percentEncode(config[key])]).sort((a, b) => b.length - a.length);
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  return result.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

async function runProbe({ args = [], env = process.env, fetchImpl, log = logger } = {}) {
  try {
    const options = parseArguments(args);
    if (options.help) { log.info('magento.probe.help', { usage: HELP }); return 0; }
    const config = parseMagentoConfig(env);
    log.info('magento.probe.configuration', { configured: config.configured });
    if (!config.configured) return 0;
    const client = createMagentoClient(config, { fetchImpl, storeCode: options.storeCode });
    const summary = {
      websites: arrayCount(await client.getWebsites()),
      storeGroups: arrayCount(await client.getStoreGroups()),
      storeViews: arrayCount(await client.getStoreViews()),
      storeConfigs: arrayCount(await client.getStoreConfigs()),
    };
    const sets = await discoverPages(client.listAttributeSets, 'attribute_set_id');
    summary.attributeSets = sets.count;
    summary.attributeSetIdsSample = sets.sampleIds;
    summary.productAttributes = (await discoverPages(client.listProductAttributes, 'attribute_code')).count;
    log.info('magento.probe.discovery', summary);
    for (const id of options.attributeSets) {
      const attributes = await client.getAttributeSetAttributes(id);
      log.info('magento.probe.attribute_set', { attributeSetId: Number(id), attributes: arrayCount(attributes) });
    }
    for (const code of options.attributes) {
      const attribute = await client.getProductAttribute(code);
      if (!attribute || attribute.attribute_code !== code) throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
      const optionCount = arrayCount(await client.getProductAttributeOptions(code));
      // Numeric identity/counts only: remote labels/messages can reflect sensitive data.
      log.info('magento.probe.attribute', { attributeId: safeInteger(attribute.attribute_id), options: optionCount });
    }
    if (options.sku !== undefined) {
      const product = await client.findProductBySku(options.sku);
      if (!product || product.sku !== options.sku || safeInteger(product.id) === null) {
        throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID');
      }
      log.info('magento.probe.product', { requestedSku: safeRequestedSku(options.sku, config),
        returnedSkuMatches: true, productId: product.id, attributeSetId: safeInteger(product.attribute_set_id),
        status: safeInteger(product.status) });
    }
    return 0;
  } catch (error) {
    const safe = new MagentoIntegrationError(error instanceof MagentoIntegrationError ? error.code : 'MAGENTO_PROBE_FAILED',
      error instanceof MagentoIntegrationError ? error.status : undefined);
    log.error('magento.probe.failed', { code: safe.code, message: safe.message, status: safe.status });
    return 1;
  }
}

if (require.main === module) {
  // Independent of application startup, PostgreSQL, migrations, OIDC, and export services.
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runProbe({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}

module.exports = { parseArguments, runProbe };
