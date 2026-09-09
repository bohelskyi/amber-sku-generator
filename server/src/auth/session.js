const expressSession = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const pool = require('../db/pool');
const env = require('../config/env');
const logger = require('../utils/logger');

const SESSION_COOKIE_NAME = 'amber.sid';
const SESSION_TABLE_NAME = 'session';

function getDefaultSessionConfig() {
  return {
    secret: env.sessionSecret,
    maxAgeMs: env.sessionMaxAgeMs,
    secure: env.sessionCookieSecure,
  };
}

function buildCookieOptions({ secure, maxAgeMs } = {}) {
  const options = {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/api',
  };
  if (maxAgeMs !== undefined) options.maxAge = maxAgeMs;
  return options;
}

function buildSessionOptions({ config, store }) {
  return {
    name: SESSION_COOKIE_NAME,
    secret: config.secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    unset: 'destroy',
    cookie: buildCookieOptions({ secure: config.secure, maxAgeMs: config.maxAgeMs }),
  };
}

function createPostgresSessionStore({
  config,
  databasePool = pool,
  sessionModule = expressSession,
  pgStoreFactory = connectPgSimple,
} = {}) {
  const resolvedConfig = config || getDefaultSessionConfig();
  const PgSessionStore = pgStoreFactory(sessionModule);
  return new PgSessionStore({
    pool: databasePool,
    tableName: SESSION_TABLE_NAME,
    createTableIfMissing: false,
    ttl: Math.ceil(resolvedConfig.maxAgeMs / 1000),
    disableTouch: true,
    errorLog: (error) => logger.error('session.store.error', {
      error: error instanceof Error ? error.message : String(error),
    }),
  });
}

function createSessionMiddleware({
  config,
  databasePool = pool,
  store,
  sessionModule = expressSession,
  pgStoreFactory = connectPgSimple,
} = {}) {
  const resolvedConfig = config || getDefaultSessionConfig();
  const resolvedStore = store || createPostgresSessionStore({
    config: resolvedConfig,
    databasePool,
    sessionModule,
    pgStoreFactory,
  });
  return sessionModule(buildSessionOptions({ config: resolvedConfig, store: resolvedStore }));
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TABLE_NAME,
  buildCookieOptions,
  buildSessionOptions,
  createPostgresSessionStore,
  createSessionMiddleware,
};
