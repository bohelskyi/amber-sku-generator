'use strict';
// Runs the existing H3b publication review and apply (binding-publication, the same code
// as the Settings -> Magento publication step) for one reviewed binding draft.
// preview: GET-only Magento reads and a read-only local scan; prints affected/lost
//   coverage, representative previews, blockers and the preview token.
// apply: requires the same token, repeats the fresh review, and atomically publishes the
//   binding with its exact handoff. The ordinary worker then delivers the handed-off
//   products. Lost coverage additionally requires --ack-coverage-loss with a reason.
const path = require('node:path');
const { createRequire } = require('node:module');

const HELP = 'node magento-publication.js --mode preview|apply --expected-database NAME --actor-id ID --draft UUID '
  + '[--preview-token SHA256] [--ack-coverage-loss REASON] [--server-root SERVER]';
const fail = code => { throw Object.assign(Error(code), { code }); };

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--expected-database': 'database', '--actor-id': 'actor', '--draft': 'draftId',
    '--preview-token': 'previewToken', '--ack-coverage-loss': 'coverageReason', '--server-root': 'serverRoot' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) fail('PUBLICATION_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply'].includes(out.mode) || !out.database || !/^[1-9][0-9]{0,17}$/.test(out.actor || '')
    || !/^[0-9a-f-]{36}$/.test(out.draftId || '') || (out.mode === 'apply') !== /^[a-f0-9]{64}$/.test(out.previewToken || '')
    || (out.coverageReason !== undefined && (out.mode !== 'apply' || out.coverageReason.trim().length < 3))) fail('PUBLICATION_ARGUMENTS');
  out.actor = Number(out.actor);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}

function summarize(result) {
  const byRoute = {};
  for (const item of result.affected || []) byRoute[item.routeKey] = (byRoute[item.routeKey] || 0) + 1;
  return { previewToken: result.previewToken, bindingRevisionId: result.bindingRevisionId, expectedRevision: result.expectedRevision,
    expectedCurrentId: result.expectedCurrentId, totalProducts: result.totalProducts, affected: (result.affected || []).length,
    affectedByRoute: byRoute, affectedSample: (result.affected || []).slice(0, 20).map(a => a.article ?? a.productId),
    lostRoutes: result.lostRoutes, lostProducts: (result.lostProducts || []).length, preservedNames: (result.preservedNames || []).length,
    checked: (result.checked || []).map(p => ({ kind: p.kind, productId: p.productId ?? null, routeKey: p.routeKey ?? null,
      sendable: p.sendable === true, blockers: (p.blockers || []).map(b => b.code).slice(0, 10) })),
    blockers: result.blockers };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const local = createRequire(path.join(cli.serverRoot, 'package.json'));
    const publication = dependencies.publication || local('./src/services/magento/binding-publication');
    const config = dependencies.config || local('./src/config/magento').parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    if (!dependencies.pool) {
      const configuration = local('./src/config/env').loadConfig(env);
      pool = new (local('pg').Pool)({ ...configuration.databaseOptions, max: 4,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs });
    }
    const db = dependencies.pool || pool;
    if ((await db.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('PUBLICATION_DATABASE_MISMATCH');
    const draft = (await db.query('SELECT revision::text,installation_key FROM magento_binding_revisions WHERE id=$1 AND state=$2',
      [cli.draftId, 'draft'])).rows[0];
    if (!draft) fail('PUBLICATION_DRAFT_REQUIRED');
    const current = (await db.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1 AND state='published'
      ORDER BY version_number DESC LIMIT 1`, [draft.installation_key])).rows[0];
    const request = { bindingRevisionId: cli.draftId, expectedRevision: draft.revision, expectedCurrentId: current?.id || null };
    const options = { databasePool: db, mutationContext: { actorUserId: cli.actor } };
    if (cli.mode === 'preview') {
      print(JSON.stringify({ kind: 'publication_preview', ...summarize(await publication.preview(config, request, options)) }));
      return 0;
    }
    const result = await publication.publish(config, { ...request, previewToken: cli.previewToken,
      ...(cli.coverageReason ? { ackCoverageLoss: true, coverageReason: cli.coverageReason.trim() } : {}) }, options);
    print(JSON.stringify({ kind: 'published', bindingRevisionId: result.revision?.id, state: result.revision?.state,
      versionNumber: result.revision?.versionNumber, handoffId: result.handoffId, alreadyApplied: result.alreadyApplied === true }));
    return 0;
  } catch (error) {
    printError(JSON.stringify({ ok: false, code: error.code || 'PUBLICATION_FAILED', ...(error.details ? { details: error.details } : {}) }));
    return 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, summarize, main };
