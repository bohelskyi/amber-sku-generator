const pool = require('../db/pool');
const { createMutationContext } = require('../audit/mutation-context');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const published = require('./export-templates/published-capture');
const { error } = require('./export-templates/snapshot-binding');

const missing = () => error(404, 'EXPORT_NOT_FOUND', 'Експорт не знайдено.');
const conflict = (code = 'EXPORT_SESSION_CONFLICT') => error(409, code, 'Стан експорту змінився. Оновіть його; локальні зміни не збережено.');
function validId(id) { if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw missing(); return id; }
function revision(value) { const v = String(value ?? ''); if (!/^[1-9][0-9]{0,18}$/.test(v)) throw error(422, 'EXPORT_REVISION_REQUIRED', 'Потрібна точна ревізія.'); return v; }
function connectionPool(client) { return { query: (...args) => client.query(...args), connect: async () => ({ query: (...args) => client.query(...args), release() {} }) }; }

async function loadAccess(client, id, actor, { target = false, expectedAccessEpoch, mutate = false, ownerOnly = false } = {}) {
  const row = (await client.query(`SELECT s.*, m.state AS membership_state, m.epoch AS membership_epoch,
    u.display_name AS owner_name, u.preferred_username AS owner_username
    FROM export_sessions s JOIN application_users u ON u.id=s.owner_user_id
    LEFT JOIN export_session_members m ON m.session_id=s.id AND m.user_id=$2
    WHERE s.id=$1`, [validId(id), actor])).rows[0];
  const owner = row && String(row.owner_user_id) === String(actor);
  if (!row || (!owner && row.membership_state !== 'accepted' && !(target && row.membership_state))) throw missing();
  if (ownerOnly && !owner) throw missing();
  const accessEpoch = owner ? 'owner' : row.membership_epoch;
  if (mutate && String(expectedAccessEpoch ?? '') !== accessEpoch) throw conflict('EXPORT_MEMBERSHIP_CHANGED');
  return { ...row, owner, accessEpoch };
}

// All session mutations and capture hold this session advisory lock before BEGIN,
// never waiting for it after a repeatable-read snapshot has been established.
async function withSession(id, options, operation) {
  validId(id);
  const context = createMutationContext(options.mutationContext);
  const client = await (options.databasePool || pool).connect();
  let authority = false; let locked = false;
  try {
    await published.protectAuthority(client, context.actorUserId, 'exports.view'); authority = true;
    if (options.write) await assertActorStillAuthorized(client, context.actorUserId, 'exports.create', error);
    if (options.tryLock) locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked', ['amber:export-session:v1', id])).rows[0].locked;
    else { await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', ['amber:export-session:v1', id]); locked = true; }
    const session = await loadAccess(client, id, context.actorUserId, options);
    return await operation(client, session, { context, locked, databasePool: connectionPool(client) });
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', ['amber:export-session:v1', id]); }
    finally { try { if (authority) await published.releaseAuthority(client); } finally { client.release(); } }
  }
}

async function assertSnapshotAccess(client, snapshot, options = {}) {
  if (!snapshot?.export_session_id) return null;
  const actor = options.mutationContext?.actorUserId;
  if (!actor) throw missing();
  // One current committed membership read. Locators and keys never grant access.
  await assertActorStillAuthorized(client, actor, 'exports.view', error);
  return loadAccess(client, snapshot.export_session_id, actor);
}
module.exports = { missing, conflict, validId, revision, connectionPool, loadAccess, withSession, assertSnapshotAccess };
