const express = require('express');
const cors = require('cors');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');
const crypto = require('node:crypto');
const pool = require('./db/pool');
const logger = require('./utils/logger');

const app = express();

app.use(cors());
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
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    };
    logger.info('http.request.completed', context);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      logger.info('audit.mutation', { ...context, actorId: null });
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

app.use('/api', publicRoutes);
app.use('/api', adminRoutes);

app.use((error, req, res, _next) => {
  logger.error('http.request.unhandled_error', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    error: error.message,
    code: error.code,
  });
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
});

module.exports = app;
