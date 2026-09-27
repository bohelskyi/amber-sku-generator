const path = require('node:path');
const { parseMagentoConfig } = require('../src/config/magento');
const { auditBindingEvidence, assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { MagentoIntegrationError } = require('../src/services/magento/errors');
const { writeArtifact } = require('./magento-schema-audit');
const logger = require('../src/utils/logger');

const HELP = 'npm run magento:binding-evidence-audit -- [--mode compatibility] [--template-version selected|ID] [--output PATH]\n'
  + 'Read-only PostgreSQL evidence and bounded GET-only Magento sampling. Default template: system mapper. '
  + 'Writes a new .artifacts/magento/binding-evidence-audit-<UTC timestamp>.json '
  + '(compatibility-evidence-audit-<UTC timestamp>.json in compatibility mode); never overwrites.';
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 3 && args[0] === '--mode' && args[1] === 'compatibility' && args[2] === '--help') return { help: true };
  const result = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!['--output', '--template-version', '--mode'].includes(flag) || seen.has(flag) || typeof value !== 'string'
      || !value.trim() || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) {
      throw new MagentoIntegrationError('MAGENTO_BINDING_AUDIT_ARGUMENTS');
    }
    seen.add(flag);
    if (flag === '--output') result.output = path.resolve(value);
    else if (flag === '--mode') {
      if (value !== 'compatibility') throw new MagentoIntegrationError('MAGENTO_BINDING_AUDIT_ARGUMENTS');
      result.mode = value;
    }
    else {
      if (value !== 'selected' && !/^[1-9][0-9]{0,17}$/.test(value)) throw new MagentoIntegrationError('MAGENTO_BINDING_AUDIT_ARGUMENTS');
      result.templateVersionId = value;
    }
  }
  return result;
}
function createReadOnlyPool(env) {
  const configuration = require('../src/config/env').loadConfig(env);
  const { Pool } = require('pg');
  const pool = new Pool({ ...configuration.databaseOptions,
    ssl: configuration.useSsl ? { rejectUnauthorized: false } : false, max: 1,
    connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs,
    query_timeout: configuration.pgQueryTimeoutMs, options: '-c default_transaction_read_only=on' });
  pool.on('error', () => logger.error('magento.binding_evidence_audit.database_error', { code: 'DATABASE_CONNECTION_FAILED' }));
  return pool;
}
function databaseSecrets(env) {
  const values = [env.DATABASE_URL, env.PGPASSWORD, env.POSTGRES_PASSWORD].filter(Boolean);
  if (env.DATABASE_URL) {
    try { values.push(decodeURIComponent(new URL(env.DATABASE_URL).password)); } catch { /* Configuration validation owns errors. */ }
  }
  return values;
}
async function runBindingEvidenceAudit({ args = [], env = process.env, fetchImpl, databasePool,
  audit = auditBindingEvidence, log = logger, now = () => new Date().toISOString() } = {}) {
  let ownedPool;
  try {
    const options = parseArguments(args);
    if (options.help) { log.info('magento.binding_evidence_audit.help', { usage: HELP }); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw new MagentoIntegrationError('MAGENTO_NOT_CONFIGURED');
    const sensitiveValues = databaseSecrets(env);
    if (!databasePool) { ownedPool = createReadOnlyPool(env); databasePool = ownedPool; }
    const report = await audit(config, { databasePool, fetchImpl, templateVersionId: options.templateVersionId,
      mode: options.mode, now, sensitiveValues });
    const prefix = options.mode === 'compatibility' ? 'compatibility-evidence-audit' : 'binding-evidence-audit';
    const output = options.output || path.resolve(__dirname, '../../.artifacts/magento',
      `${prefix}-${now().replace(/[:.]/g, '-')}.json`);
    assertEvidenceSafe({ report, output }, config, sensitiveValues);
    await writeArtifact(output, report);
    log.info('magento.binding_evidence_audit.complete', { ...(options.mode ? { mode: options.mode } : {}), artifact: output, ...report.summary });
    return 0;
  } catch (cause) {
    const safe = new MagentoIntegrationError(cause instanceof MagentoIntegrationError ? cause.code : 'MAGENTO_BINDING_AUDIT_FAILED');
    log.error('magento.binding_evidence_audit.failed', { code: safe.code, message: safe.message,
      ...(cause instanceof MagentoIntegrationError ? cause.auditContext : {}) });
    return 1;
  } finally { if (ownedPool) await ownedPool.end().catch(() => {}); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runBindingEvidenceAudit({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
module.exports = { parseArguments, runBindingEvidenceAudit };
