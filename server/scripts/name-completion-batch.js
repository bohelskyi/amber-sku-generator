'use strict';
// Sequential batch over the existing "complete names from Magento" action
// (name-resolution intent=complete, choice=magento). Each product keeps the
// canonical preview, locked fresh preview, stale-token, unresolved-dispatch,
// identity and permission checks. Magento is read with GET only. A committed
// completion makes the ordinary automatic request pending; delivery and ACK stay
// with the existing worker and are reported by --mode status.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const MAX_INPUT = 8 * 1024 * 1024, MAX_ITEMS = 2000;
const CONTRACT = 'name-completion-batch-v1';
const HELP = 'node name-completion-batch.js --mode preview|apply|resume|status --output DIRECTORY '
  + '--expected-database NAME --actor-id ID [--server-root SERVER] [--input SKUS.json|DIAGNOSTIC.jsonl]\n'
  + 'preview/apply need --input and a new --output; resume/status reuse the apply --output directory.\n'
  + 'Input: {"items":[{"sku":"..."}]} or sv-name-shape-diagnostic JSONL (rows with completionDecision=completion_review).\n'
  + 'Only products whose Amber UA/EN name pair is missing accept the verified Magento pair. No Magento writes.';
const fail = (code, extra = {}) => { throw Object.assign(Error(code), { code, ...extra }); };
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(error.code)
  ? error.code : 'NAME_COMPLETION_FAILED';
// Authority/configuration failures stop the whole run; product-level refusals are recorded and the tail continues.
const globalFailure = code => /PERMISSION|ACTOR|ADMIN|AUTHORI|NOT_CONFIGURED|BINDING_REQUIRED|NAME_STORE_UNAVAILABLE|CUTOVER|DATABASE/.test(code);
const skuPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--input': 'input', '--output': 'output', '--server-root': 'serverRoot',
    '--expected-database': 'database', '--actor-id': 'actor' }, out = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = flags[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')
      || /[\u0000-\u001f\u007f]/.test(value)) fail('NAME_COMPLETION_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply', 'resume', 'status'].includes(out.mode) || !out.output || !out.database
    || !/^[1-9][0-9]{0,17}$/.test(out.actor || '')) fail('NAME_COMPLETION_ARGUMENTS');
  if (['preview', 'apply'].includes(out.mode) !== Boolean(out.input)) fail('NAME_COMPLETION_ARGUMENTS');
  out.actor = Number(out.actor);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  out.output = path.resolve(out.output);
  if (out.input) out.input = path.resolve(out.input);
  return out;
}

async function readLimited(file, limit = MAX_INPUT) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('NAME_COMPLETION_FILE_LIMIT');
    return await handle.readFile();
  } finally { await handle.close(); }
}
function parseInput(bytes, file) {
  const text = bytes.toString('utf8');
  let skus;
  if (file.endsWith('.jsonl')) {
    // Diagnostic output: keep only rows where the canonical decision allows completion.
    skus = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      .filter(row => row.kind !== 'summary' && row.completionDecision === 'completion_review').map(row => row.sku);
  } else {
    const input = JSON.parse(text);
    if (!input || !Array.isArray(input.items)) fail('NAME_COMPLETION_INPUT_INVALID');
    skus = input.items.map(item => item?.sku);
  }
  if (!skus.length || skus.length > MAX_ITEMS || skus.some(sku => typeof sku !== 'string' || !skuPattern.test(sku))
    || new Set(skus).size !== skus.length) fail('NAME_COMPLETION_INPUT_INVALID');
  return skus;
}

