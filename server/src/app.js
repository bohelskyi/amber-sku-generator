const express = require('express');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');
const crypto = require('node:crypto');
const { sendHttpError } = require('./http/errors');
const pool = require('./db/pool');
const lifecycleGate = require('./services/full-product-cutover-gate');
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
const {
  createRequestMetrics,
  runWithRequestMetrics,
  summarizeRequestMetrics,
} = require('./observability/performance-metrics');

function createApp({
  sessionMiddleware = createSessionMiddleware(),
  oidcAdapter,
  applicationUserService,
} = {}) {
  const app = express();

  app.set('trust proxy', trustProxy);
  // PR1B permits 256 KiB definitions; leave all other routes' parser limits unchanged.
  app.use('/api/admin/export-templates', express.json({ limit: '272kb' }));
  const ordinaryJson = express.json();
  // Large photo payloads are parsed only after authentication, active access and CSRF.
  app.use((req, res, next) => req.method === 'POST' && /^\/api\/product-photos\/stage\/?$/i.test(req.path)
    ? next() : ordinaryJson(req, res, next));
  app.use((req, res, next) => {
    const requestId = String(req.get('X-Request-ID') || crypto.randomUUID()).slice(0, 128);
    const startedAt = Date.now();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    const requestMetrics = createRequestMetrics(requestId);
    res.on('finish', () => {
      const contentLength = Number(res.getHeader('content-length'));
      const context = {
        requestId,
        method: req.method,
        path: getRequestLogPath(req),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        ...summarizeRequestMetrics(requestMetrics, {
          pool,
          responseBytes: Number.isFinite(contentLength) ? contentLength : null,
        }),
      };
      logger.info('http.request.completed', context);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        logger.info('http.mutation.completed', {
          ...context,
          actorId: req.applicationUser?.id ?? null,
        });
      }
    });
    runWithRequestMetrics(requestMetrics, next);
  });

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.setHeader('X-Amber-Full-Product-Writer', String(lifecycleGate.WRITER_VERSION));
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
  app.use('/api', async (req, _res, next) => {
    try {
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && (await lifecycleGate.readGate(pool)).phase === 'preparing') {
        throw lifecycleGate.error('EXPORT_CUTOVER_PREPARING', 'Business changes are frozen until export cutover activation', 503);
      }
      next();
    } catch (error) { next(error); }
  });
  const photoJson = express.json({ limit: require('./services/product-photos.service').MAX_PHOTO_REQUEST_BYTES });
  app.use('/api/product-photos/stage', require('./auth/authorization').requireAnyPermission(['products.create', 'products.recount']),
    (req, res, next) => photoJson(req, res, (error) => {
      if (!error) return next();
      const { PublicHttpError } = require('./http/errors');
      next(new PublicHttpError(error.type === 'entity.too.large' ? 413 : 400,
        error.type === 'entity.too.large' ? 'Запит із фото завеликий. Додавайте по одному фото до 1 МіБ (1048576 байтів).' : 'Не вдалося прочитати запит із фото.',
        { code: error.type === 'entity.too.large' ? 'PHOTO_SIZE_LIMIT_EXCEEDED' : 'PHOTO_REQUEST_INVALID' }));
    }));
  app.use('/api', require('./routes/public/product-photos.routes'));
  app.use('/api', require('./routes/admin/catalog-deletion.routes'));
  app.use('/api', require('./routes/public/product-lifecycle.routes'));
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
    sendHttpError(res, error, { includeCode: ['EXPORT_CUTOVER_PREPARING', 'PHOTO_SIZE_LIMIT_EXCEEDED', 'PHOTO_REQUEST_INVALID'].includes(error.code) });
  });

  return app;
}

const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
