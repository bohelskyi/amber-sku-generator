const fs = require('node:fs/promises');
const path = require('node:path');
const e = require('../src/services/correction-request-batch-evidence');
const { createReceiptWriter } = require('./exposure-bulk-receipt');

const HELP = `npm run corrections:batch -- preflight --expected-database NAME --actor-user-id ID (--ids-file FILE | --all-active --limit N) --output NEW_PLAN.json
npm run corrections:batch -- select --plan PLAN.json --expected-hash HASH --ids-file SELECTED_IDS.json [--post-delivery-review-ids-file HELD_IDS.json] --output NEW_SELECTION.json
npm run corrections:batch -- apply --expected-database NAME --actor-user-id ID --plan PLAN.json --expected-hash HASH --selection SELECTION.json --expected-selection-hash HASH --output NEW_RECEIPT_DIRECTORY
ID files are JSON arrays of positive request IDs. Supply DATABASE_URL explicitly for preflight/apply. Resume with the same plan/selection and a new persistent receipt directory.`;

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...flags] = args;
  if (!['preflight','select','apply'].includes(action)) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--actor-user-id': 'actorUserId', '--ids-file': 'idsFile',
    '--limit': 'limit', '--output': 'output', '--plan': 'planPath', '--expected-hash': 'expectedHash',
    '--selection': 'selectionPath', '--expected-selection-hash': 'expectedSelectionHash',
    '--post-delivery-review-ids-file': 'heldIdsFile', '--all-active': 'allActive' };
  const allowed = { preflight: ['expectedDatabase','actorUserId','idsFile','limit','output','allActive'],
    select: ['planPath','expectedHash','idsFile','heldIdsFile','output'],
    apply: ['expectedDatabase','actorUserId','planPath','expectedHash','selectionPath','expectedSelectionHash','output'] };
  const out = { action };
  for (let i = 0; i < flags.length; i++) {
    const key = names[flags[i]];
    if (!key || !allowed[action].includes(key) || Object.hasOwn(out,key)) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
    if (key === 'allActive') { out[key] = true; continue; }
    const value = flags[++i];
    if (!value || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
    out[key] = value;
  }
  if (!out.output || (action !== 'select' && (!out.expectedDatabase || !/^[1-9]\d*$/.test(out.actorUserId || '')))
    || (action !== 'preflight' && (!out.planPath || !/^[a-f0-9]{64}$/.test(out.expectedHash || '')))
    || (action === 'apply' && (!out.selectionPath || !/^[a-f0-9]{64}$/.test(out.expectedSelectionHash || '')))
    || (action === 'select' && !out.idsFile)
    || (action === 'preflight' && (Boolean(out.idsFile) === Boolean(out.allActive) || (!out.allActive && out.limit)))) {
    throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
  }
  if (out.actorUserId) {
    out.actorUserId = Number(out.actorUserId);
    if (!Number.isSafeInteger(out.actorUserId)) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
  }
  if (out.allActive) {
    out.limit = Number(out.limit);
    if (!Number.isSafeInteger(out.limit) || out.limit <= 0 || out.limit > e.MAX_REQUESTS) throw e.error(422, 'CORRECTION_BATCH_ARGUMENTS');
  }
  return out;
}