function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  return { names: local('./src/services/magento/name-resolution.service'),
    policy: local('./src/services/export-templates/effective-product-names'),
    access: local('./src/services/access-admin-transaction'),
    magentoConfig: local('./src/config/magento'), env: local('./src/config/env'), pg: local('pg') };
}
function createPool(runtime, env, { readOnly }) {
  const configuration = runtime.env.loadConfig(env);
  return new runtime.pg.Pool({ ...configuration.databaseOptions,
    ssl: configuration.useSsl ? { rejectUnauthorized: false } : false, max: 4,
    connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs,
    query_timeout: configuration.pgQueryTimeoutMs, ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}) });
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null) fail('NAME_COMPLETION_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}

async function resolveProduct(db, sku) {
  const rows = (await db.query(`SELECT p.id FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE i.public_sku=$1 AND p.status='active' AND p.corrected_to_product_id IS NULL ORDER BY p.id`, [sku])).rows;
  if (rows.length !== 1) fail(rows.length ? 'NAME_COMPLETION_PRODUCT_AMBIGUOUS' : 'NAME_COMPLETION_PRODUCT_NOT_CURRENT');
  return Number(rows[0].id);
}
async function assertAuthority(runtime, db, actorUserId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await runtime.access.assertActorStillAuthorized(client, actorUserId, 'exports.create',
      (status, code) => Object.assign(Error(code), { code, statusCode: status }), { readOnly: true });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
// Read-only check whether an intent recorded before an interruption actually committed.
async function committedCompletion(runtime, db, prepared) {
  const product = (await db.query('SELECT magento_name_override FROM products WHERE id=$1', [prepared.productId])).rows[0];
  const values = product?.magento_name_override?.values;
  if (!runtime.policy.validPair(values) || values.all !== prepared.magento.all || values.en !== prepared.magento.en) return null;
  const audit = (await db.query(`SELECT id FROM audit_events WHERE event_key='product.magento_name_external_accepted'
    AND subject_type='product' AND subject_id=$1 AND occurred_at>=$2::timestamptz ORDER BY id DESC LIMIT 1`,
  [String(prepared.productId), prepared.at])).rows[0];
  return audit ? { auditEventId: String(audit.id) } : null;
}

async function openJournal(directory, mode) {
  const file = path.join(directory, 'journal.jsonl'), lock = path.join(directory, 'run.lock');
  if (mode === 'apply') await fs.mkdir(directory, { mode: 0o700 });
  // A leftover lock means a writer is running or crashed; it is never stolen.
  const lockHandle = await fs.open(lock, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') fail('NAME_COMPLETION_RUN_LOCKED'); throw error;
  });
  await lockHandle.close();
  const records = mode === 'resume' ? await readJournal(directory) : [];
  const handle = await fs.open(file, mode === 'apply' ? 'wx' : 'a', 0o600);
  let seq = records.length;
  return { records, async append(record) {
    await handle.write(JSON.stringify({ seq: seq++, at: new Date().toISOString(), ...record }) + '\n');
    await handle.sync();
  }, async close() { await handle.close(); await fs.unlink(lock).catch(() => {}); } };
}
async function readJournal(directory) {
  const bytes = await readLimited(path.join(directory, 'journal.jsonl'), 64 * 1024 * 1024);
  if (bytes.length && bytes.at(-1) !== 10) fail('NAME_COMPLETION_JOURNAL_INCOMPLETE');
  const records = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records[0]?.type !== 'start' || records.some((record, index) => record.seq !== index)) fail('NAME_COMPLETION_JOURNAL_INVALID');
  return records;
}

function summarize(results) {
  const counts = {};
  for (const row of results) counts[row.status + (row.code ? ':' + row.code : '')] = (counts[row.status + (row.code ? ':' + row.code : '')] || 0) + 1;
  return counts;
}

async function processItem(runtime, context, sku, prior) {
  const { db, config, actorUserId, fetchImpl, journal, apply } = context;
  if (prior.receipt) return { sku, status: 'completed', resumed: true };
  if (prior.prepared) {
    const committed = await committedCompletion(runtime, db, prior.prepared);
    if (committed) {
      await journal.append({ type: 'receipt', sku, productId: prior.prepared.productId, recovered: true, ...committed });
      return { sku, status: 'completed', recovered: true };
    }
    // Local-only transaction: no commit evidence means nothing was saved. A fresh canonical preview decides again.
  }
  const productId = await resolveProduct(db, sku);
  const payload = { productId, choice: 'magento', intent: 'complete' };
  const options = { databasePool: db, config, fetchImpl, mutationContext: { actorUserId } };
  const preview = await runtime.names.preview(payload, options);
  const names = { amber: preview.amber, magento: preview.magento };
  if (!apply) return { sku, status: 'available', productId, ...names };
  await journal.append({ type: 'prepared', sku, productId, previewToken: preview.previewToken, magento: preview.magento });
  const result = await runtime.names.apply({ ...payload, previewToken: preview.previewToken }, options);
  if (result?.productId !== productId || result.choice !== 'magento' || result.state !== 'pending') fail('NAME_COMPLETION_RECEIPT_UNCONFIRMED');
  await journal.append({ type: 'receipt', sku, productId, state: result.state });
  return { sku, status: 'completed', productId };
}

