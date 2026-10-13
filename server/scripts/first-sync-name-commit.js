'use strict';

// The caller owns the SKU guard, fresh observation, names-only validation and
// durable intent. This adapter changes no plan and opens no transaction of its
// own: the existing first.commit owns BEGIN, revalidation, ledger and COMMIT.
const error = code => Object.assign(new Error(code), { code });
const mark = (cause, flag) => Object.assign(cause instanceof Error && Object.isExtensible(cause)
  ? cause : error('CAMPAIGN_NAME_COMMIT_FAILED'), { [flag]: true });

async function runNameCommit(runtime, config, state, inspection, options) {
  const lockKey = runtime?.access?.APPLICATION_USER_ADMIN_LOCK_KEY;
  if (typeof lockKey !== 'string' || !lockKey || typeof runtime?.publication?.administrator !== 'function'
    || typeof runtime?.first?.commit !== 'function' || typeof options?.databasePool?.connect !== 'function'
    || !Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0
    || inspection?.mode !== 'first' || !inspection.prepared || !state
    || ['firstSyncDecision', 'automatic', 'firstSyncRecoveryProof'].some(key => Object.hasOwn(options, key))
    || options.stopping !== undefined && typeof options.stopping !== 'function')
    throw mark(error('CAMPAIGN_NAME_COMMIT_INPUT_INVALID'), 'nameCommitNotStarted');
  const stopped = () => { if (options.stopping?.()) throw mark(error('CAMPAIGN_NAME_COMMIT_INTERRUPTED'), 'nameCommitNotStarted'); };
  stopped();
  let client;
  try { client = await options.databasePool.connect(); }
  catch (cause) { throw mark(cause, 'nameCommitNotStarted'); }
  let active = true, borrowed = false, released = false, lockAttempted = false;
  let beginAttempted = false, commitAttempted = false, committed = false, rolledBack = false;
  let queryFailure = null, protocolFailure = null, cleanupFailure = null, failure = null, result;
  const reject = () => {
    protocolFailure ||= error('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT');
    throw protocolFailure;
  };
  const query = async (...args) => {
    try { return await client.query(...args); }
    catch (cause) { queryFailure ||= cause; throw cause; }
  };
  // One stable object is important: the canonical lifecycle gate keys its
  // session-lock ownership by client identity in a WeakMap.
  const proxy = Object.freeze({
    query: async (...args) => {
      if (!active || released || typeof args[0] !== 'string') return reject();
      const sql = args[0].trim().replace(/;$/, '').trim().toUpperCase();
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)) {
        if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return reject();
        if (sql === 'BEGIN') {
          if (beginAttempted) return reject();
          beginAttempted = true;
        }
        if (sql === 'COMMIT') {
          if (!beginAttempted || commitAttempted || rolledBack) return reject();
          commitAttempted = true;
        }
      }
      const value = await query(...args);
      if (sql === 'COMMIT') {
        if (value?.command !== 'COMMIT') return reject();
        committed = true;
      }
      if (sql === 'ROLLBACK') {
        if (value?.command !== 'ROLLBACK') return reject();
        rolledBack = true;
      }
      return value;
    },
    release: cause => {
      if (!active || released) return reject();
      released = true;
      if (cause) queryFailure ||= cause;
    },
  });
  const pool = Object.freeze({
    connect: async () => {
      if (!active || borrowed) return reject();
      borrowed = true; return proxy;
    },
    query: async () => reject(),
  });
  try {
    stopped();
    lockAttempted = true;
    await query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    stopped();
    await runtime.publication.administrator({ query }, options.actorUserId);
    stopped();
    result = await runtime.first.commit(config, inspection, state, { ...options, databasePool: pool });
    if (!borrowed || !released || !committed || queryFailure || protocolFailure) reject();
  } catch (cause) { failure = cause; }
  finally {
    active = false;
    // Canonical cleanup can deliberately swallow failures. Never return a
    // possibly open transaction or session advisory lock to the real pool.
    if (beginAttempted && !committed && !rolledBack) {
      try {
        const value = await query('ROLLBACK');
        if (value?.command === 'ROLLBACK') rolledBack = true;
        else cleanupFailure ||= error('CAMPAIGN_NAME_COMMIT_CLEANUP_FAILED');
      } catch (cause) { cleanupFailure ||= cause; }
    }
    if (lockAttempted) {
      try {
        const unlocked = await query('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
        if (unlocked?.rows?.length !== 1 || unlocked.rows[0].unlocked !== true)
          cleanupFailure ||= error('CAMPAIGN_NAME_COMMIT_CLEANUP_FAILED');
      } catch (cause) { cleanupFailure ||= cause; }
    }
    try { client.release(queryFailure || protocolFailure || cleanupFailure || undefined); }
    catch (cause) { cleanupFailure ||= cause; }
  }
  if (failure || queryFailure || protocolFailure || cleanupFailure) {
    if (commitAttempted || beginAttempted && !rolledBack)
      throw Object.assign(error('CAMPAIGN_NAME_COMMIT_UNCONFIRMED'), { unconfirmed: true });
    throw mark(failure || protocolFailure || error('CAMPAIGN_NAME_COMMIT_CLEANUP_FAILED'),
      beginAttempted ? 'nameCommitRolledBack' : 'nameCommitNotStarted');
  }
  return result;
}

module.exports = { runNameCommit };
