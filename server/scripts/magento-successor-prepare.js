'use strict';
// Prepares a binding successor for a newly published template through the existing
// integration-successor service (the same code as Settings -> Magento), with an
// explicit representative product sample for one category.
// preview: GET-only Magento observation and read-only local evidence; prints what
//   carries, what needs review and blockers, plus the preview token.
// apply: repeats the fresh preparation, requires the same token and creates an
//   unpublished binding draft. Nothing is published, enqueued or written to Magento.
// Review the remaining decisions and run H3b publication in Settings -> Magento.
const path = require('node:path');
const { createRequire } = require('node:module');

const HELP = 'node magento-successor-prepare.js --mode preview|apply --expected-database NAME --actor-id ID '
  + '--source UUID --template-version UUID [--category SV] [--per-group 12] [--preview-token SHA256] [--server-root SERVER]';
const fail = code => { throw Object.assign(Error(code), { code }); };

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--expected-database': 'database', '--actor-id': 'actor', '--source': 'sourceId',
    '--template-version': 'templateVersionId', '--category': 'category', '--per-group': 'perGroup',
    '--preview-token': 'previewToken', '--server-root': 'serverRoot' }, out = { category: 'SV', perGroup: '12' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || seen.has(key) || typeof value !== 'string' || !value || value.startsWith('--')) fail('SUCCESSOR_ARGUMENTS');
    seen.add(key); out[key] = value;
  }
  const uuid = /^[0-9a-f-]{36}$/;
  if (!['preview', 'apply'].includes(out.mode) || !out.database || !/^[1-9][0-9]{0,17}$/.test(out.actor || '')
    || !uuid.test(out.sourceId || '') || !uuid.test(out.templateVersionId || '') || !/^[A-Z][A-Z0-9_]{0,31}$/.test(out.category)
    || !/^[1-9][0-9]?$/.test(out.perGroup) || (out.mode === 'apply') !== /^[a-f0-9]{64}$/.test(out.previewToken || '')) fail('SUCCESSOR_ARGUMENTS');
  out.actor = Number(out.actor); out.perGroup = Number(out.perGroup);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}

// Up to perGroup active products per first semantic answer group (e.g. SV souvenir type),
// so every route of the category is represented; at most 100 in total.
async function sampleProducts(db, category, perGroup) {
  const rows = (await db.query(`SELECT id FROM (SELECT p.id, ROW_NUMBER() OVER (PARTITION BY p.details->'answers'->>'souvenir'
      ORDER BY p.id) n FROM products p WHERE p.category=$1 AND p.status='active' AND p.exclude_from_export=0
      AND p.corrected_to_product_id IS NULL) s WHERE n<=$2 ORDER BY id LIMIT 100`, [category, perGroup])).rows;
  if (!rows.length) fail('SUCCESSOR_NO_PRODUCTS');
  return rows.map(row => Number(row.id));
}

function summarize(result) {
  const count = list => Array.isArray(list) ? list.length : list;
  return { previewToken: result.previewToken, sourceId: result.sourceId, templateVersionId: result.templateVersionId,
    products: result.productIds?.length, carried: result.carried, skippedCount: count(result.skipped),
    skipped: (result.skipped || []).slice(0, 40), blockers: (result.blockers || []).slice(0, 40) };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const local = createRequire(path.join(cli.serverRoot, 'package.json'));
    const successor = dependencies.successor || local('./src/services/magento/integration-successor');
    const config = dependencies.config || local('./src/config/magento').parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    if (!dependencies.pool) {
      const configuration = local('./src/config/env').loadConfig(env);
      pool = new (local('pg').Pool)({ ...configuration.databaseOptions, max: 4,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs });
    }
    const db = dependencies.pool || pool;
    if ((await db.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('SUCCESSOR_DATABASE_MISMATCH');
    const source = (await db.query('SELECT revision::text FROM magento_binding_revisions WHERE id=$1 AND state=$2',
      [cli.sourceId, 'published'])).rows[0];
    if (!source) fail('SUCCESSOR_SOURCE_NOT_PUBLISHED');
    const input = { sourceId: cli.sourceId, expectedSourceRevision: source.revision, templateVersionId: cli.templateVersionId,
      productIds: await sampleProducts(db, cli.category, cli.perGroup) };
    const options = { databasePool: db, mutationContext: { actorUserId: cli.actor } };
    if (cli.mode === 'preview') {
      print(JSON.stringify({ kind: 'successor_preview', ...summarize(await successor.prepare(config, input, options)) }));
      return 0;
    }
    const draft = await successor.apply(config, { ...input, previewToken: cli.previewToken }, options);
    const states = {};
    for (const decision of Object.values(draft.bindings || {}).flat()) states[decision.reviewState] = (states[decision.reviewState] || 0) + 1;
    print(JSON.stringify({ kind: 'successor_draft', draftId: draft.id, revision: draft.revision, state: draft.state, reviewStates: states,
      next: 'Settings -> Magento: open this draft, review decisions marked for review, then run the publication impact check and apply.' }));
    return 0;
  } catch (error) {
    printError(JSON.stringify({ ok: false, code: error.code || 'SUCCESSOR_FAILED', ...(error.details ? { details: error.details } : {}) }));
    return 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, sampleProducts, summarize, main };
