const EVENT_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SUBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertEventKey(value) {
  if (typeof value !== 'string' || !EVENT_KEY_PATTERN.test(value)) {
    throw new TypeError('Audit event key is invalid');
  }
  return value;
}

function assertSubjectType(value) {
  if (typeof value !== 'string' || !SUBJECT_TYPE_PATTERN.test(value)) {
    throw new TypeError('Audit subject type is invalid');
  }
  return value;
}

function assertSubjectId(value) {
  const subjectId = String(value ?? '').trim();
  if (!subjectId || subjectId.length > 256) {
    throw new TypeError('Audit subject ID is invalid');
  }
  return subjectId;
}

function assertDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Audit event details must be an object');
  }
  return value;
}

function snapshotProfileValue(value) {
  return typeof value === 'string' && value ? value : null;
}

async function writeAuditEvent(client, {
  mutationContext,
  eventKey,
  subjectType,
  subjectId,
  details = {},
}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction-scoped database client is required');
  }
  const actorUserId = mutationContext?.actorUserId;
  const requestId = mutationContext?.requestId ?? null;
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError('A valid mutation context is required');
  }

  const actorResult = await client.query(
    `SELECT display_name, preferred_username
     FROM application_users
     WHERE id = $1
     FOR KEY SHARE`,
    [actorUserId]
  );
  if (actorResult.rows.length !== 1) {
    throw new Error('Audit actor application user was not found');
  }
  const actor = actorResult.rows[0];
  const actorSnapshot = {
    displayName: snapshotProfileValue(actor.display_name),
    preferredUsername: snapshotProfileValue(actor.preferred_username),
  };

  const result = await client.query(
    `INSERT INTO audit_events
     (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, request_id, details)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb)
     RETURNING id, occurred_at`,
    [
      assertEventKey(eventKey),
      actorUserId,
      JSON.stringify(actorSnapshot),
      assertSubjectType(subjectType),
      assertSubjectId(subjectId),
      requestId,
      JSON.stringify(assertDetails(details)),
    ]
  );
  return result.rows[0];
}

module.exports = {
  writeAuditEvent,
};
