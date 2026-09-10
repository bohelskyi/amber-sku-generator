const express = require('express');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');
const crypto = require('node:crypto');
const pool = require('./db/pool');
const { trustProxy } = require('./config/env');
const { createSessionMiddleware } = require('./auth/session');
const { createAuthRouter } = require('./routes/auth.routes');
const {
  requireAuthenticatedSession,
  requireCsrfForUnsafeMethods,
} = require('./auth/authentication');
const { createRequireActiveApplicationUser } = require('./auth/authorization');
const logger = require('./utils/logger');
const { getRequestLogPath } = require('./utils/request-log-path');

function createApp({
  sessionMiddleware = createSessionMiddleware(),
  oidcAdapter,
  applicationUserService,
} = {}) {
  const app = express();

  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use((req, res, next) => {
    const requestId = String(req.get('X-Request-ID') || crypto.randomUUID()).slice(0, 128);
    const startedAt = Date.now();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      const context = {
        requestId,
        method: req.method,
        path: getRequestLogPath(req),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      logger.info('http.request.completed', context);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        logger.info('http.mutation.completed', {
          ...context,
          actorId: req.applicationUser?.id ?? null,
        });
      }
    });
    next();
  });

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (error) {
      logger.error('health.readiness.failed', {
        requestId: req.requestId,
        error: error.message,
        code: error.code,
      });
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.use('/api', sessionMiddleware);
  app.use('/api/auth', createAuthRouter({
    ...(oidcAdapter ? { oidcAdapter } : {}),
    ...(applicationUserService ? { applicationUserService } : {}),
  }));
  app.use('/api', requireAuthenticatedSession);
  app.use('/api', createRequireActiveApplicationUser({
    getOrCreateApplicationAccess: applicationUserService?.getOrCreateApplicationAccess,
  }));
  app.use('/api', requireCsrfForUnsafeMethods);
  app.use('/api', publicRoutes);
  app.use('/api', adminRoutes);

  app.use((error, req, res, _next) => {
    logger.error('http.request.unhandled_error', {
      requestId: req.requestId,
      method: req.method,
      path: getRequestLogPath(req),
      error: error.message,
      code: error.code,
    });
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  });

  return app;
}

const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