function connectionTarget(url) {
  if (!url) throw e.error(422, 'CORRECTION_BATCH_DATABASE_URL_REQUIRED');
  let parsed;
  try { parsed = new URL(url); } catch { throw e.error(422, 'CORRECTION_BATCH_DATABASE_URL_REQUIRED'); }
  if (!['postgresql:','postgres:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) throw e.error(422, 'CORRECTION_BATCH_DATABASE_URL_REQUIRED');
  // Password, username and SSL secrets are never put into an artifact.
  return e.hash({ host: parsed.hostname, port: parsed.port || '5432', database: decodeURIComponent(parsed.pathname.slice(1)) });
}

async function readJson(file) {
  const stat = await fs.stat(file);
  if (stat.size > 64 * 1024 * 1024) throw e.error(422, 'CORRECTION_BATCH_ARTIFACT_TOO_LARGE');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeNew(file, value) {
  const encoded = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw e.error(422, 'CORRECTION_BATCH_ARTIFACT_TOO_LARGE');
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
}

// The deployed server image has no .git directory. Bind actual code/dependency
// files, with canonical line endings, rather than relying on a checkout label.
async function buildIdentity(root = path.resolve(__dirname, '..')) {
  const files = ['package.json','package-lock.json'];
  const scan = async relative => {
    for (const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
      const child=path.posix.join(relative,entry.name);
      if(entry.isDirectory()) await scan(child);
      else if(entry.isFile() && child.endsWith('.js')) files.push(child);
    }
  };
  await scan('src'); await scan('scripts');
  const contents=await Promise.all(files.sort().map(async file => ({file,
    hash:e.hash((await fs.readFile(path.join(root,file),'utf8')).replace(/\r\n?/g,'\n'))})));
  return e.hash(contents);
}

async function run(args = process.argv.slice(2), injected = {}) {
  let pool;
  const abort = new AbortController();
  const stop = () => abort.abort();
  try {
    const input = parseArguments(args);
    if (input.help) { console.log(HELP); return 0; }
    if (input.action === 'select') {
      const selection = e.select(await readJson(input.planPath), input.expectedHash,
        await readJson(input.idsFile), input.heldIdsFile ? await readJson(input.heldIdsFile) : []);
      await writeNew(input.output, selection);
      console.log(JSON.stringify({ output: input.output, selectionHash: selection.selectionHash, count: selection.requestIds.length })); return 0;
    }
    const connectionTargetHash = connectionTarget(process.env.DATABASE_URL);
    // Explicit URL checked before service/config imports can load any .env file.
    const { Pool } = require('pg');
    const config = require('../src/config/env');
    pool = injected.databasePool || new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: config.useSsl ? { rejectUnauthorized: false } : false, max: 2,
      connectionTimeoutMillis: config.pgConnectTimeoutMs, statement_timeout: config.pgStatementTimeoutMs,
      query_timeout: config.pgQueryTimeoutMs,
      ...(input.action === 'preflight' ? { options: '-c default_transaction_read_only=on' } : {}) });
    const service = injected.service || require('../src/services/correction-request-batch.service');
    const options = { ...input, connectionTargetHash, databasePool: pool, observeRate: injected.observeRate };
    options.buildId = await buildIdentity();
    if (input.action === 'preflight') {
      options.requestIds = input.idsFile ? await readJson(input.idsFile) : undefined;
      const plan = await service.preflight(options);
      await writeNew(input.output, plan);
      console.log(JSON.stringify({ output: input.output, planHash: plan.planHash, summary: plan.summary,
        entries: plan.entries.map(x => ({ requestId:x.requestId,requestType:x.requestType,article:x.publicArticle,
          classification:x.classification,reason:x.reason,reasons:x.reasons,postDeliveryReview:x.postDeliveryReviewRequired })) })); return 0;
    }
    const plan = await readJson(input.planPath), selection = await readJson(input.selectionPath);
    e.verifyPlan(plan, input.expectedHash); e.verifySelection(plan, selection, input.expectedSelectionHash);
    const checkpoint = await createReceiptWriter(input.output);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const report = await service.apply(plan, selection, { ...options, checkpoint, signal: abort.signal });
    console.log(JSON.stringify({ output: input.output, counts: report.counts, stoppedReason: report.stoppedReason }));
    return report.stoppedReason || report.counts.failed ? 1 : report.counts.conflicted || report.counts.pending ? 2 : 0;
  } catch (cause) {
    console.error(JSON.stringify({ code: /^CORRECTION_BATCH_|^ADMIN_PERMISSION_|^EXPORT_CUTOVER_|^LIFECYCLE_WRITER_/.test(cause.code || cause.publicCode || '')
      ? cause.code || cause.publicCode : 'CORRECTION_BATCH_COMMAND_FAILED' })); return 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (pool && !injected.databasePool) await pool.end();
    // Imported legacy services instantiate a pool; close it even though all batch
    // database work uses the explicitly bound pool above.
    if (pool && !injected.databasePool) await require('../src/db/pool').end();
  }
}
if (require.main === module) run().then(code => { process.exitCode = code; });
module.exports = { HELP, parseArguments, connectionTarget, readJson, writeNew, buildIdentity, run };
