const crypto = require('node:crypto');
const pool = require('../db/pool');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EVENT_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]*$/;
const SUBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const COMMON_DETAIL_KEYS = new Set([
  'addedPermissionKeys', 'affectedActiveUserCount', 'affectedCounts',
  'affectedDisabledUserCount', 'axisXKey', 'axisYKey', 'categoryCode',
  'changedCount', 'changedFields', 'changedQuestionIds', 'changes', 'code',
  'copiedMatrixCellCount', 'copiedWeightBandCount', 'correctedSku', 'displayName',
  'exportedToProductId', 'factor', 'fromSku', 'fullSku', 'groupName', 'key', 'label',
  'name', 'newDisplayName', 'newPrice', 'newRole', 'newStatus', 'oldPrice',
  'permissionKeys', 'previousCode', 'previousDisplayName', 'previousOwnerUserId',
  'previousRole', 'previousStatus', 'priceMode', 'proposedSku', 'questionId',
  'questionKey', 'requiresWeight', 'role', 'roleKey', 'rowCount', 'scenarioId',
  'scenarioName', 'scope', 'skipHiddenSkuQuestions', 'skuCode', 'sourceScenarioId',
  'sourceSku', 'status', 'toSku', 'triggerKey', 'triggerValue', 'userStatus',
  'valueId', 'version', 'versionFrom', 'versionTo', 'weightBandChanges',
  'weightBandCount', 'xValue', 'yValue', 'removedPermissionKeys', 'reason',
]);

const KNOWN_EVENT_PREFIXES = new Set([
  'application_user', 'catalog', 'correction_request', 'export_snapshot',
  'pricing', 'product', 'repricing', 'repricing_draft', 'role', 'sku_schema',
]);

const SENSITIVE_DETAIL_KEY_PATTERN = /(token|secret|session|request[_]?id|claim|hash|issuer|oidc|subject)/i;

class AuditViewerError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AuditViewerError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function badRequest(code, message) {
  throw new AuditViewerError(400, code, message);
}

function normalizeOptionalString(value, { field, pattern, maxLength = 256 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') badRequest(`INVALID_${field.toUpperCase()}`, `${field} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || (pattern && !pattern.test(normalized))) {
    badRequest(`INVALID_${field.toUpperCase()}`, `${field} is invalid`);
  }
  return normalized;
}

function normalizeDate(value, field) {
  const normalized = normalizeOptionalString(value, { field, maxLength: 64 });
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    badRequest(`INVALID_${field.toUpperCase()}`, `${field} must be an ISO timestamp with a timezone`);
  }
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) badRequest(`INVALID_${field.toUpperCase()}`, `${field} is invalid`);
  return date.toISOString();
}

