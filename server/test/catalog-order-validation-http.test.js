const test = require('node:test');
const assert = require('node:assert/strict');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');
const { Socket } = require('node:net');
const { Pool } = require('pg');

const CSRF_TOKEN = 'catalog-order-validation-csrf';

// Exercise the actual JSON parser and HTTP handler without binding a network port.
function reorderRequest(app, questions) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const incoming = new IncomingMessage(socket);
    const body = JSON.stringify({ category_code: 'SV', questions });
    incoming.complete = true;
    incoming.method = 'PUT';
    incoming.url = '/api/admin/questions/order';
    incoming.headers = { host: 'catalog-order.invalid', 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)), 'x-csrf-token': CSRF_TOKEN };
    const response = new ServerResponse(incoming);
    response.assignSocket(socket);
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function (chunk, ...args) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return originalWrite.call(this, chunk, ...args);
    };
    response.end = function (chunk, ...args) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return originalEnd.call(this, chunk, ...args);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Question reorder request did not terminate'));
    }, 3000);
    response.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
    response.once('finish', () => {
      clearTimeout(timer);
      resolve({ status: response.statusCode, headers: response.getHeaders(),
        body: Buffer.concat(chunks).toString() });
      socket.destroy();
    });
    incoming.push(Buffer.from(body));
    incoming.push(null);
    app.handle(incoming, response);
  });
}

test('question reorder HTTP rejects malformed entries with a controlled 400 before command I/O', async t => {
  const unexpectedIo = [];
  const forbid = operation => () => {
    unexpectedIo.push(operation);
    throw new Error(`Question reorder regression forbids ${operation}`);
  };
  t.mock.method(Socket.prototype, 'connect', forbid('network connection'));
  t.mock.method(globalThis, 'fetch', forbid('fetch'));
  t.mock.method(Pool.prototype, 'query', forbid('database query'));
  t.mock.method(Pool.prototype, 'connect', forbid('database connection'));
  const logger = require('../src/utils/logger');
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  // Only external session/access and global cutover-state reads are replaced.
  // The actual authentication, active-user, CSRF, permission and command code runs.
  t.mock.method(require('../src/auth/session'), 'createSessionMiddleware',
    () => (_req, _res, next) => next());
  const readGate = t.mock.method(require('../src/services/full-product-cutover-gate'), 'readGate',
    async () => ({ phase: 'legacy' }));
  const { createApp } = require('../src/app');
  let accessReads = 0;
  const identity = { issuer: 'https://catalog-order.invalid', sub: 'test-operator',
    authenticatedAt: '2026-10-23T00:00:00Z' };
  const app = createApp({
    sessionMiddleware: (req, _res, next) => {
      req.session = { identity, csrfToken: CSRF_TOKEN };
      next();
    },
    applicationUserService: { getOrCreateApplicationAccess: async user => {
      assert.deepEqual(user, identity);
      accessReads++;
      return { applicationUser: { id: 42, status: 'active' }, roles: [], permissions: ['catalog.manage'] };
    } },
  });

  for (const [label, questions] of [
    ['null entry', [null]],
    ['valid question before null', [{ id: 7, display_order: 1 }, null]],
    ['null before valid question', [null, { id: 7, display_order: 1 }]],
  ]) {
    await t.test(label, async () => {
      const beforeAccess = accessReads;
      const beforeGate = readGate.mock.callCount();
      const response = await reorderRequest(app, questions);
      assert.equal(response.status, 400);
      assert.match(response.headers['content-type'], /^application\/json\b/);
      assert.equal(response.headers.location, undefined);
      assert.deepEqual(JSON.parse(response.body), { error: 'Некоректні дані порядку питань' });
      assert.equal(accessReads, beforeAccess + 1);
      assert.equal(readGate.mock.callCount(), beforeGate + 1);
      assert.deepEqual(unexpectedIo, []);
    });
  }
});
