'use strict';
// Re-approves, in a binding successor draft, decisions that still await review but are
// identical to the approved decision of the current publication: same binding key, same
// Magento attribute/option ID, same evaluated output; policies re-approve the source policy. Typical
// case: a template change that only made a field optional (empty when Amber has no answer).
// Scope is limited to explicit --targets of one --group. Each approval goes through the
// existing binding-review decision (draft CAS, actor permission, audit) with an explicit
// reason. Anything that differs, or was not approved in the source, stays for UI review.
// preview: read-only. apply: approves only the identical decisions, one at a time.
// It never publishes the binding, enqueues products or writes to Magento.
const path = require('node:path');
const { createRequire } = require('node:module');

const HELP = 'node magento-carry-unchanged-reviews.js --mode preview|apply --expected-database NAME --actor-id ID '
  + '--source UUID --draft UUID --group SV --targets kolir,typy_obrobky_burshtynu,rozmir_suveniriv --reason TEXT [--server-root SERVER]';
const fail = code => { throw Object.assign(Error(code), { code }); };

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--expected-database': 'database', '--actor-id': 'actor', '--source': 'sourceId',
    '--draft': 'draftId', '--group': 'group', '--targets': 'targets', '--reason': 'reason', '--server-root': 'serverRoot' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) fail('CARRY_REVIEW_ARGUMENTS');
    out[key] = value;
  }
  const uuid = /^[0-9a-f-]{36}$/;
  out.targets = (out.targets || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!['preview', 'apply'].includes(out.mode) || !out.database || !/^[1-9][0-9]{0,17}$/.test(out.actor || '')
    || !uuid.test(out.sourceId || '') || !uuid.test(out.draftId || '') || !/^[A-Z][A-Z0-9_]{0,31}$/.test(out.group || '')
    || !out.targets.length || out.targets.some(t => !/^[a-z][a-z0-9_]{0,99}$/.test(t))
    || !out.reason || out.reason.trim().length > 2000) fail('CARRY_REVIEW_ARGUMENTS');
  out.actor = Number(out.actor);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}

// A pending policy's value is only the candidate default (often magento_managed), not a
// reviewed choice; its identity is the binding key and store scope, and the previously
// approved source policy is what gets re-approved (reported as restoredPolicy).
const identityOf = entry => JSON.stringify({ kind: entry.kind, identity: entry.kind === 'policy' ? null : entry.identity, label: entry.kind === 'option' ? null : entry.label,
  evaluated: entry.kind === 'option' ? entry.evaluated ?? null : null, transport: entry.decision.transportTarget ?? null });

// Pure planning: which pending draft decisions equal an approved source decision.
function plan(review, source, draft, { group, targets }) {
  const sourceEntries = new Map(review.entries(source).map(entry => [entry.id, entry]));
  const result = { identical: [], different: [], notApprovedInSource: [], missingInSource: [] };
  for (const entry of review.entries(draft)) {
    if (entry.group !== group || !targets.includes(entry.target) || entry.kind === 'route' || entry.kind === 'category') continue;
    if (!['proposed', 'review_required'].includes(entry.decision.reviewState)) continue;
    const before = sourceEntries.get(entry.id);
    const row = { id: entry.id, kind: entry.kind, target: entry.target, identity: entry.identity, label: entry.label ?? null };
    if (!before) result.missingInSource.push(row);
    else if (before.decision.reviewState !== 'approved') result.notApprovedInSource.push(row);
    else if (identityOf(before) !== identityOf(entry)) result.different.push({ ...row, sourceIdentity: before.identity });
    else result.identical.push({ ...row, ...(entry.kind === 'policy'
      ? { policy: before.identity, ...(entry.identity !== before.identity ? { restoredPolicy: { candidate: entry.identity, approved: before.identity } } : {}) }
      : {}) });
  }
  return result;
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const local = createRequire(path.join(cli.serverRoot, 'package.json'));
    const review = dependencies.review || local('./src/services/magento/binding-review');
    const bindings = dependencies.bindings || local('./src/services/magento/binding.service');
    if (!dependencies.pool) {
      const configuration = local('./src/config/env').loadConfig(env);
      pool = new (local('pg').Pool)({ ...configuration.databaseOptions, max: 2,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs });
    }
    const db = dependencies.pool || pool;
    if ((await db.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('CARRY_REVIEW_DATABASE_MISMATCH');
    const options = { databasePool: db, mutationContext: { actorUserId: cli.actor }, bindingService: bindings };
    const source = await bindings.getRevision(cli.sourceId, options);
    if (source.state !== 'published') fail('CARRY_REVIEW_SOURCE_NOT_PUBLISHED');
    let draft = await bindings.getRevision(cli.draftId, options);
    if (draft.state !== 'draft' || draft.installationKey !== source.installationKey) fail('CARRY_REVIEW_DRAFT_INVALID');
    const planned = plan(review, source, draft, cli);
    print(JSON.stringify({ kind: 'carry_review_' + cli.mode, draftRevision: draft.revision, identical: planned.identical.length,
      different: planned.different, notApprovedInSource: planned.notApprovedInSource, missingInSource: planned.missingInSource,
      identicalDecisions: planned.identical }));
    if (cli.mode === 'preview') return 0;
    let approved = 0;
    for (const item of planned.identical) {
      draft = await bindings.getRevision(cli.draftId, options);
      const input = { expectedRevision: String(draft.revision), binding: item.id, action: 'approve', acceptReview: true,
        reason: cli.reason.trim(), ...(item.kind === 'policy' ? { policy: item.policy } : {}) };
      await review.saveDecision(cli.draftId, input, options);
      approved++;
      print(JSON.stringify({ approved, total: planned.identical.length, id: item.id }));
    }
    const after = await bindings.getRevision(cli.draftId, options);
    const remaining = plan(review, source, after, cli);
    print(JSON.stringify({ kind: 'carry_review_done', approved, draftRevision: after.revision,
      stillPending: remaining.identical.length + remaining.different.length + remaining.notApprovedInSource.length + remaining.missingInSource.length }));
    return 0;
  } catch (error) {
    printError(JSON.stringify({ ok: false, code: error.code || 'CARRY_REVIEW_FAILED' }));
    return 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, plan, main };
