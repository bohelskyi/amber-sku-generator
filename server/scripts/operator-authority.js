'use strict';

const error = (status, code, message) => Object.assign(new Error(message), { status, code });

async function authorize(database, actorId, permissions) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || !Array.isArray(permissions)
    || !permissions.length || permissions.some(permission => typeof permission !== 'string' || !permission)) {
    throw error(403, 'OPERATOR_AUTHORITY_INVALID', 'Explicit actor and permissions required');
  }
  const { assertActorStillAuthorized } = require('../src/services/access-admin-transaction');
  const { administrator } = require('../src/services/magento/binding-publication');
  for (const permission of permissions) {
    await assertActorStillAuthorized(database, actorId, permission, error, { readOnly: true });
  }
  await administrator(database, actorId);
}

function guardPool(databasePool, actorId, permissions) {
  const { APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');
  // The UI services already serialize authority changes with this lock. Check
  // the CLI's additional Administrator requirement inside that same boundary;
  // an outer lock would deadlock services that borrow another connection.
  return new Proxy(databasePool, {
    get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        let discard = false;
        return new Proxy(client, {
          get(connection, key) {
            if (key === 'release') return destroy => connection.release(discard || destroy);
            if (key === 'query') return async (...args) => {
              const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text;
              const values = typeof args[0] === 'string' ? args[1] : args[0]?.values;
              const lock = typeof statement === 'string'
                && /^SELECT\s+pg_advisory_(xact_lock|lock_shared)\(hashtext\(\$1\)\)\s*;?$/i.exec(statement.trim());
              const result = await connection.query(...args);
              if (lock && values?.length === 1 && values[0] === APPLICATION_USER_ADMIN_LOCK_KEY) {
                try { await authorize(connection, actorId, permissions); }
                catch (cause) {
                  // The caller sets its session-lock cleanup flag only after
                  // this promise resolves. Release our acquired lock on refusal.
                  if (lock[1].toLowerCase() === 'lock_shared') {
                    try { await connection.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]); }
                    catch { discard = true; }
                  }
                  throw cause;
                }
              }
              return result;
            };
            const value = Reflect.get(connection, key, connection);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { authorize, guardPool };
