const path = require('node:path');
const { parseMagentoConfig } = require('../src/config/magento');
const { previewProduct } = require('../src/services/magento/sync-preview');
const { selection } = require('../src/services/magento/sync-preview-db');
const { identity, code, error } = require('../src/services/magento/binding-contract');
const { assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { writeArtifact } = require('./magento-schema-audit');
const { createReadOnlyPool, databaseSecrets } = require('./magento-binding-evidence-audit');

const HELP = 'npm run magento:sync-preview -- (--sku "AMBER_SKU" | --product-id 1234)\n'
  + '  [--binding-revision UUID] [--template-version UUID] [--store-code CODE]\n'
  + 'GET-only Magento dry run; read-only Amber snapshot. Default: system mapper, all scope.\n'
  + 'Writes a new ignored .artifacts/magento/sync-preview-<SKU-safe>-<UTC>.json. No apply mode.';
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = {}; const seen = new Set();
  const fields = { '--sku': 'sku', '--product-id': 'productId', '--binding-revision': 'bindingRevisionId',
    '--template-version': 'templateVersionId', '--store-code': 'storeCode' };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!Object.hasOwn(fields, flag) || seen.has(flag) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw error(422, 'MAGENTO_PREVIEW_ARGUMENTS', 'Invalid preview arguments');
    }
    seen.add(flag);
    if (flag === '--product-id' && !/^[1-9][0-9]*$/.test(value)) throw error(422, 'MAGENTO_PREVIEW_ARGUMENTS', 'Invalid product ID');
    if (['--binding-revision', '--template-version'].includes(flag)) identity(value);
    if (flag === '--store-code' && !code(value)) throw error(422, 'MAGENTO_PREVIEW_ARGUMENTS', 'Invalid scope');
    result[fields[flag]] = flag === '--product-id' ? Number(value) : value;
  }
  selection(result);
  return result;
}
function artifactPath(report) {
  const sku = report.amberProduct.sku.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return path.resolve(__dirname, '../../.artifacts/magento', `sync-preview-${sku}-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
}
function summary(report, output) {
  const options = report.attributes.filter((a) => a.magentoOptionId !== null);
  const preserved = report.fieldOwnership.filter((f) => f.action === 'preserve').map((f) => f.target);
  const changes = report.diff.filter((d) => ['would_update', 'would_add'].includes(d.action)).map((d) => d.target);
  const set = report.attributeSet;
  return [`${report.amberProduct.sku} (Amber #${report.amberProduct.id}) — ${report.mode.toUpperCase()}`,
    `Sync eligibility: ${report.syncEligibility.eligible ? 'ELIGIBLE' : 'BLOCKED'} — ${report.syncEligibility.reason}`,
    `Attribute set: ${set.selected ? `${set.selected.id} / ${set.selected.name}` : 'unresolved'} [${set.status}]`,
    `Options: ${options.length} resolved (${options.filter((o) => o.authority === 'authoritative').length} authoritative)`,
    `Categories: ${report.categories.requested.filter((r) => r.categoryId).length}/${report.categories.requested.length} resolved; ${report.categories.preservedMagentoOnly.length} Magento-only preserved`,
    `Preserved: ${preserved.join(', ') || 'none'}`, `Would change: ${changes.join(', ') || 'none'}`,
    `Inventory: ${report.transport.inventory.action}; ${report.transport.inventory.current?.sourceItems.map((s) => `${s.sourceCode}: qty=${s.qty}, in_stock=${s.isInStock}`).join('; ') || 'no source-item evidence'}`,
    `Websites: ${report.transport.websites.action}; add=${report.transport.websites.wouldAdd.join(',') || 'none'}; preserve additional=${report.transport.websites.preservedAdditionalIds.join(',') || 'none'}`,
    `Store view ${report.transport.storeViews.storeCode || 'unresolved'} (${report.transport.storeViews.storeId ?? 'unresolved'}): ${report.transport.storeViews.diff.filter((d) => ['would_update', 'would_add'].includes(d.action)).map((d) => `${d.target}: ${JSON.stringify(d.current)} -> ${JSON.stringify(d.candidate)}`).join('; ') || 'no field changes'}; empty/unproduced fields preserved`,
    `Warnings: ${report.warnings.length}; blockers: ${report.blockers.length}; SENDABLE ${report.sendable ? 'YES' : 'NO'}`,
    ...Object.entries(report.sendability.operations).map(([operation, result]) => `${operation}: SENDABLE ${result.sendable ? 'YES' : 'NO'} (${result.blockers.length} blockers)`),
    ...report.blockers.map((b) => `  BLOCKER [${b.operation}] ${b.code}${b.target ? `: ${b.target}` : b.path ? `: ${b.path}` : b.field ? `: ${b.field}` : ''}${b.reason ? `: ${b.reason}` : ''}`),
    ...report.categories.requested.filter((r) => r.createAction).map((r) => `  Preview explicit category create: ${r.createAction.command}`),
    `Artifact: ${output}`, 'Magento writes: NONE'].join('\n');
}
async function runSyncPreview({ args = [], env = process.env, databasePool, fetchImpl,
  preview = previewProduct, print = (text) => console.log(text), write = writeArtifact } = {}) {
  let ownedPool;
  try {
    const options = parseArguments(args);
    if (options.help) { print(HELP); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw error(422, 'MAGENTO_NOT_CONFIGURED', 'Magento is not configured');
    const sensitiveValues = databaseSecrets(env);
    if (!databasePool) { ownedPool = createReadOnlyPool(env); databasePool = ownedPool; }
    const report = await preview(config, { databasePool, fetchImpl, sensitiveValues, ...options });
    const output = artifactPath(report);
    assertEvidenceSafe({ report, output }, config, sensitiveValues);
    await write(output, report);
    print(summary(report, output));
    // A completed, non-sendable dry run is a useful successful report.
    return 0;
  } catch (cause) {
    const safeCode = typeof cause.code === 'string' && /^(?:MAGENTO_|TEMPLATE_)[A-Z0-9_]+$/.test(cause.code)
      ? cause.code : cause.code === 'EEXIST' ? 'MAGENTO_PREVIEW_ARTIFACT_EXISTS' : 'MAGENTO_PREVIEW_FAILED';
    print(`Preview failed: ${safeCode}. No Magento write was attempted.`);
    return 1;
  } finally { if (ownedPool) await ownedPool.end().catch(() => {}); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runSyncPreview({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
module.exports = { parseArguments, artifactPath, summary, runSyncPreview };
