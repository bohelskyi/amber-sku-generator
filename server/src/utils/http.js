const https = require('https');

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_RETRIES = 2;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(error) {
  if (!error) return false;
  if (['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) {
    return true;
  }
  return Number(error.statusCode) === 408
    || Number(error.statusCode) === 429
    || Number(error.statusCode) >= 500;
}

function requestJsonOnce(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  requestImpl = https.request,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let request;
    let timeoutId;
    const abortFromParent = () => {
      const error = signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('HTTP request aborted'), { code: 'ABORT_ERR' });
      controller.abort(error);
      if (request) request.destroy(error);
      finish(reject, error);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortFromParent);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      const error = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      controller.abort(error);
      if (request) request.destroy(error);
      finish(reject, error);
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        abortFromParent();
        return;
      }
      else signal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      request = requestImpl(url, { method: 'GET', signal: controller.signal }, (response) => {
        const chunks = [];
        let receivedBytes = 0;

        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxBytes) {
            const error = new Error(`HTTP response exceeded ${maxBytes} bytes`);
            error.code = 'ERR_RESPONSE_TOO_LARGE';
            response.destroy(error);
            finish(reject, error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', (error) => finish(reject, error));
        response.on('end', () => {
          const statusCode = Number(response.statusCode || 0);
          if (statusCode < 200 || statusCode >= 300) {
            const error = new Error(`HTTP ${statusCode}`);
            error.statusCode = statusCode;
            finish(reject, error);
            return;
          }
          try {
            finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            error.code = 'ERR_INVALID_JSON';
            finish(reject, error);
          }
        });
      });
      request.on('error', (error) => finish(reject, error));
      request.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function fetchJson(url, {
  retries = DEFAULT_RETRIES,
  backoffMs = 150,
  sleep = wait,
  ...requestOptions
} = {}) {
  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestJsonOnce(url, requestOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientError(error)) throw error;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
  isTransientError,
  requestJsonOnce,
};
