'use strict';
// Temporary legacy SV first-sync decision (approved 2026-10-14 for the mass first
// sync): where Amber has no characteristic answer, Magento has one and the
// published template emits nothing, record `retain_remote`. Neither Amber nor
// Magento changes. Later import of these values belongs to removing legacy SKU
// dependencies. Magento transport is GET-only. Preview never calls apply; the
// canonical review takes its normal locks, so it needs an ordinary pool.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const { schemaReadCache, parseSeconds } = require('./magento-schema-read-cache');
const HELP = 'node first-sync-retain-remote.js --mode preview|apply --server-root /app --input input.json '
  + '--output NEW_FILE.jsonl --expected-database NAME --actor-id ID --installation-key KEY [--allow-imports] [--schema-cache-seconds 0-600]\n'
  + 'Sequential. Preview never writes. Apply records only retain_remote choices through the canonical first-sync '
  + 'service; products whose fresh plan also contains other Magento imports are skipped unless --allow-imports.';
const fail = code => { throw Object.assign(Error(code), { code }); };
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'RETAIN_REMOTE_FAILED';
const key = row => row.scope + '/' + row.target;
const GLOBAL = /PUBLICATION|BINDING_CHANGED|INSTALLATION|PERMISSION|ADMINISTRATOR|AUTHORI|ACTOR|DATABASE|NOT_CONFIGURED/;

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--server-root': 'serverRoot', '--input': 'input', '--output': 'output',
    '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation', '--schema-cache-seconds': 'schemaCacheSeconds' };
  const out = { allowImports: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-imports' && !out.allowImportsSeen) { out.allowImports = true; out.allowImportsSeen = true; continue; }
    const name = names[args[i]], value = args[i + 1];
    if (!name || Object.hasOwn(out, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('RETAIN_REMOTE_ARGUMENTS');
    out[name] = value; i++;
  }
  delete out.allowImportsSeen;
  if (!['preview', 'apply'].includes(out.mode) || !out.serverRoot || !out.input || !out.output || !out.database
    || !out.installation || !/^[1-9][0-9]*$/.test(out.actor || '') || out.allowImports && out.mode !== 'apply')
    fail('RETAIN_REMOTE_ARGUMENTS');
  if (parseSeconds(out.schemaCacheSeconds) === null) fail('RETAIN_REMOTE_ARGUMENTS');
  return { ...out, schemaCacheSeconds: parseSeconds(out.schemaCacheSeconds), actor: Number(out.actor) };
}
function parseInput(bytes) {
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { fail('RETAIN_REMOTE_INPUT_INVALID'); }
  const skus = Array.isArray(input?.items) ? input.items.map(item => item?.sku) : null;
  if (typeof input?.bindingRevisionId !== 'string' || !skus || !skus.length || skus.length > 2000
    || skus.some(sku => typeof sku !== 'string' || !sku || sku.trim() !== sku || sku.length > 256)
    || new Set(skus).size !== skus.length) fail('RETAIN_REMOTE_INPUT_INVALID');
  return { bindingRevisionId: input.bindingRevisionId, skus };
}
// Pure: which fresh rows may be retained, and which other Magento imports the
// canonical plan would also commit for this product.
function planFor(inspection) {
  const fields = inspection.fields || [];
  const choices = fields.filter(row => row.canRetainRemote === true && row.received !== true)
    .map(row => ({ target: row.target, scope: row.scope, choice: 'retain_remote' }));
  const imports = fields.filter(row => row.received !== true && row.status === 'imported'
    && !choices.some(choice => key(choice) === key(row))).map(key);
  return { choices, imports };
}
// A name equal to Magento is receipted as name_received without changing Amber;
// only a row whose fresh status is an import (or an accepted remote value) imports.
const isImport = row => row.status === 'imported' || row.record?.state === 'imported';
function validatePrepared(prepared, choices, allowImports) {
  const selected = new Set(choices.map(key));
  for (const row of prepared?.rows || []) {
    if (row.received) continue;
    if (selected.has(key(row))) {
      if (row.record.state !== 'remote_retained' || row.record.source?.decision !== 'retain_remote' || row.record.after !== null)
        fail('RETAIN_REMOTE_TRANSITION_CHANGED');
    } else if (isImport(row) && !allowImports) fail('RETAIN_REMOTE_OTHER_IMPORTS_PRESENT');
  }
  if (choices.some(choice => !(prepared?.rows || []).some(row => key(row) === key(choice)))) fail('RETAIN_REMOTE_TRANSITION_CHANGED');
}

async function runItem(runtime, config, cli, sku, bindingRevisionId, run) {
  const inspection = await runtime.first.review(config, { sku, bindingRevisionId }, run);
  if (inspection.mode !== 'first') return { sku, status: 'skipped', mode: inspection.mode };
  const { choices, imports } = planFor(inspection);
  const fields = choices.map(key);
  if (!choices.length) return { sku, status: 'nothing_to_retain', imports };
  if (cli.mode === 'preview') return { sku, status: 'retainable', fields, imports };
  if (imports.length && !cli.allowImports) return { sku, status: 'review', code: 'RETAIN_REMOTE_OTHER_IMPORTS_PRESENT', fields, imports };
  const command = { sku, bindingRevisionId, previewToken: inspection.previewToken, choices };
  const result = await runtime.first.applyWithPreparedValidation(config, command, { ...run,
    validateFirstSyncDecision: async (fresh, _report, freshChoices) => {
      if (fresh.previewToken !== inspection.previewToken || runtime.c.hash(freshChoices) !== runtime.c.hash(runtime.first.decisions({ choices })))
        fail('RETAIN_REMOTE_PREVIEW_CHANGED');
    },
    validatePreparedFirstSyncDecision: prepared => validatePrepared(prepared, choices, cli.allowImports) });
  const states = (result.receipt?.fields || []).map(row => row.state);
  if (states.length !== choices.length || states.some(state => state !== 'remote_retained')) fail('RETAIN_REMOTE_RECEIPT_UNCONFIRMED');
  return { sku, status: result.receipt.alreadyApplied ? 'already_retained' : 'retained', fields, imports,
    sessionId: result.receipt.sessionId, revision: result.receipt.revision, complete: result.complete === true };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool, handle;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const local = createRequire(path.join(path.resolve(cli.serverRoot), 'package.json'));
    const runtime = dependencies.runtime || local('./scripts/sv-campaign-stages').createRuntime(cli.serverRoot);
    const getOnly = dependencies.getOnly || local('./scripts/sv-campaign-stages').getOnly;
    const input = parseInput(await fs.readFile(cli.input));
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    runtime.c.installation(cli.installation);
    // first-sync review locks the Administrator/product rows (SELECT ... FOR UPDATE),
    // which a read-only transaction refuses (25006). Review records nothing.
    pool = dependencies.pool || runtime.createPool(env);
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('RETAIN_REMOTE_DATABASE_MISMATCH');
    const run = { databasePool: pool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: runtime.pool.databaseSecrets(env), fetchImpl: getOnly(schemaReadCache(dependencies.fetchImpl || globalThis.fetch, cli.schemaCacheSeconds)) };
    handle = await fs.open(cli.output, 'wx', 0o600);
    const counts = {};
    for (const sku of input.skus) {
      let row;
      try { row = await runItem(runtime, config, cli, sku, input.bindingRevisionId, run); }
      catch (error) { row = { sku, status: 'review', code: safeCode(error) }; }
      counts[row.status] = (counts[row.status] || 0) + 1;
      const line = JSON.stringify(row);
      await handle.write(line + '\n'); await handle.sync(); print(line);
      if (row.code && GLOBAL.test(row.code)) { counts.stopped = row.code; break; }
    }
    const summary = JSON.stringify({ kind: 'summary', mode: cli.mode, total: input.skus.length, counts, magentoWrites: 0 });
    await handle.write(summary + '\n'); await handle.sync(); print(summary);
    return counts.stopped ? 1 : counts.review ? 2 : 0;
  } catch (error) {
    printError(JSON.stringify({ code: safeCode(error) })); return 1;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (pool && !dependencies.pool) await pool.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, parseInput, planFor, validatePrepared, runItem, main };
