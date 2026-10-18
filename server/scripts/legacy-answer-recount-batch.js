// Reviewed batch: UI recount filling an absent legacy answer, then UI stable_recount_exposure.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_BYTES = 1024 * 1024;
const HELP = 'node scripts/legacy-answer-recount-batch.js --mode preview|apply --input FILE.json --output NEW.jsonl '
  + '--expected-database NAME --actor-id ID [--plan-hash SHA256]\n'
  + 'Input: {"category","reason","items":[{"sku"}]} plus "answers":{question:value_id} and/or "weightFromAnswer":true. '
  + 'Preview writes nothing. Apply needs the plan hash of an identical fresh preview, runs the existing recount '
  + 'and stable recount exposure services per item sequentially and stops at the first error. Rerun with a new preview.';
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 422 }); };
const safeCode = e => e?.code === 'EEXIST' ? 'LEGACY_ANSWER_OUTPUT_EXISTS'
  : [e?.publicCode, e?.code].find(v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(v)) || 'LEGACY_ANSWER_FAILED';
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--mode': 'mode', '--input': 'input', '--output': 'output', '--expected-database': 'database',
    '--actor-id': 'actor', '--plan-hash': 'planHash' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('LEGACY_ANSWER_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply'].includes(out.mode) || !out.input || !out.output || !out.database
    || !/^[1-9][0-9]{0,15}$/.test(out.actor || '') || !Number.isSafeInteger(Number(out.actor))
    || (out.mode === 'apply') !== Object.hasOwn(out, 'planHash')
    || out.planHash !== undefined && !/^[a-f0-9]{64}$/.test(out.planHash)) fail('LEGACY_ANSWER_ARGUMENTS');
  return { ...out, actor: Number(out.actor) };
}
async function readInput(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('LEGACY_ANSWER_INPUT_LIMIT');
    try { return JSON.parse(await handle.readFile('utf8')); } catch { fail('LEGACY_ANSWER_INPUT_INVALID'); }
  } finally { await handle.close(); }
}
async function journal(file) {
  const output = await fs.open(file, 'wx', 0o600);
  const directory = await fs.open(path.dirname(path.resolve(file)), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  const append = async value => {
    const data = Buffer.from(JSON.stringify({ contract: 'legacy-answer-recount-batch-journal-v1', at: new Date().toISOString(), ...value }) + '\n');
    for (let offset = 0; offset < data.length;) {
      const { bytesWritten } = await output.write(data, offset, data.length - offset, null);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) fail('LEGACY_ANSWER_JOURNAL_WRITE_FAILED');
      offset += bytesWritten;
    }
    await output.sync();
  };
  return { append, close: () => output.close() };
}
function readOnlyPool(env) {
  const configuration = require('../src/config/env').loadConfig(env);
  return new (require('pg').Pool)({ ...configuration.databaseOptions, ssl: configuration.useSsl ? { rejectUnauthorized: false } : false,
    max: 2, connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs,
    query_timeout: configuration.pgQueryTimeoutMs, options: '-c default_transaction_read_only=on' });
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    if (String(init.method || 'GET').toUpperCase() !== 'GET' || init.body != null) fail('LEGACY_ANSWER_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, output;
  try {
    const options = argumentsFor(args); if (options.help) { print(HELP); return 0; }
    const service = require('../src/services/legacy-answer-recount-batch.service');
    const input = await readInput(options.input);
    service.validateInput(input);
    const config = dependencies.config || require('../src/config/env').magento;
    if (options.mode === 'apply' && !config?.configured) fail('MAGENTO_NOT_CONFIGURED');
    const databasePool = dependencies.pool || (owned = options.mode === 'apply' ? require('../src/db/pool') : readOnlyPool(env));
    if ((await databasePool.query('SELECT current_database() AS name')).rows[0]?.name !== options.database) fail('LEGACY_ANSWER_DATABASE_MISMATCH');
    output = await journal(options.output);
    const run = { databasePool, expectedDatabase: options.database, actorUserId: options.actor, config,
      recovery: dependencies.recovery || { fetchImpl: getOnly(globalThis.fetch) } };
    await output.append({ type: 'start', mode: options.mode, database: options.database, actorUserId: options.actor, input });
    if (options.mode === 'preview') {
      const plan = await service.preview(input, run);
      for (const item of plan.items) await output.append({ type: 'item', ...item });
      await output.append({ type: 'complete', mode: 'preview', planHash: plan.planHash, summary: plan.summary });
      for (const item of plan.items) print(JSON.stringify({ sku: item.sku, status: item.status, ...(item.code ? { code: item.code } : {}),
        internalSkuBefore: item.internalSkuBefore ?? item.internalSku ?? null, internalSkuAfter: item.internalSkuAfter ?? null,
        publicSku: item.publicSku ?? null, priceBeforeUah: item.priceBeforeUah ?? null, priceAfterUah: item.priceAfterUah ?? null }));
      print(JSON.stringify({ planHash: plan.planHash, summary: plan.summary, output: options.output }));
      return 0;
    }
    const result = await service.apply(input, { ...run, planHash: options.planHash, append: output.append });
    await output.append({ type: 'complete', mode: 'apply', planHash: result.planHash, items: result.items });
    print(JSON.stringify({ planHash: result.planHash, items: result.items, output: options.output, directRemoteWrites: 0 }));
    return 0;
  } catch (e) { printError(JSON.stringify({ ok: false, code: safeCode(e) })); return 1; }
  finally {
    if (output) await output.close().catch(() => {});
    if (owned) await owned.end().catch(() => {});
  }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  main().then(code => { process.exitCode = code; });
}
module.exports = { argumentsFor, getOnly, main };
