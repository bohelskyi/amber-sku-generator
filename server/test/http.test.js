const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { fetchJson, requestJsonOnce } = require('../src/utils/http');

function fakeRequest(handler) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit('error', error);
    request.end = () => handler({ callback, request });
    return request;
  };
}

function reply(callback, statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.destroy = (error) => response.emit('error', error);
  callback(response);
  queueMicrotask(() => {
    if (body !== undefined) response.emit('data', Buffer.from(body));
    response.emit('end');
  });
}

test('requestJsonOnce aborts a request that exceeds the timeout', async () => {
  const requestImpl = fakeRequest(() => {});
  await assert.rejects(
    requestJsonOnce('https://example.test', { requestImpl, timeoutMs: 5 }),
    (error) => error.code === 'ETIMEDOUT'
  );
});

test('requestJsonOnce rejects an invalid JSON payload', async () => {
  const requestImpl = fakeRequest(({ callback }) => reply(callback, 200, 'not-json'));
  await assert.rejects(
    requestJsonOnce('https://example.test', { requestImpl }),
    (error) => error.code === 'ERR_INVALID_JSON'
  );
});

test('requestJsonOnce limits response body size', async () => {
  const requestImpl = fakeRequest(({ callback }) => reply(callback, 200, '{"large":true}'));
  await assert.rejects(
    requestJsonOnce('https://example.test', { requestImpl, maxBytes: 4 }),
    (error) => error.code === 'ERR_RESPONSE_TOO_LARGE'
  );
});

test('fetchJson retries transient HTTP failures with bounded attempts', async () => {
  let attempts = 0;
  const requestImpl = fakeRequest(({ callback }) => {
    attempts += 1;
    reply(callback, attempts === 1 ? 503 : 200, attempts === 1 ? '{}' : '{"ok":true}');
  });
  const result = await fetchJson('https://example.test', {
    requestImpl,
    retries: 1,
    sleep: async () => {},
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
});
