const WRITER_VERSION = 1;
const { PublicHttpError } = require('../http/errors');
const LOCK_KEY = 'amber_full_product_cutover';
const held = new WeakMap();

function error(code, message, statusCode = 409) {
  return Object.assign(new PublicHttpError(statusCode, message, { code }), { publicCode: code });
}
async function readGate(client) {
  const exists = (await client.query("SELECT to_regclass('full_product_export_activation') IS NOT NULL AS present")).rows[0];
  if (!exists?.present) return { phase: 'legacy', generation: '0', selector_version: 0, required_writer_version: 1 };
  const gate = (await client.query('SELECT * FROM full_product_export_activation WHERE singleton=TRUE')).rows[0];
  if (!gate || gate.required_writer_version !== WRITER_VERSION) throw error('LIFECYCLE_WRITER_UNSUPPORTED', 'Unsupported lifecycle writer contract');
  return gate;
}

// Acquire before BEGIN: waiting must not freeze a stale repeatable-read snapshot.
// Existing access/session coordination stays outside this boundary.
async function begin(client, sql = 'BEGIN', { maintenance = false, exclusive = false } = {}) {
  if (held.has(client)) throw new Error('Nested lifecycle transaction boundary');
  await client.query(`SELECT pg_advisory_lock${exclusive ? '' : '_shared'}(hashtext($1))`, [LOCK_KEY]);
  held.set(client, exclusive);
  try {
    await client.query(sql);
    await client.query("SET LOCAL amber.lifecycle_writer_version = '1'");
    if (maintenance) await client.query("SET LOCAL amber.lifecycle_maintenance = 'on'");
    const gate = await readGate(client);
    if (gate.phase === 'preparing' && !maintenance && !/READ ONLY/i.test(sql)) {
      throw error('EXPORT_CUTOVER_PREPARING', 'Export lifecycle cutover is preparing; writes are temporarily frozen', 503);
    }
    return gate;
  } catch (cause) {
    await client.query('ROLLBACK');
    await release(client);
    throw cause;
  }
}
async function release(client) {
  if (!held.has(client)) return;
  const exclusive = held.get(client);
  held.delete(client);
  await client.query(`SELECT pg_advisory_unlock${exclusive ? '' : '_shared'}(hashtext($1))`, [LOCK_KEY]);
}
async function commit(client) {
  try { return await client.query('COMMIT'); } finally { await release(client); }
}
async function rollback(client) {
  try { return await client.query('ROLLBACK'); } finally { await release(client); }
}
// Access-administration commands already own their authority lock in an RC
// transaction. Join the gate only after that lock; never reverse its ordering.
async function enterExisting(client) {
  // A short mutation may revalidate more than once on the same client. Reuse
  // its existing session lock; PostgreSQL counts repeated acquisitions, while
  // this boundary owns one release. Preserve an existing exclusive lock too.
  if (!held.has(client)) {
    await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [LOCK_KEY]);
    held.set(client, false);
  }
  await client.query("SET LOCAL amber.lifecycle_writer_version = '1'");
  const gate = await readGate(client);
  if (gate.phase === 'preparing') throw error('EXPORT_CUTOVER_PREPARING', 'Export lifecycle cutover is preparing', 503);
  return gate;
}
async function requireActive(client) {
  const gate = await readGate(client);
  if (gate.phase !== 'active') throw error('LIFECYCLE_ACTIVATION_REQUIRED', 'Successor release requires the lifecycle selector to be active');
  return gate;
}
module.exports = { WRITER_VERSION, LOCK_KEY, begin, commit, rollback, enterExisting, release, readGate, requireActive, error };
