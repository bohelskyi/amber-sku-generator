'use strict';
// Imports values that the removed first-sync decision retain_remote left in
// Magento (state remote_retained, migration 080). Historical internal SKUs are
// opaque identifiers (catalog owner, 2026-10-14), so a legacy SV answer Amber
// lacks is filled missing-only through the reviewed retained-remote-import
// service. Sequential, one product at a time. Magento transport is GET-only.
// Preview never writes, but takes the service's ordinary Administrator/product
// locks, so both modes use the ordinary database pool.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const { schemaReadCache, parseSeconds } = require('./magento-schema-read-cache');
const HELP = 'node first-sync-retained-import.js --mode preview|apply --server-root /app --input input.json '
  + '--output NEW_FILE.jsonl --expected-database NAME --actor-id ID --installation-key KEY [--schema-cache-seconds 0-600]\n'
  + 'Sequential. Preview never writes. Apply imports only the remote_retained values the fresh preview proves '
  + 'importable; blocked fields are reported and left unchanged.';
const fail = code => { throw Object.assign(Error(code), { code }); };
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : 'RETAINED_IMPORT_FAILED';
const GLOBAL = /PUBLICATION|BINDING_CHANGED|BINDING_NOT_CURRENT|INSTALLATION|PERMISSION|ADMINISTRATOR|AUTHORI|ACTOR|DATABASE|NOT_CONFIGURED/;
const fieldKey = row => row.scope + '/' + row.target;

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--server-root': 'serverRoot', '--input': 'input', '--output': 'output',
    '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation', '--schema-cache-seconds': 'schemaCacheSeconds' };
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], value = args[i + 1];
    if (!name || Object.hasOwn(out, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('RETAINED_IMPORT_ARGUMENTS');
    out[name] = value;
  }
  if (!['preview', 'apply'].includes(out.mode) || !out.serverRoot || !out.input || !out.output || !out.database
    || !out.installation || !/^[1-9][0-9]*$/.test(out.actor || '') || parseSeconds(out.schemaCacheSeconds) === null)
    fail('RETAINED_IMPORT_ARGUMENTS');
  return { ...out, schemaCacheSeconds: parseSeconds(out.schemaCacheSeconds), actor: Number(out.actor) };
}
function parseInput(bytes) {
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { fail('RETAINED_IMPORT_INPUT_INVALID'); }
  const skus = Array.isArray(input?.items) ? input.items.map(item => item?.sku) : null;
  if (typeof input?.bindingRevisionId !== 'string' || !skus || !skus.length || skus.length > 2000
    || skus.some(sku => typeof sku !== 'string' || !sku || sku.trim() !== sku || sku.length > 256)
    || new Set(skus).size !== skus.length) fail('RETAINED_IMPORT_INPUT_INVALID');
  return { bindingRevisionId: input.bindingRevisionId, skus };
}
const summarize = fields => ({ fields: fields.filter(f => f.status === 'importable').map(fieldKey),
  ...(fields.some(f => f.status === 'already_imported') ? { alreadyImported: fields.filter(f => f.status === 'already_imported').map(fieldKey) } : {}),
  ...(fields.some(f => f.status === 'blocked') ? { blocked: fields.filter(f => f.status === 'blocked').map(f => ({ field: fieldKey(f), code: f.code })) } : {}) });

async function runItem(service, config, cli, sku, bindingRevisionId, run) {
  const preview = await service.review(config, { sku, bindingRevisionId }, run);
  if (preview.status === 'nothing_retained') return { sku, status: 'nothing_retained' };
  const summary = summarize(preview.fields);
  if (preview.status !== 'importable') return { sku, status: preview.status, ...summary };
  if (cli.mode === 'preview') return { sku, status: 'importable', ...summary };
  const result = await service.apply(config, { sku, bindingRevisionId, previewToken: preview.previewToken }, run);
  if (result.imported?.map(fieldKey).join() !== summary.fields.join()) fail('RETAINED_IMPORT_RECEIPT_UNCONFIRMED');
  return { sku, status: result.alreadyApplied ? 'already_applied' : 'imported', ...summary, fullRevision: result.fullRevision };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool, handle;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const local = createRequire(path.join(path.resolve(cli.serverRoot), 'package.json'));
    const service = dependencies.service || local('./src/services/magento/retained-remote-import');
    const stages = local('./scripts/sv-campaign-stages');
    const runtime = dependencies.runtime || stages.createRuntime(cli.serverRoot);
    const input = parseInput(await fs.readFile(cli.input));
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    runtime.c.installation(cli.installation);
    pool = dependencies.pool || runtime.createPool(env);
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('RETAINED_IMPORT_DATABASE_MISMATCH');
    const run = { databasePool: pool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: runtime.pool.databaseSecrets(env),
      fetchImpl: stages.getOnly(schemaReadCache(dependencies.fetchImpl || globalThis.fetch, cli.schemaCacheSeconds)),
      ...(dependencies.observeRate ? { observeRate: dependencies.observeRate } : {}) };
    handle = await fs.open(cli.output, 'wx', 0o600);
    const counts = {};
    for (const sku of input.skus) {
      let row;
      try { row = await runItem(service, config, cli, sku, input.bindingRevisionId, run); }
      catch (error) { row = { sku, status: 'review', code: safeCode(error) }; }
      counts[row.status] = (counts[row.status] || 0) + 1;
      const line = JSON.stringify(row);
      await handle.write(line + '\n'); await handle.sync(); print(line);
      if (row.code && GLOBAL.test(row.code)) { counts.stopped = row.code; break; }
    }
    const summary = JSON.stringify({ kind: 'summary', mode: cli.mode, total: input.skus.length, counts, magentoWrites: 0 });
    await handle.write(summary + '\n'); await handle.sync(); print(summary);
    return counts.stopped ? 1 : counts.review || counts.blocked ? 2 : 0;
  } catch (error) {
    printError(JSON.stringify({ code: safeCode(error) })); return 1;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (pool && !dependencies.pool) await pool.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, parseInput, summarize, runItem, main };
