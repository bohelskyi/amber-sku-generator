// Read-only local verification: deliberately no Magento client or worker import.
const { Pool } = require('pg');

async function run(args = process.argv.slice(2), env = process.env, print = console.log) {
  if (args.length === 1 && args[0] === '--help') {
    print('DATABASE_URL must be supplied explicitly. magento:auto-status -- --expected-database NAME [--expect-disabled]. Reads local state only; no .env loading, migrations, worker or HTTP.');
    return 0;
  }
  const expectedIndex = args.indexOf('--expected-database');
  const expected = expectedIndex >= 0 ? args[expectedIndex + 1] : null;
  if (!expected || args.some((v, i) => i !== expectedIndex && i !== expectedIndex + 1 && v !== '--expect-disabled') || !env.DATABASE_URL) {
    print(JSON.stringify({ code: 'EXPLICIT_DATABASE_REQUIRED' })); return 1;
  }
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await db.query('BEGIN READ ONLY');
    const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
    if (name !== expected) throw new Error('DATABASE_MISMATCH');
    const installed = (await db.query("SELECT to_regclass('magento_auto_sync_activation') IS NOT NULL AS installed")).rows[0].installed;
    if (!installed) { print(JSON.stringify({ database: name, installed: false })); return 2; }
    const gate = (await db.query(`SELECT enabled,installation_key,actor_user_id,
      legacy_product_csv_enabled,cutover_at FROM magento_auto_sync_activation WHERE singleton`)).rows[0];
    const counts = (await db.query('SELECT state,count(*)::int AS count FROM magento_product_sync_requests GROUP BY state ORDER BY state')).rows;
    const published = (await db.query(`SELECT id,version_number FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`, [gate.installation_key])).rows[0] || null;
    await db.query('COMMIT');
    print(JSON.stringify({ database: name, installed: true, enabled: gate.enabled, installationKey: gate.installation_key,
      actorUserId: gate.actor_user_id === null ? null : Number(gate.actor_user_id),
      legacyProductCsvEnabled: gate.legacy_product_csv_enabled, cutoverAt: gate.cutover_at, published, counts }));
    return args.includes('--expect-disabled') && gate.enabled ? 2 : 0;
  } catch {
    print(JSON.stringify({ code: 'LOCAL_STATUS_VERIFICATION_FAILED' })); return 1;
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
}
if (require.main === module) run().then((code) => { process.exitCode = code; });
module.exports = { run };
