class PublicHttpError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'PublicHttpError';
    this.statusCode = statusCode;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isValidStatusCode(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

function serializeHttpError(error, {
  defaultMessage = 'Internal server error',
  fallbackStatus = 500,
  includeCode = false,
  includeDetails = false,
  isExpected = (candidate) => candidate instanceof PublicHttpError,
} = {}) {
  const expected = Boolean(isExpected(error));
  const statusCode = expected && isValidStatusCode(error?.statusCode)
    ? error.statusCode
    : fallbackStatus;
  const body = {
    error: expected && error?.message ? error.message : defaultMessage,
  };

  if (expected && includeCode && error.code !== undefined) body.code = error.code;
  if (expected && includeDetails && error.details !== undefined) body.details = error.details;

  return { statusCode, body };
}

function sendHttpError(res, error, options) {
  const { statusCode, body } = serializeHttpError(error, options);
  return res.status(statusCode).json(body);
}

module.exports = {
  PublicHttpError,
  sendHttpError,
  serializeHttpError,
};
