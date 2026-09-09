const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SESSION_COOKIE_NAME,
  SESSION_TABLE_NAME,
  buildSessionOptions,
  createPostgresSessionStore,
  createSessionMiddleware,
} = require('../src/auth/session');

const sessionConfig = {
  secret: '0123456789abcdef0123456789abcdef',
  maxAgeMs: 8 * 60 * 60 * 1000,
  secure: true,
};

test('session options use a fixed opaque host-only API cookie', () => {
  const store = {};
  const options = buildSessionOptions({ config: sessionConfig, store });

  assert.equal(options.name, SESSION_COOKIE_NAME);
  assert.equal(options.store, store);
  assert.equal(options.resave, false);
  assert.equal(options.saveUninitialized, false);
  assert.equal(options.rolling, false);
  assert.equal(options.unset, 'destroy');
  assert.deepEqual(options.cookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api',
    maxAge: sessionConfig.maxAgeMs,
  });
  assert.equal(Object.hasOwn(options.cookie, 'domain'), false);
});

test('PostgreSQL store uses the migrated table and never creates it at runtime', () => {
  const databasePool = {};
  const sessionModule = { Store: class {} };
  let receivedOptions;
  const pgStoreFactory = (receivedSessionModule) => {
    assert.equal(receivedSessionModule, sessionModule);
    return class FakePgStore {
      constructor(options) {
        receivedOptions = options;
      }
    };
  };

  createPostgresSessionStore({
    config: sessionConfig,
    databasePool,
    sessionModule,
    pgStoreFactory,
  });

  assert.equal(receivedOptions.pool, databasePool);
  assert.equal(receivedOptions.tableName, SESSION_TABLE_NAME);
  assert.equal(receivedOptions.createTableIfMissing, false);
  assert.equal(receivedOptions.disableTouch, true);
  assert.equal(receivedOptions.ttl, sessionConfig.maxAgeMs / 1000);
});

test('session middleware construction is injectable', () => {
  const store = {};
  let receivedOptions;
  const middleware = () => {};
  const sessionModule = (options) => {
    receivedOptions = options;
    return middleware;
  };

  const result = createSessionMiddleware({ config: sessionConfig, store, sessionModule });

  assert.equal(result, middleware);
  assert.equal(receivedOptions.store, store);
  assert.equal(receivedOptions.secret, sessionConfig.secret);
});
