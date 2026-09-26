const pool = require('../db/pool');
const { manifestProvenance } = require('./export-templates/snapshot-binding');

function snapshotMetadata(snapshot, stream, artifacts = snapshot.artifacts || []) {
  const price = stream === 'price';
  return {
    stream, id: snapshot.id, status: snapshot.status,
    generatedAt: snapshot.generated_at, confirmedAt: snapshot.confirmed_at,
    createdByUserId: snapshot.created_by_user_id ?? null,
    confirmedByUserId: snapshot.confirmed_by_user_id ?? null,
    rowCount: Number(snapshot.row_count), productCount: Number(snapshot.row_count),
    csvRowCount: price ? Number(snapshot.row_count) : artifacts.length ? artifacts.reduce((n, a) => n + Number(a.rowCount), 0) : null,
    fileName: snapshot.file_name,
    capturedRange: price ? null : { fromSku: snapshot.from_sku, toSku: snapshot.to_sku,
      resolvedToSku: snapshot.resolved_to_sku, exportedToProductId: snapshot.exported_to_product_id },
    artifacts: price ? [{ groupCode: 'prices', fileName: snapshot.file_name,
      rowCount: Number(snapshot.row_count), productCount: Number(snapshot.row_count), profileVersion: 'sku,price' }] : artifacts,
    ...(snapshot.export_session_id ? { sessionId: snapshot.export_session_id,
      ...(snapshot.session_access_epoch ? { accessEpoch: snapshot.session_access_epoch } : {}) } : {}),
    recipe: price ? { kind: 'price', name: 'Оновлення цін', outputContract: 'sku,price' }
      : snapshot.request_contract === 'template-v1' ? { kind: 'template' }
        : artifacts.length ? { kind: 'system', name: 'Системний профіль', outputContract: artifacts[0].profileVersion }
          : { kind: 'historical', name: 'Немає даних про профіль Magento' },
    ...(snapshot.template_label ? { templateLabel: snapshot.template_label } : {}),
    ...manifestProvenance(snapshot),
  };
}

function historyQuery(input = {}) {
  const invalid = () => Object.assign(new Error('Некоректні фільтри або сторінка історії.'), { statusCode: 422 });
  const stream = input.stream || 'all'; const scope = input.scope || 'accessible'; const status = input.status || 'all';
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!['all', 'product', 'price'].includes(stream) || !['accessible', 'mine'].includes(scope)
    || !['all', 'generated', 'confirmed'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  let after = null;
  if (input.after !== undefined) {
    try {
      if (typeof input.after !== 'string' || input.after.length > 1024) throw invalid();
      after = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
      if (after.streamFilter !== stream || after.scope !== scope || after.status !== status
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(after.time)
        || !Number.isFinite(Date.parse(after.time)) || typeof after.id !== 'string' || !after.id.length || after.id.length > 200
        || !['price', 'product'].includes(after.stream)) throw invalid();
    } catch { throw invalid(); }
  }
  return { stream, scope, status, limit, after };
}

async function getExportHistory(input, options = {}) {
  const q = historyQuery(input); const actor = options.mutationContext?.actorUserId ?? null;
  // Same owner/accepted predicate as assertSnapshotAccess; no administrator bypass.
  // One statement, no audit lookup or mutable session/activity pagination.
  const result = await (options.databasePool || pool).query(`WITH authority AS (
    SELECT u.id FROM application_users u WHERE u.id=$1 AND u.status='active' AND EXISTS (
      SELECT 1 FROM user_role_assignments a JOIN roles r ON r.id=a.role_id AND r.status='active'
      JOIN role_permissions p ON p.role_id=r.id WHERE a.application_user_id=u.id
        AND a.revoked_at IS NULL AND p.permission_key='exports.view')
  ), accessible AS (
    SELECT 'product'::text AS stream, p.id, p.status, p.generated_at, p.confirmed_at,
      p.created_by_user_id, p.confirmed_by_user_id, p.row_count, p.file_name,
      p.from_sku, p.to_sku, p.resolved_to_sku, p.exported_to_product_id,
      p.request_contract, p.binding_evidence, p.input_fingerprint, p.template_version_id, p.export_session_id
    FROM export_snapshots p
    WHERE $2 IN ('all','product') AND (p.export_session_id IS NULL OR EXISTS (
      SELECT 1 FROM export_sessions s WHERE s.id=p.export_session_id AND
        (s.owner_user_id=$1 OR EXISTS (SELECT 1 FROM export_session_members m
          WHERE m.session_id=s.id AND m.user_id=$1 AND m.state='accepted'))))
    UNION ALL
    SELECT 'price', p.id, p.status, p.generated_at, p.confirmed_at, p.created_by_user_id,
      p.confirmed_by_user_id, p.row_count, p.file_name, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL FROM price_export_snapshots p WHERE $2 IN ('all','price')
  ), page AS (
    SELECT * FROM accessible p WHERE EXISTS (SELECT 1 FROM authority)
      AND ($3='accessible' OR p.created_by_user_id=$1)
      AND ($4='all' OR p.status=$4)
      AND ($5::timestamptz IS NULL OR (p.generated_at,p.id,p.stream)<($5::timestamptz,$6::text,$7::text))
    ORDER BY p.generated_at DESC,p.id DESC,p.stream DESC LIMIT $8
  ) SELECT p.*, to_char(p.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
    CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('displayName',t.display_name,'versionNumber',v.version_number::text) END AS template_label,
    COALESCE(a.artifacts,'[]'::jsonb) AS artifacts
    FROM page p LEFT JOIN export_template_versions v ON v.id=p.template_version_id
    LEFT JOIN export_templates t ON t.id=v.template_id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('groupCode',group_code,
      'profileVersion',profile_version,'fileName',file_name,'productCount',product_count,'rowCount',row_count)
      ORDER BY group_code) AS artifacts FROM magento_export_artifacts WHERE snapshot_id=p.id AND p.stream='product') a ON TRUE
    ORDER BY p.generated_at DESC,p.id DESC,p.stream DESC`,
  [actor, q.stream, q.scope, q.status, q.after?.time || null, q.after?.id || null, q.after?.stream || null, q.limit + 1]);
  const rows = result.rows.slice(0, q.limit); const last = rows.at(-1);
  return { items: rows.map((r) => snapshotMetadata(r, r.stream)), next: result.rows.length > q.limit
    ? Buffer.from(JSON.stringify({ time: last.cursor_time, id: last.id, stream: last.stream,
      streamFilter: q.stream, scope: q.scope, status: q.status })).toString('base64url') : null };
}
module.exports = { snapshotMetadata, historyQuery, getExportHistory };