function normalizePositiveInteger(value, field, { optional = true } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !POSITIVE_INTEGER_PATTERN.test(normalized)) {
    badRequest(`INVALID_${field.toUpperCase()}`, `${field} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) badRequest(`INVALID_${field.toUpperCase()}`, `${field} must be a positive integer`);
  return parsed;
}

function normalizeAuditFilters(query = {}) {
  const filters = {
    from: normalizeDate(query.from, 'from'),
    to: normalizeDate(query.to, 'to'),
    eventKey: normalizeOptionalString(query.eventKey, {
      field: 'eventKey', pattern: EVENT_KEY_PATTERN, maxLength: 160,
    }),
    domain: normalizeOptionalString(query.domain, {
      field: 'domain', pattern: DOMAIN_PATTERN, maxLength: 80,
    }),
    actorId: normalizePositiveInteger(query.actorId, 'actorId'),
    subjectType: normalizeOptionalString(query.subjectType, {
      field: 'subjectType', pattern: SUBJECT_TYPE_PATTERN, maxLength: 80,
    }),
    subjectId: normalizeOptionalString(query.subjectId, { field: 'subjectId', maxLength: 256 }),
  };
  if (filters.from && filters.to && filters.from > filters.to) {
    badRequest('INVALID_DATE_RANGE', 'from must not be after to');
  }
  if (filters.eventKey && filters.domain && !filters.eventKey.startsWith(`${filters.domain}.`)) {
    badRequest('CONFLICTING_EVENT_FILTERS', 'eventKey does not belong to domain');
  }
  if (filters.subjectId && !filters.subjectType) {
    badRequest('SUBJECT_TYPE_REQUIRED', 'subjectType is required with subjectId');
  }
  return filters;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
  return Math.min(normalizePositiveInteger(value, 'limit', { optional: false }), MAX_PAGE_SIZE);
}

function filterFingerprint(filters) {
  return crypto.createHash('sha256').update(JSON.stringify(filters)).digest('base64url').slice(0, 24);
}

function encodeCursor(row, filters) {
  return Buffer.from(JSON.stringify({
    occurredAt: new Date(row.occurred_at).toISOString(),
    id: String(row.id),
    filter: filterFingerprint(filters),
  })).toString('base64url');
}

function decodeCursor(value, filters) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    badRequest('INVALID_CURSOR', 'cursor is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed || typeof parsed !== 'object'
      || typeof parsed.occurredAt !== 'string'
      || !POSITIVE_INTEGER_PATTERN.test(String(parsed.id || ''))
      || parsed.filter !== filterFingerprint(filters)
    ) badRequest('INVALID_CURSOR', 'cursor is invalid or does not match the filters');
    const date = new Date(parsed.occurredAt);
    if (!Number.isFinite(date.getTime())) badRequest('INVALID_CURSOR', 'cursor is invalid');
    return { occurredAt: date.toISOString(), id: String(parsed.id) };
  } catch (error) {
    if (error instanceof AuditViewerError) throw error;
    badRequest('INVALID_CURSOR', 'cursor is invalid');
  }
}

function safeDetailValue(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeDetailValue(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || SENSITIVE_DETAIL_KEY_PATTERN.test(key)) return [];
    return [[key, safeDetailValue(item, depth + 1)]];
  }));
}

function normalizeDetails(eventKey, details) {
  const domain = String(eventKey || '').split('.')[0];
  if (!KNOWN_EVENT_PREFIXES.has(domain) || !details || typeof details !== 'object' || Array.isArray(details)) {
    return {};
  }
  return Object.fromEntries(Object.entries(details).flatMap(([key, value]) => (
    COMMON_DETAIL_KEYS.has(key) && !SENSITIVE_DETAIL_KEY_PATTERN.test(key)
      ? [[key, safeDetailValue(value)]]
      : []
  )));
}

function normalizeActor(row) {
  const snapshot = row.actor_snapshot && typeof row.actor_snapshot === 'object'
    ? row.actor_snapshot
    : {};
  if (row.actor_user_id === null || row.actor_user_id === undefined) {
    return { status: 'not_recorded', id: null, displayName: null, preferredUsername: null };
  }
  const displayName = typeof snapshot.displayName === 'string' && snapshot.displayName
    ? snapshot.displayName
    : null;
  const preferredUsername = typeof snapshot.preferredUsername === 'string' && snapshot.preferredUsername
    ? snapshot.preferredUsername
    : null;
  return {
    status: displayName || preferredUsername ? 'recorded' : 'recorded_reference',
    id: Number(row.actor_user_id),
    displayName,
    preferredUsername,
  };
}

function normalizeAuditEvent(row) {
  const eventKey = String(row.event_key);
  return {
    eventKey,
    domain: eventKey.split('.')[0],
    occurredAt: new Date(row.occurred_at).toISOString(),
    actor: normalizeActor(row),
    subject: { type: String(row.subject_type), id: String(row.subject_id) },
    details: normalizeDetails(eventKey, row.details),
  };
}

async function getAuditEvents(query = {}, { databasePool = pool } = {}) {
  const filters = normalizeAuditFilters(query);
  const limit = normalizeLimit(query.limit);
  const cursor = decodeCursor(query.cursor, filters);
  const values = [];
  const where = [];
  const add = (value) => { values.push(value); return `$${values.length}`; };

  if (filters.from) where.push(`occurred_at >= ${add(filters.from)}::timestamptz`);
  if (filters.to) where.push(`occurred_at <= ${add(filters.to)}::timestamptz`);
  if (filters.eventKey) where.push(`event_key = ${add(filters.eventKey)}`);
  else if (filters.domain) where.push(`event_key LIKE ${add(`${filters.domain}.%`)}`);
  if (filters.actorId) where.push(`actor_user_id = ${add(filters.actorId)}`);
  if (filters.subjectType) where.push(`subject_type = ${add(filters.subjectType)}`);
  if (filters.subjectId) where.push(`subject_id = ${add(filters.subjectId)}`);
  if (cursor) {
    const occurredAtParam = add(cursor.occurredAt);
    const idParam = add(cursor.id);
    where.push(`(occurred_at, id) < (${occurredAtParam}::timestamptz, ${idParam}::bigint)`);
  }
  const limitParam = add(limit + 1);
  const result = await databasePool.query(
    `SELECT id, event_key, actor_user_id, actor_snapshot, subject_type, subject_id,
            details, occurred_at
     FROM audit_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${limitParam}`,
    values
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  return {
    items: pageRows.map(normalizeAuditEvent),
    page: {
      limit,
      hasMore,
      nextCursor: hasMore ? encodeCursor(pageRows.at(-1), filters) : null,
    },
    filters,
  };
}

module.exports = {
  AuditViewerError,
  MAX_PAGE_SIZE,
  decodeCursor,
  getAuditEvents,
  normalizeAuditEvent,
  normalizeAuditFilters,
  normalizeDetails,
};
