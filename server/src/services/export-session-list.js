const { snapshotMetadata } = require('./export-history.service');
const { error } = require('./export-templates/snapshot-binding');

// Observational workspace metadata. No proof/key, live evaluation or lock inference.
// Kept in the list statement so membership and all projections share its MVCC view.
const workspaceColumns = `
  a.state AS attempt_state, a.configuration_revision AS attempt_revision,
  a.prepared_at, a.started_at, a.finished_at, a.last_error_code,
  a.preview_summary->'template' AS attempt_template,
  COALESCE(a.preview_summary->'template', CASE WHEN v.id IS NOT NULL THEN
    jsonb_build_object('templateId',v.template_id,'versionId',v.id,'displayName',t.display_name,'versionNumber',v.version_number::text) END) AS recipe_template,
  1 + members.accepted_count AS participant_count, members.pending_count,
  GREATEST(s.created_at,s.updated_at,members.activity_at,attempts.activity_at,events.activity_at,p.confirmed_at) AS recorded_activity_at,
  CASE WHEN p.id IS NULL THEN NULL ELSE to_jsonb(p) END AS stored_snapshot,
  COALESCE(artifacts.items,'[]'::jsonb) AS stored_artifacts`;

const workspaceJoins = `
  LEFT JOIN export_session_attempts a ON a.id=s.current_attempt_id
  LEFT JOIN export_template_versions v ON v.id=COALESCE(a.preview_summary->'template'->>'versionId',s.settings->'selection'->>'versionId')
  LEFT JOIN export_templates t ON t.id=v.template_id
  LEFT JOIN LATERAL (SELECT id,status,generated_at,confirmed_at,created_by_user_id::text,confirmed_by_user_id::text,
    row_count,file_name,from_sku,to_sku,resolved_to_sku,exported_to_product_id,
    request_contract,binding_evidence,input_fingerprint,export_session_id,
    CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('displayName',t.display_name,'versionNumber',v.version_number::text) END AS template_label
    FROM export_snapshots WHERE id=s.snapshot_id) p ON TRUE
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('groupCode',group_code,'profileVersion',profile_version,
    'fileName',file_name,'productCount',product_count,'rowCount',row_count) ORDER BY group_code) AS items
    FROM magento_export_artifacts WHERE snapshot_id=s.snapshot_id) artifacts ON TRUE
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE state='accepted')::int AS accepted_count,
    count(*) FILTER (WHERE state='pending')::int AS pending_count,
    max(GREATEST(invited_at,accepted_at,ended_at)) AS activity_at FROM export_session_members WHERE session_id=s.id) members ON TRUE
  LEFT JOIN LATERAL (SELECT max(GREATEST(prepared_at,started_at,finished_at)) AS activity_at
    FROM export_session_attempts WHERE session_id=s.id) attempts ON TRUE
  LEFT JOIN LATERAL (SELECT max(occurred_at) AS activity_at FROM audit_events
    WHERE subject_type='export_session' AND subject_id=s.id) events ON TRUE`;

function workspaceMetadata(s) {
  return {
    template: s.recipe_template || s.attempt_template || null,
    participantCount: s.participant_count, pendingInvitationCount: s.pending_count,
    lastRecordedActivityAt: s.recorded_activity_at,
    attempt: s.current_attempt_id ? { id: s.current_attempt_id, configurationRevision: s.attempt_revision,
      state: s.attempt_state, preparedAt: s.prepared_at, startedAt: s.started_at,
      finishedAt: s.finished_at, lastErrorCode: s.last_error_code } : null,
    // The UX-3 identity/status/metadata contract is the sole stored-result model.
    snapshot: s.stored_snapshot ? snapshotMetadata({ ...s.stored_snapshot,
      generated_at: new Date(s.stored_snapshot.generated_at),
      confirmed_at: s.stored_snapshot.confirmed_at ? new Date(s.stored_snapshot.confirmed_at) : null,
    }, 'product', s.stored_artifacts) : null,
  };
}

function recentPage(input, scope) {
  const invalid = () => error(422, 'EXPORT_PAGE_INVALID', 'Некоректна сторінка.');
  const limit = Number(input.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  let after = null;
  if (input.after) {
    try {
      if (typeof input.after !== 'string' || input.after.length > 1024) throw invalid();
      after = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
      if (after.order !== 'recent' || after.scope !== scope
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(after.time) || !Number.isFinite(Date.parse(after.time))
        || typeof after.id !== 'string' || !/^[a-f0-9-]{36}$/.test(after.id)) throw invalid();
    } catch { throw invalid(); }
  }
  return { limit, after };
}
const recentCursor = (row, scope) => Buffer.from(JSON.stringify({ order: 'recent', scope, time: row.cursor_time, id: row.id })).toString('base64url');
module.exports = { workspaceColumns, workspaceJoins, workspaceMetadata, recentPage, recentCursor };
