const pool = require('../../db/pool');
const { originHash } = require('./binding-contract');
const { problemSelectSql, problemJoinSql, presentProblemRow, presentProblem, normalizePageValue } = require('./sync-problems');

// One local statement supplies counts and pages from the same database snapshot.
// Grouping is presentation only: every member keeps its exact product and original
// operation; this module has no remote access or mutation entry point.
function queryContext(config, query) {
  const values = [config.configured ? originHash(config.baseUrl) : 'unconfigured'];
  const limit = Math.max(1, normalizePageValue(query.limit, 20, 100));
  const offset = normalizePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const category = String(query.category || '').trim().slice(0, 40);
  const search = String(query.search || '').trim().slice(0, 120);
  const reason = String(query.reason || '');
  if (reason && !['recovery', 'names', 'product', 'connection', 'integration'].includes(reason)) {
    const error = new Error('Невідомий тип проблеми.'); error.statusCode = 422; throw error;
  }
  let filter = "WHERE (r.state='needs_attention' OR (d.state<>'finalized' AND d.product_id=p.id))";
  if (category) filter += ` AND p.category=$${values.push(category)}`;
  if (search) filter += ` AND i.public_sku ILIKE $${values.push('%' + search.replace(/[\\%_]/g, '\\$&') + '%')} ESCAPE '\\'`;
  const reasonFilter = reason ? `WHERE reason_group=$${values.push(reason)}` : '';
  const sql = `WITH queue AS (
    ${problemSelectSql.replace('SELECT p.id', 'SELECT i.id AS identity_id,p.id')} ${problemJoinSql} ${filter}
  ), expanded AS (
    SELECT q.*, problem FROM queue q CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN q.reason_code IN ('reconciliation_required','TEST_DELETION_PENDING') THEN jsonb_build_array(jsonb_build_object('code',q.reason_code))
        WHEN q.diagnostics @> '[{"code":"MAGENTO_NATIVE_IDENTITY_COLLISION"}]'::jsonb
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(q.diagnostics,'[]')) f WHERE f->>'code' LIKE 'FIRST_SYNC_%') THEN q.diagnostics
        WHEN q.name_state IN ('conflict','baseline_required') THEN jsonb_build_array(jsonb_build_object('code',CASE WHEN q.name_state='conflict' THEN 'NAME_CONFLICT' ELSE 'NAME_BASELINE_REQUIRED' END))
        WHEN jsonb_array_length(COALESCE(q.diagnostics,'[]'))>0 THEN q.diagnostics
        ELSE jsonb_build_array(jsonb_build_object('code',COALESCE(q.reason_code,'data_or_binding'))) END) problem
  ), classified AS (
    SELECT *, CASE WHEN problem->>'code' IN ('reconciliation_required','TEST_DELETION_PENDING','AMBER_SYNC_ELIGIBILITY_UNRESOLVED','LIFECYCLE_HISTORICAL_AMBIGUITY') THEN 'recovery'
      WHEN problem->>'code' LIKE 'NAME_%' THEN 'names'
      WHEN problem->>'code' IN ('PRODUCT_EVALUATION_NOT_READY','REQUIRED_ATTRIBUTE_VALUE_MISSING','REQUIRED_NATIVE_FIELD_MISSING') THEN 'product'
      WHEN problem->>'code' IN ('authorization','configuration') THEN 'connection' ELSE 'integration' END AS reason_group,
      CASE WHEN COALESCE(problem->>'diagnosticCode',problem->>'code') IN ('OPTION_BINDING_REVIEW_REQUIRED','OPTION_MAPPING_REVIEW_REQUIRED','OPTION_UNRESOLVED','option_mapping_required','option_missing')
        AND problem->'causeContext'->>'kind'='semantic_option'
        AND problem->'causeContext'->>'category'=category
        AND problem->'causeContext'->>'target'=COALESCE(problem->>'target',problem->>'field')
        AND problem->'causeContext'->>'bindingRevisionId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND length(problem->'causeContext'->>'routeKey') BETWEEN 1 AND 160
        AND length(problem->'causeContext'->>'question') BETWEEN 1 AND 160
        AND length(problem->'causeContext'->>'value') BETWEEN 1 AND 500
        THEN problem->'causeContext' ELSE NULL END AS shared_context
    FROM expanded
  ), members AS (
    SELECT *, md5(jsonb_build_array(problem->>'code',problem->>'diagnosticCode',problem->>'target',problem->>'field',
      problem->>'scope',problem->>'reason',problem->>'path',problem->>'routeKey',shared_context)::text) AS group_id FROM classified ${reasonFilter}
  )`;
  return { sql, values, limit, offset };
}
function pageInfo(limit, offset, total, length) {
  return { limit, offset, total, hasPrevious: offset > 0, hasNext: offset + length < total };
}
async function groupPage(config, query = {}, db = pool) {
  const { sql, values, limit, offset } = queryContext(config, query);
  const response = (await db.query(`${sql}, grouped AS (
    SELECT group_id,count(DISTINCT identity_id)::int AS product_count,count(*)::int AS diagnostic_count,
      (array_agg(to_jsonb(m) ORDER BY "productId"))[1] AS sample FROM members m GROUP BY group_id
  ), page AS (SELECT * FROM grouped ORDER BY product_count DESC,group_id LIMIT $${values.length + 1} OFFSET $${values.length + 2})
  SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY product_count DESC,group_id),'[]') FROM page) AS items,
    (SELECT count(*)::int FROM grouped) AS total,(SELECT count(DISTINCT identity_id)::int FROM members) AS product_count,
    (SELECT count(*)::int FROM members) AS diagnostic_count,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]') FROM (SELECT category AS code,max(category_name) AS name,count(DISTINCT identity_id)::int AS count FROM queue GROUP BY category ORDER BY category) c) AS categories,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM (SELECT reason_group AS reason,count(DISTINCT identity_id)::int AS count FROM members GROUP BY reason_group ORDER BY reason_group) r) AS reason_counts`,
  [...values, limit, offset])).rows[0];
  const items = (response?.items || []).map(row => ({ id: row.group_id, productCount: row.product_count,
    diagnosticCount: row.diagnostic_count, sharedConfiguration: Boolean(row.sample.shared_context),
    problem: presentProblem(row.sample.problem, row.sample.lifecycle),
    exampleProduct: { productId: row.sample.productId, article: row.sample.article, category: row.sample.category },
  }));
  return { items, pageInfo: pageInfo(limit, offset, Number(response?.total || 0), items.length),
    summary: { productCount: Number(response?.product_count || 0), diagnosticCount: Number(response?.diagnostic_count || 0), reasonCounts: response?.reason_counts || [] },
    categories: response?.categories || [] };
}
async function groupProducts(config, groupId, query = {}, db = pool) {
  if (!/^[0-9a-f]{32}$/.test(groupId || '')) { const error = new Error('Некоректна група проблем.'); error.statusCode = 422; throw error; }
  const { sql, values, limit, offset } = queryContext(config, query);
  values.push(groupId);
  const response = (await db.query(`${sql}, selected AS (
    SELECT DISTINCT ON (identity_id) * FROM members WHERE group_id=$${values.length} ORDER BY identity_id,"productId"
  ), page AS (SELECT * FROM selected ORDER BY "productId" LIMIT $${values.length + 1} OFFSET $${values.length + 2})
  SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY "productId"),'[]') FROM page) AS items,
    (SELECT count(*)::int FROM selected) AS total`, [...values, limit, offset])).rows[0];
  const items = (response?.items || []).map(row => ({ ...presentProblemRow(row), groupProblem: presentProblem(row.problem, row.lifecycle) }));
  return { items, pageInfo: pageInfo(limit, offset, Number(response?.total || 0), items.length) };
}
module.exports = { groupPage, groupProducts };
