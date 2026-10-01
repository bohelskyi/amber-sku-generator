const path = require('node:path');
const fs = require('node:fs/promises');
const { parseMagentoConfig } = require('../src/config/magento');
const { auditMagentoSchema } = require('../src/services/magento/schema-audit');
const { MagentoIntegrationError } = require('../src/services/magento/errors');
const logger = require('../src/utils/logger');

const HELP = 'npm run magento:schema-audit -- [--store-code CODE] [--output PATH]\n'
  + 'GET-only schema discovery. Writes a new JSON evidence file; never overwrites. '
  + 'Default: repository .artifacts/magento/schema-audit-<UTC timestamp>.json. No products or database access.';

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { storeCode: 'all' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!['--store-code', '--output'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) {
      throw new MagentoIntegrationError('MAGENTO_AUDIT_ARGUMENTS');
    }
    seen.add(flag);
    if (flag === '--store-code') {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value)) throw new MagentoIntegrationError('MAGENTO_AUDIT_ARGUMENTS');
      options.storeCode = value;
    } else options.output = path.resolve(value);
  }
  return options;
}

async function writeArtifact(output, report) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const handle = await fs.open(output, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close();
    await fs.unlink(output);
    throw error;
  }
  await handle.close();
}

async function runSchemaAudit({ args = [], env = process.env, fetchImpl, log = logger } = {}) {
  try {
    const options = parseArguments(args);
    if (options.help) { log.info('magento.schema_audit.help', { usage: HELP }); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw new MagentoIntegrationError('MAGENTO_NOT_CONFIGURED');
    const report = await auditMagentoSchema(config, { fetchImpl, storeCode: options.storeCode });
    const output = options.output || path.resolve(__dirname, '../../.artifacts/magento',
      `schema-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeArtifact(output, report);
    const diagnosticCounts = {};
    for (const { code } of report.diagnostics) diagnosticCounts[code] = (diagnosticCounts[code] || 0) + 1;
    log.info('magento.schema_audit.complete', { artifact: output,
      websites: report.storeTopology.websites.length, storeGroups: report.storeTopology.storeGroups.length,
      storeViews: report.storeTopology.storeViews.length, attributeSets: report.attributeSets.length,
      attributes: report.attributes.length, mapperTargets: report.mapperAttributes.length,
      exactSetMatches: report.mapperAttributeSetComparison.filter((s) => s.status === 'exact').length,
      diagnosticCounts });
    return 0;
  } catch (error) {
    const safe = new MagentoIntegrationError(error instanceof MagentoIntegrationError ? error.code : 'MAGENTO_AUDIT_FAILED',
      error instanceof MagentoIntegrationError ? error.status : undefined);
    log.error('magento.schema_audit.failed', { code: safe.code, message: safe.message, status: safe.status,
      ...(error instanceof MagentoIntegrationError ? error.auditContext : {}) });
    return 1;
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runSchemaAudit({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}

module.exports = { parseArguments, runSchemaAudit, writeArtifact };
