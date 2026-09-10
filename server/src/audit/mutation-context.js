const APPLICATION_USER_ID_PATTERN = /^[1-9]\d*$/;

function normalizeActorUserId(value) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !APPLICATION_USER_ID_PATTERN.test(normalized)) {
    throw new TypeError('Mutation actor user ID must be a positive integer');
  }
  const actorUserId = Number(normalized);
  if (!Number.isSafeInteger(actorUserId)) {
    throw new TypeError('Mutation actor user ID must be a positive integer');
  }
  return actorUserId;
}

function normalizeRequestId(value) {
  if (value === undefined || value === null) return null;
  const requestId = String(value).trim();
  if (!requestId) return null;
  return requestId.slice(0, 128);
}

function createMutationContext({ actorUserId, requestId } = {}) {
  return Object.freeze({
    actorUserId: normalizeActorUserId(actorUserId),
    requestId: normalizeRequestId(requestId),
  });
}

function getRequestMutationContext(req) {
  return createMutationContext({
    actorUserId: req?.applicationUser?.id,
    requestId: req?.requestId,
  });
}

module.exports = {
  createMutationContext,
  getRequestMutationContext,
  normalizeActorUserId,
  normalizeRequestId,
};
