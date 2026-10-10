// Local evidence audit only: no application startup, worker or Magento client.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HELP = 'DATABASE_URL must be supplied explicitly.\n'
  + 'node scripts/magento-first-sync-optional-audit.js [--limit 1..500] [--after-session UUID | --session UUID]\n'
  + 'Reads saved optional-empty receipts in a bounded read-only snapshot. No repair or Magento requests. '
  + 'Default limit: 100. Exit 2 means review blockers; exit 3 means truncated without blockers. '
  + 'Follow nextAfterSession when truncated. Exit 0 means this requested scope is complete without blockers. '
  + 'An empty exact-session result means no optional receipts were audited; it is not acceptance or delivery authority.';
const PUBLIC_ERRORS = new Set(['FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID',
  'FIRST_SYNC_OPTIONAL_AUDIT_SESSION_MISMATCH', 'FIRST_SYNC_OPTIONAL_AUDIT_TIME_LIMIT', 'DATABASE_URL_REQUIRED']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['limit', 'afterSession', 'session'].includes(key))) {
    fail('FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID');
  }
  const { limit = DEFAULT_LIMIT, afterSession = null, session = null } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT
    || [afterSession, session].some(value => value !== null && (typeof value !== 'string' || !UUID.test(value)))
    || afterSession !== null && session !== null) fail('FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID');
  return { limit, afterSession: afterSession?.toLowerCase() ?? null, session: session?.toLowerCase() ?? null };
}

function parseArgs(args) {
  if (!Array.isArray(args)) fail('FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID');
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--limit': 'limit', '--after-session': 'afterSession', '--session': 'session' };
  const input = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || typeof value !== 'string' || Object.hasOwn(input, key)
      || key === 'limit' && !/^[1-9]\d{0,2}$/.test(value)) fail('FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID');
    input[key] = key === 'limit' ? Number(value) : value;
  }
  return validateOptions(input);
}

async function runAudit(pool, options = {}, { assess, readProgress, now = Date.now } = {}) {
  const input = validateOptions(options);
  assess ||= require('../src/services/magento/first-sync-optional-receipt-audit').assessOnClient;
  readProgress ||= require('../src/services/magento/first-sync-ledger').readOnClient;
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun = true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
    const deadline = now() + 60000;
    const selected = (await client.query(`SELECT s.id,s.origin_hash,s.public_product_identity_id::text
      FROM magento_first_sync_sessions s
      WHERE ($1::uuid IS NULL OR s.id > $1::uuid)
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
        AND EXISTS (SELECT 1 FROM (
          SELECT DISTINCT ON (f.target,f.scope) f.state
          FROM magento_first_sync_fields f
          WHERE f.session_id=s.id AND f.revision<=s.revision
          ORDER BY f.target,f.scope,f.revision DESC
        ) latest WHERE latest.state='optional_empty')
      ORDER BY s.id LIMIT $3`, [input.afterSession, input.session, input.limit + 1])).rows;
    const sessions = [];
    for (const selectedSession of selected.slice(0, input.limit)) {
      if (now() >= deadline) fail('FIRST_SYNC_OPTIONAL_AUDIT_TIME_LIMIT');
      const progress = await readProgress(client, { originHash: selectedSession.origin_hash,
        publicIdentityId: selectedSession.public_product_identity_id });
      if (!progress || progress.session.id !== selectedSession.id) fail('FIRST_SYNC_OPTIONAL_AUDIT_SESSION_MISMATCH');
      const assessment = await assess(client, progress);
      if (now() >= deadline) fail('FIRST_SYNC_OPTIONAL_AUDIT_TIME_LIMIT');
      const saved = progress.session;
      sessions.push({ sessionId: saved.id, originHash: saved.origin_hash,
        publicIdentityId: saved.public_product_identity_id, publicSku: saved.public_sku,
        remoteProductId: saved.remote_product_id, initialProductId: saved.initial_product_id,
        initialBindingRevisionId: saved.initial_binding_revision_id, revision: saved.revision,
        completedAt: saved.completed_at, ...assessment });
    }
    await client.query('COMMIT');
    begun = false;
    const truncated = selected.length > input.limit;
    return { reportVersion: 1, kind: 'magento-first-sync-optional-receipt-audit', readOnly: true,
      filter: input, sessions, sessionCount: sessions.length,
      blockedSessionCount: sessions.filter(session => session.blockers.length > 0).length,
      truncated, scopeComplete: !truncated, nextAfterSession: truncated ? sessions.at(-1).sessionId : null };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function main(args = process.argv.slice(2), { pool, env = process.env, print = console.log,
  printError = console.error, createPool, ...dependencies } = {}) {
  let owned;
  try {
    const input = parseArgs(args);
    if (input.help) { print(HELP); return 0; }
    if (!pool) {
      if (!env.DATABASE_URL) fail('DATABASE_URL_REQUIRED');
      const makePool = createPool || (options => new (require('pg').Pool)(options));
      pool = owned = makePool({ connectionString: env.DATABASE_URL, max: 1,
        connectionTimeoutMillis: 5000, query_timeout: 12000, statement_timeout: 10000,
        options: '-c default_transaction_read_only=on' });
    }
    const report = await runAudit(pool, input, dependencies);
    print(JSON.stringify(report));
    return report.blockedSessionCount > 0 ? 2 : report.truncated ? 3 : 0;
  } catch (error) {
    printError(JSON.stringify({ code: PUBLIC_ERRORS.has(error.code) ? error.code : 'FIRST_SYNC_OPTIONAL_AUDIT_FAILED' }));
    return 1;
  } finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, runAudit, main };