async function deliveryStatus(db, receipts) {
  const rows = [];
  for (const receipt of receipts) {
    const row = (await db.query(`SELECT r.state,r.desired_generation::text AS desired,r.synced_generation::text AS synced,
      r.reason_code,r.diagnostics FROM products p JOIN magento_product_sync_requests r
      ON r.public_product_identity_id=p.public_product_identity_id WHERE p.id=$1`, [receipt.productId])).rows[0];
    const delivered = row && row.state === 'synced' && BigInt(row.synced) >= BigInt(row.desired);
    rows.push({ sku: receipt.sku, state: row?.state || 'missing', delivered: Boolean(delivered),
      ...(row?.reason_code ? { reason: row.reason_code } : {}),
      ...(row?.state === 'needs_attention' ? { diagnostics: (row.diagnostics || []).map(item => item.code).slice(0, 10) } : {}) });
  }
  return rows;
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool, journal, interrupted = false;
  const stop = () => { interrupted = true; };
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    const config = dependencies.config || runtime.magentoConfig.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const readOnly = cli.mode === 'preview' || cli.mode === 'status';
    pool = dependencies.pool || createPool(runtime, env, { readOnly });
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('NAME_COMPLETION_DATABASE_MISMATCH');
    if (cli.mode === 'status') {
      const records = await readJournal(cli.output);
      const receipts = records.filter(record => record.type === 'receipt');
      const rows = await deliveryStatus(pool, receipts);
      for (const row of rows) print(JSON.stringify(row));
      const states = {};
      for (const row of rows) { const key = row.delivered ? 'delivered' : row.state; states[key] = (states[key] || 0) + 1; }
      print(JSON.stringify({ kind: 'status', completedNames: receipts.length, delivery: states }));
      return rows.every(row => row.delivered) ? 0 : 2;
    }
    await assertAuthority(runtime, pool, cli.actor);
    const fetchImpl = getOnly(dependencies.fetchImpl || globalThis.fetch);
    let skus;
    if (cli.mode === 'resume') {
      journal = await openJournal(cli.output, 'resume');
      const start = journal.records[0];
      if (start.database !== cli.database || start.actorUserId !== cli.actor) fail('NAME_COMPLETION_RESUME_MISMATCH');
      skus = start.skus;
    } else {
      skus = parseInput(await readLimited(cli.input), cli.input);
      if (cli.mode === 'apply') {
        journal = await openJournal(cli.output, 'apply');
        await journal.append({ type: 'start', contract: CONTRACT, database: cli.database, actorUserId: cli.actor, skus });
      } else {
        await fs.mkdir(cli.output, { mode: 0o700 });
      }
    }
    const prior = new Map(skus.map(sku => [sku, {}]));
    for (const record of journal?.records || []) {
      if (record.type === 'prepared') prior.get(record.sku).prepared = record;
      if (record.type === 'receipt') prior.get(record.sku).receipt = record;
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const context = { db: pool, config, actorUserId: cli.actor, fetchImpl, journal, apply: cli.mode !== 'preview' };
    const results = [], busy = [];
    const run = async (sku, retry) => {
      let row;
      try { row = await processItem(runtime, context, sku, prior.get(sku)); }
      catch (error) {
        const code = safeCode(error);
        if (globalFailure(code)) throw error;
        if (code === 'MAGENTO_SYNC_BUSY' && !retry) { busy.push(sku); return; }
        row = { sku, status: 'review', code };
        if (journal) await journal.append({ type: 'review', sku, code });
      }
      results.push(row);
      print(JSON.stringify({ checked: results.length, total: skus.length, sku, status: row.status, ...(row.code ? { code: row.code } : {}) }));
    };
    for (const sku of skus) { if (interrupted) fail('NAME_COMPLETION_INTERRUPTED'); await run(sku, false); }
    // The worker may briefly hold the product lane; one later pass retries only those products.
    for (const sku of busy) { if (interrupted) fail('NAME_COMPLETION_INTERRUPTED'); await run(sku, true); }
    if (cli.mode === 'preview') await fs.writeFile(path.join(cli.output, 'preview.jsonl'),
      results.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const summary = { kind: 'summary', mode: cli.mode, total: skus.length, counts: summarize(results),
      magentoWrites: 0, deliveryConfirmed: false };
    if (journal) await journal.append({ type: 'summary', ...summary });
    print(JSON.stringify(summary));
    return results.every(row => row.status !== 'review') ? 0 : 2;
  } catch (error) {
    printError(JSON.stringify({ ok: false, code: safeCode(error) }));
    return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (journal) await journal.close().catch(() => {});
    if (pool && !dependencies.pool) await pool.end().catch(() => {});
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, parseInput, processItem, committedCompletion, deliveryStatus, main, HELP };
