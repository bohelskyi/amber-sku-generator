const crypto = require('node:crypto');
const pool = require('../db/pool');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const published = require('./export-templates/published-capture');
const binding = require('./export-templates/snapshot-binding');
const access = require('./export-session-access');
const { workspaceColumns, workspaceJoins, workspaceMetadata, recentPage, recentCursor } = require('./export-session-list');
const signer = binding.makeSigner(require('../config/env').sessionSecret);
const exportsService = () => require('./export.service');
const normalize = (settings) => {
  if (!settings || settings.requestContract !== 'template-v1') throw binding.error(422, 'EXPORT_CONTRACT_INVALID', 'Сесії підтримують лише контрольований template-v1 експорт.');
  const result = binding.normalizeIntent(settings);
  if (JSON.stringify(result).length > 8192 || (result.mode === 'manual' && !result.fromSku)) throw binding.error(422, 'EXPORT_SETTINGS_INVALID', 'Вкажіть коректний діапазон.');
  return result;
};
function title(value) { if (typeof value !== 'string' || !value.trim() || value.length > 160 || value.includes('\0')) throw binding.error(422, 'EXPORT_TITLE_INVALID', 'Назва має містити 1–160 символів.'); return value.trim(); }
async function transaction(client, task) {
  await client.query('BEGIN');
  try { const result = await task(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function audit(client, context, id, action, details = {}) {
  await writeAuditEvent(client, { mutationContext: context, eventKey: `export_session.${action}`, subjectType: 'export_session', subjectId: id, details });
}
function summary(s) {
  return { id: s.id, title: s.title, ownerUserId: s.owner_user_id, ownerName: s.owner_name || s.owner_username,
    configurationRevision: s.configuration_revision, settings: s.settings, currentAttemptId: s.current_attempt_id,
    snapshotId: s.snapshot_id, createdAt: s.created_at, updatedAt: s.updated_at,
    isOwner: s.owner, accessEpoch: s.accessEpoch, template: s.attempt_template || null };
}
function attemptSummary(a, locked) {
  if (!a) return null;
  let preparationIssue = null;
  if (a.state === 'prepared') {
    try { signer.verify(a.preview_proof); }
    catch (error) { preparationIssue = error.code === 'EXPORT_PREVIEW_EXPIRED' ? 'expired' : 'unavailable'; }
  }
  return { id: a.id, configurationRevision: a.configuration_revision, state: a.state === 'executing' && locked ? 'interrupted' : a.state,
    preparationIssue,
    preparedByUserId: a.prepared_by_user_id, initiatedByUserId: a.initiated_by_user_id, preparedAt: a.prepared_at, startedAt: a.started_at,
    snapshotId: a.snapshot_id, lastErrorCode: a.last_error_code, preview: a.preview_summary };
}
async function createSession(input, options = {}) {
  const context = createMutationContext(options.mutationContext);
  const initial = { title: title(input.title), settings: normalize(input.settings) };
  const key = input.creationKey;
  if (typeof key !== 'string' || !key.trim() || key.length > 200) throw binding.error(422, 'EXPORT_CREATION_KEY_REQUIRED', 'Потрібен ключ створення.');
  const client = await (options.databasePool || pool).connect(); let authority = false;
  try {
    await published.protectAuthority(client, context.actorUserId, 'exports.view'); authority = true;
    await assertActorStillAuthorized(client, context.actorUserId, 'exports.create', binding.error);
    return await transaction(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`amber:export-session-create:${context.actorUserId}`, key]);
      const old = (await client.query('SELECT * FROM export_sessions WHERE owner_user_id=$1 AND creation_key=$2', [context.actorUserId, key])).rows[0];
      if (old) { if (binding.fingerprint(old.creation_intent) !== binding.fingerprint(initial)) throw access.conflict(); return summary({ ...old, owner: true, accessEpoch: 'owner' }); }
      if (initial.settings.selection.mode === 'explicit') await published.resolvePublished(client, initial.settings, context.actorUserId);
      const s = (await client.query(`INSERT INTO export_sessions(id,owner_user_id,creation_key,creation_intent,title,settings)
        VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb) RETURNING *`, [crypto.randomUUID(), context.actorUserId, key, JSON.stringify(initial), initial.title, JSON.stringify(initial.settings)])).rows[0];
      await audit(client, context, s.id, 'created');
      return summary({ ...s, owner: true, accessEpoch: 'owner' });
    });
  } finally { try { if (authority) await published.releaseAuthority(client); } finally { client.release(); } }
}
function pagination(input) {
  const limit = Number(input.limit ?? 20); const after = input.after || '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (after && !/^[a-f0-9-]{36}$/.test(after))) throw binding.error(422, 'EXPORT_PAGE_INVALID', 'Некоректна сторінка.');
  return { limit, after };
}
async function listSessions(input, options = {}) {
  const actor = createMutationContext(options.mutationContext).actorUserId;
  const db = options.databasePool || pool;
  await assertActorStillAuthorized(db, actor, 'exports.view', binding.error);
  const scope = input.scope || 'owned';
  if (!['owned','shared','invitations'].includes(scope)) throw binding.error(422, 'EXPORT_SCOPE_INVALID', 'Невідомий список.');
  if (input.order && !['recent', 'id'].includes(input.order)) throw binding.error(422, 'EXPORT_PAGE_INVALID', 'Некоректний порядок списку.');
  if (input.order === 'recent') {
    const { limit, after } = recentPage(input, scope);
    const result = await db.query(`WITH page AS (
      SELECT s.*, m.epoch FROM export_sessions s
      LEFT JOIN export_session_members m ON m.session_id=s.id AND m.user_id=$1
      WHERE (($2='owned' AND s.owner_user_id=$1) OR ($2='shared' AND m.state='accepted') OR ($2='invitations' AND m.state='pending'))
        AND EXISTS (SELECT 1 FROM application_users au JOIN user_role_assignments ar ON ar.application_user_id=au.id AND ar.revoked_at IS NULL
          JOIN roles r ON r.id=ar.role_id AND r.status='active' JOIN role_permissions rp ON rp.role_id=r.id AND rp.permission_key='exports.view'
          WHERE au.id=$1 AND au.status='active')
        AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3::timestamptz,$4::text))
      ORDER BY s.created_at DESC,s.id DESC LIMIT $5
    ) SELECT s.*, u.display_name AS owner_name,u.preferred_username AS owner_username,
      to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      ${scope === 'invitations' ? '' : `,${workspaceColumns}`}
      FROM page s JOIN application_users u ON u.id=s.owner_user_id
      ${scope === 'invitations' ? '' : workspaceJoins}
      ORDER BY s.created_at DESC,s.id DESC`, [actor, scope, after?.time || null, after?.id || null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    return { items: rows.map((s) => scope === 'invitations'
      ? { id: s.id, title: s.title, ownerUserId: s.owner_user_id, ownerName: s.owner_name || s.owner_username, accessEpoch: s.epoch, state: 'pending' }
      : { ...summary({ ...s, owner: String(s.owner_user_id) === String(actor), accessEpoch: String(s.owner_user_id) === String(actor) ? 'owner' : s.epoch }), ...workspaceMetadata(s) }),
    next: result.rows.length > limit ? recentCursor(rows.at(-1), scope) : null };
  }
  const { limit, after } = pagination(input);
  const result = await db.query(`SELECT s.*, u.display_name AS owner_name, u.preferred_username AS owner_username, m.epoch, m.state,
    a.preview_summary->'template' AS attempt_template
    FROM export_sessions s JOIN application_users u ON u.id=s.owner_user_id
    LEFT JOIN export_session_members m ON m.session_id=s.id AND m.user_id=$1
    LEFT JOIN export_session_attempts a ON a.id=s.current_attempt_id
    WHERE (($2='owned' AND s.owner_user_id=$1) OR ($2='shared' AND m.state='accepted') OR ($2='invitations' AND m.state='pending'))
    AND s.id > $3 ORDER BY s.id LIMIT $4`, [actor, scope, after, limit + 1]);
  const items = result.rows.slice(0, limit).map((s) => scope === 'invitations'
    ? { id: s.id, title: s.title, ownerUserId: s.owner_user_id, ownerName: s.owner_name || s.owner_username, accessEpoch: s.epoch, state: 'pending' }
    : summary({ ...s, owner: String(s.owner_user_id) === String(actor), accessEpoch: String(s.owner_user_id) === String(actor) ? 'owner' : s.epoch }));
  return { items, next: result.rows.length > limit ? items.at(-1).id : null };
}
async function detail(id, options = {}) {
  return access.withSession(id, { ...options, tryLock: true }, async (client, s, { locked }) => {
    const a = s.current_attempt_id ? (await client.query('SELECT * FROM export_session_attempts WHERE id=$1', [s.current_attempt_id])).rows[0] : null;
    const members = (await client.query(`SELECT m.user_id, m.state, m.epoch, m.invited_at, m.accepted_at, m.ended_at,
      u.display_name, u.preferred_username FROM export_session_members m JOIN application_users u ON u.id=m.user_id WHERE m.session_id=$1
      ORDER BY (m.state IN ('pending','accepted')) DESC,m.invited_at DESC,m.user_id LIMIT 100`, [id])).rows;
    const projection = (await client.query(`SELECT s.current_attempt_id,${workspaceColumns}
      FROM export_sessions s ${workspaceJoins} WHERE s.id=$1`, [id])).rows[0];
    return { ...summary(s), ...workspaceMetadata(projection), attempt: attemptSummary(a, locked), participants: members, executing: !locked };
  });
}
function commandOptions(input, options, write = true) { return { ...options, write, mutate: true, expectedAccessEpoch: input.expectedAccessEpoch }; }
function checkRevision(s, input) { if (s.configuration_revision !== access.revision(input.expectedRevision)) throw access.conflict(); }
async function supersede(client, s) {
  if (s.current_attempt_id) await client.query("UPDATE export_session_attempts SET state='superseded',finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND state <> 'superseded'", [s.current_attempt_id]);
}
async function saveSession(id, input, options = {}) {
  const settings = normalize(input.settings); const name = title(input.title);
  return access.withSession(id, commandOptions(input, options), (client, s, { context }) => transaction(client, async () => {
    checkRevision(s, input); if (s.snapshot_id) throw access.conflict('EXPORT_SESSION_FROZEN');
    if (name === s.title && binding.fingerprint(settings) === binding.fingerprint(s.settings)) return summary(s);
    if (settings.selection.mode === 'explicit') await published.resolvePublished(client, settings, context.actorUserId);
    await supersede(client, s);
    const row = (await client.query(`UPDATE export_sessions SET title=$2,settings=$3::jsonb,configuration_revision=configuration_revision+1,
      current_attempt_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id, name, JSON.stringify(settings)])).rows[0];
    await audit(client, context, id, 'updated', { revision: row.configuration_revision });
    return summary({ ...s, ...row });
  }));
}
async function previewSession(id, options = {}) {
  return access.withSession(id, options, async (_client, s, { databasePool }) => {
    if (s.snapshot_id) throw access.conflict('EXPORT_SESSION_FROZEN');
    return { ...await exportsService().previewExport(s.settings, { ...options, databasePool }), configurationRevision: s.configuration_revision };
  });
}
async function prepare(id, input, options = {}) {
  return access.withSession(id, commandOptions(input, options), async (client, s, { context, databasePool }) => {
    checkRevision(s, input); if (s.snapshot_id) throw access.conflict('EXPORT_SESSION_FROZEN');
    if (s.current_attempt_id && !input.supersedeAttemptId) {
      const attempt = (await client.query('SELECT * FROM export_session_attempts WHERE id=$1', [s.current_attempt_id])).rows[0];
      if (input.expectedPreviewFingerprint !== undefined && input.expectedPreviewFingerprint !== binding.fingerprint(attempt.binding_evidence)) throw binding.stale();
      return attemptSummary(attempt, true);
    }
    if (input.supersedeAttemptId && input.supersedeAttemptId !== s.current_attempt_id) throw access.conflict('EXPORT_ATTEMPT_CHANGED');
    const p = await exportsService().previewExport(s.settings, { ...options, databasePool });
    if (input.expectedPreviewFingerprint !== undefined && input.expectedPreviewFingerprint !== p.tableFingerprint) throw binding.stale();
    if (!p.previewToken) return { state: 'not-ready', preview: { ...p, previewToken: undefined } };
    const evidence = signer.verify(p.previewToken);
    // Store only bounded readiness/range/provenance, not the product projection.
    const safePreview = { mode: p.mode, range: p.range, representedCount: p.representedCount, readyCount: p.readyCount,
      errors: [], artifacts: p.artifacts.map((a) => ({ groupCode: a.groupCode, groupName: a.groupName, profileVersion: a.profileVersion, fileName: a.fileName, productCount: a.productCount, rowCount: a.rowCount })), template: p.template, requestContract: 'template-v1', tableFingerprint: p.tableFingerprint };
    const label = (await client.query(`SELECT t.display_name, v.version_number FROM export_template_versions v
      JOIN export_templates t ON t.id=v.template_id WHERE v.id=$1`, [p.template.versionId])).rows[0];
    safePreview.template = { ...safePreview.template, displayName: label.display_name, versionNumber: label.version_number };
    return transaction(client, async () => {
      await supersede(client, s);
      const a = (await client.query(`INSERT INTO export_session_attempts(id,session_id,configuration_revision,prepared_by_user_id,request_intent,binding_evidence,preview_proof,preview_summary,idempotency_key)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9) RETURNING *`, [crypto.randomUUID(), id, s.configuration_revision, context.actorUserId,
        JSON.stringify(s.settings), JSON.stringify(evidence), p.previewToken, JSON.stringify(safePreview), crypto.randomUUID()])).rows[0];
      await client.query('UPDATE export_sessions SET current_attempt_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [id, a.id]);
      await audit(client, context, id, 'prepared', { attemptId: a.id, revision: s.configuration_revision });
      return { ...attemptSummary(a, true), preview: { ...safePreview, artifacts: p.artifacts, review: p.review, checkedAt: p.checkedAt, configurationRevision: s.configuration_revision } };
    });
  });
}
async function generate(id, input, options = {}) {
  return access.withSession(id, commandOptions(input, options), async (client, s, { context, databasePool }) => {
    checkRevision(s, input);
    if (s.current_attempt_id !== input.attemptId) throw access.conflict('EXPORT_ATTEMPT_CHANGED');
    const a = (await client.query('SELECT * FROM export_session_attempts WHERE id=$1', [s.current_attempt_id])).rows[0];
    if (!a || a.state === 'superseded') throw access.conflict('EXPORT_ATTEMPT_CHANGED');
    if (s.snapshot_id) return exportsService().getExportSnapshot(s.snapshot_id, { ...options, databasePool });
    await transaction(client, async () => {
      await client.query("UPDATE export_session_attempts SET state='executing',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),initiated_by_user_id=COALESCE(initiated_by_user_id,$2),finished_at=NULL,last_error_code=NULL WHERE id=$1", [a.id, context.actorUserId]);
      if (a.state !== 'executing') await audit(client, context, id, 'started', { attemptId: a.id });
    });
    try {
      return await exportsService().createExportSnapshot({ ...a.request_intent, previewToken: a.preview_proof, idempotencyKey: a.idempotency_key }, {
        ...options, databasePool, sessionAttempt: { sessionId: id, attemptId: a.id },
        linkSessionResult: async (tx, snapshot) => {
          await tx.query("UPDATE export_session_attempts SET state='succeeded',snapshot_id=$2,finished_at=CURRENT_TIMESTAMP WHERE id=$1", [a.id, snapshot.id]);
          await tx.query('UPDATE export_sessions SET snapshot_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [id, snapshot.id]);
          await audit(tx, context, id, 'generated', { attemptId: a.id, snapshotId: snapshot.id });
        },
      });
    } catch (error) {
      // Core capture has rolled back before this point; session lock still fences
      // every other worker. A lost COMMIT response is reconciled by a fresh read.
      const committed = (await client.query('SELECT snapshot_id FROM export_sessions WHERE id=$1', [id])).rows[0];
      if (committed.snapshot_id) return exportsService().getExportSnapshot(committed.snapshot_id, { ...options, databasePool });
      await transaction(client, () => client.query("UPDATE export_session_attempts SET state='failed',last_error_code=$2,finished_at=CURRENT_TIMESTAMP WHERE id=$1", [a.id, String(error.publicCode || error.code || 'EXPORT_CAPTURE_FAILED').slice(0,100)]));
      throw error;
    }
  });
}
async function recipients(id, input, options = {}) {
  const q = String(input.q || '').trim(); if (q.length < 2 || q.length > 80) return { users: [] };
  return access.withSession(id, { ...options, write: true, ownerOnly: true }, async (client, _s, { context }) => ({ users: (await client.query(`SELECT id,display_name,preferred_username FROM application_users
    WHERE status='active' AND id<>$1 AND (strpos(lower(COALESCE(display_name,'')),lower($2))>0 OR strpos(lower(COALESCE(preferred_username,'')),lower($2))>0)
    ORDER BY id LIMIT 20`, [context.actorUserId, q])).rows }));
}
async function invite(id, input, options = {}) {
  const userId = String(input.userId || ''); if (!/^[1-9][0-9]{0,15}$/.test(userId)) throw binding.error(422, 'EXPORT_RECIPIENT_INVALID', 'Оберіть користувача.');
  return access.withSession(id, { ...commandOptions(input, options), ownerOnly: true }, (client, s, { context }) => transaction(client, async () => {
    if (String(s.owner_user_id) === userId) throw binding.error(422, 'EXPORT_RECIPIENT_INVALID', 'Власник уже має доступ.');
    const u = (await client.query("SELECT id FROM application_users WHERE id=$1 AND status='active'", [userId])).rows[0]; if (!u) throw binding.error(422, 'EXPORT_RECIPIENT_INVALID', 'Користувач недоступний.');
    const old = (await client.query('SELECT * FROM export_session_members WHERE session_id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (old && ['pending','accepted'].includes(old.state)) return { state: old.state, epoch: old.epoch };
    if ((await client.query("SELECT count(*)::int n FROM export_session_members WHERE session_id=$1 AND state IN ('pending','accepted')", [id])).rows[0].n >= 100) throw binding.error(422, 'EXPORT_MEMBERS_LIMIT', 'До 100 запрошених або прийнятих учасників.');
    const m = (await client.query(`INSERT INTO export_session_members(session_id,user_id,state,invited_by_user_id) VALUES($1,$2,'pending',$3)
      ON CONFLICT(session_id,user_id) DO UPDATE SET state='pending',epoch=export_session_members.epoch+1,invited_by_user_id=$3,invited_at=CURRENT_TIMESTAMP,accepted_at=NULL,ended_at=NULL,ended_by_user_id=NULL RETURNING *`, [id, userId, context.actorUserId])).rows[0];
    await audit(client, context, id, 'invited', { userId, epoch: m.epoch }); return { state: m.state, epoch: m.epoch };
  }));
}
async function membership(id, input, options = {}) {
  const action = input.action; if (!['accept','decline','leave','revoke'].includes(action)) throw binding.error(422, 'EXPORT_MEMBERSHIP_ACTION_INVALID', 'Невідома дія.');
  const ownerAction = action === 'revoke';
  return access.withSession(id, { ...commandOptions(input, options, ownerAction), target: !ownerAction, ownerOnly: ownerAction }, (client, s, { context }) => transaction(client, async () => {
    const target = ownerAction ? String(input.userId || '') : String(context.actorUserId);
    if (!/^[1-9][0-9]{0,15}$/.test(target) || target === String(s.owner_user_id)) throw access.missing();
    const m = (await client.query('SELECT * FROM export_session_members WHERE session_id=$1 AND user_id=$2', [id, target])).rows[0];
    if (!m) throw access.missing();
    if (ownerAction && m.epoch !== access.revision(input.expectedMemberEpoch)) throw access.conflict('EXPORT_MEMBERSHIP_CHANGED');
    const next = { accept: 'accepted', decline: 'declined', leave: 'left', revoke: 'revoked' }[action];
    if (m.state === next) return { state: m.state, epoch: m.epoch };
    if ((['accept','decline'].includes(action) && m.state !== 'pending') || (action === 'leave' && m.state !== 'accepted')) throw access.conflict('EXPORT_MEMBERSHIP_CHANGED');
    const changed = (await client.query(`UPDATE export_session_members SET state=$3,epoch=epoch+1,
      accepted_at=CASE WHEN $3='accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END,
      ended_at=CASE WHEN $3 IN ('left','revoked','declined') THEN CURRENT_TIMESTAMP ELSE NULL END,
      ended_by_user_id=CASE WHEN $3 IN ('left','revoked','declined') THEN $4::bigint ELSE NULL END
      WHERE session_id=$1 AND user_id=$2 RETURNING *`, [id, target, next, context.actorUserId])).rows[0];
    await audit(client, context, id, next, { userId: target, epoch: changed.epoch }); return { state: next, epoch: changed.epoch };
  }));
}
module.exports = { createSession, listSessions, detail, saveSession, previewSession, prepare, generate, recipients, invite, membership };
