const test = require('node:test');
const assert = require('node:assert/strict');

const { PublicHttpError, serializeHttpError } = require('../src/http/errors');

test('typed HTTP errors preserve the characterized public fields', () => {
  const error = new PublicHttpError(409, 'Conflict', {
    code: 'CONFLICT',
    details: { field: 'sku' },
  });

  assert.deepEqual(serializeHttpError(error, {
    includeCode: true,
    includeDetails: true,
  }), {
    statusCode: 409,
    body: {
      error: 'Conflict',
      code: 'CONFLICT',
      details: { field: 'sku' },
    },
  });
});

test('unexpected errors do not expose private messages or fields', () => {
  const error = Object.assign(new Error('database password leaked'), {
    statusCode: 418,
    code: 'PRIVATE',
    details: { secret: true },
  });

  assert.deepEqual(serializeHttpError(error, {
    includeCode: true,
    includeDetails: true,
  }), {
    statusCode: 500,
    body: { error: 'Internal server error' },
  });
});

test('serializer can preserve an established typed-error family', () => {
  class ExistingPublicError extends Error {
    constructor() {
      super('Existing response');
      this.statusCode = 400;
      this.code = 'EXISTING';
    }
  }
  const error = new ExistingPublicError();

  assert.deepEqual(serializeHttpError(error, {
    defaultMessage: 'Operation failed',
    includeCode: true,
    isExpected: (candidate) => candidate instanceof ExistingPublicError,
  }), {
    statusCode: 400,
    body: { error: 'Existing response', code: 'EXISTING' },
  });
});
