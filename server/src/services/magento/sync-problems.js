const pool = require('../../db/pool');
const { originHash } = require('./binding-contract');
const taxonomy = Object.freeze({
  TEST_DELETION_PENDING: 'Тестове видалення очікує підтвердження. Відкрийте товар і перевірте результат у дії «Видалити тестовий товар». Повторний DELETE після відправлення заборонено.',
  NAME_CONFLICT: 'Назву змінено і в Amber, і в Magento. Виберіть актуальну.',
  NAME_BASELINE_REQUIRED: 'Назви Amber і Magento відрізняються; спільну підтверджену назву ще не встановлено.',
  NAME_EXTERNAL_CHANGE_PENDING: 'Зовнішню зміну назви потрібно узгодити з Amber.',
  NAME_READ_UNAVAILABLE: 'Не вдалося прочитати назву Magento для перевірки.',
  NAME_REMOTE_IDENTITY_CHANGED: 'Ідентичність товару Magento відрізняється від підтвердженої.',
  ATTRIBUTE_NOT_FOUND: 'У Magento немає потрібної характеристики.',
  ATTRIBUTE_METADATA_UNRESOLVED: 'У Magento немає потрібної характеристики або її опис недоступний.',
  OPTION_UNRESOLVED: 'У Magento немає підтвердженого відповідного значення характеристики.',
  OPTION_BINDING_REVIEW_REQUIRED: 'Опція Magento існує, але зв’язок зі значенням Amber ще не підтверджено.',
  ATTRIBUTE_BINDING_REVIEW_REQUIRED: 'Зв’язок характеристики Amber із Magento ще не підтверджено.',
  attribute_missing: 'У Magento немає потрібної характеристики.',
  attribute_not_in_selected_set: 'Характеристика не входить до потрібного набору Magento.',
  ATTRIBUTE_NOT_IN_SELECTED_SET: 'Характеристика не входить до потрібного набору Magento.',
  option_missing: 'У Magento немає потрібного значення характеристики.',
  option_mapping_required: 'Зв’язок значення Amber із опцією Magento ще не підтверджено.',
  binding_review_required: 'Зв’язок характеристики з Magento ще не підтверджено.',
  OPTION_MAPPING_REVIEW_REQUIRED: 'Зв’язок значення Amber із опцією Magento ще не підтверджено.',
  CATEGORY_PATH_MISSING: 'Потрібної категорії Magento немає.',
  CATEGORY_IDENTITIES_REVIEW_REQUIRED: 'Категорія Magento існує, але зв’язок ще не підтверджено.',
  CATEGORY_MAPPING_BLOCKED: 'Зв’язок категорії Magento заблоковано.',
  CATEGORY_PATH_AMBIGUOUS: 'Знайдено кілька відповідних категорій Magento.',
  PRODUCT_ATTRIBUTE_SET_MISMATCH: 'Товар має інший набір характеристик Magento.',
  ATTRIBUTE_SET_DECISION_REQUIRED: 'Потрібно підтвердити набір характеристик Magento.',
  PRODUCT_EVALUATION_NOT_READY: 'Дані товару відсутні або некоректні.',
  REQUIRED_ATTRIBUTE_VALUE_MISSING: 'Не заповнено обов’язкову характеристику товару.',
  REQUIRED_NATIVE_FIELD_MISSING: 'Не заповнено обов’язкові дані товару.',
  BINDING_DRIFT_REVIEW_REQUIRED: 'Структура Magento змінилася; відповідності потрібно перевірити.',
  reconciliation_required: 'Amber надіслав зміну до Magento, але не зміг підтвердити кінцевий стан. Потрібна перевірка адміністратором; повторне надсилання недоступне.',
  data_or_binding: 'Потрібно перевірити дані товару або відповідності Magento.',
  configuration: 'Автоматичну синхронізацію потрібно налаштувати.',
  authorization: 'Потрібно перевірити доступ службового користувача.',
});
function safeDiagnostics(blockers = []) {
  return blockers.slice(0, 40).map((item) => ({ code: String(item.code || 'data_or_binding').slice(0, 100),
    ...Object.fromEntries(['target', 'field', 'path', 'routeKey', 'status'].filter((key) =>
      typeof item[key] === 'string' && item[key].length <= 500).map((key) => [key, item[key]])),
    ...(item.diagnostic?.code ? { diagnosticCode: String(item.diagnostic.code).slice(0, 100) } : {}),
    ...(Array.isArray(item.issueFields) ? { issueFields: item.issueFields.filter((f) => typeof f === 'string').slice(0, 20) } : {}),
  }));
}
function presentProblem(item) {
  return { ...item, message: taxonomy[item.diagnosticCode] || taxonomy[item.code] || taxonomy.data_or_binding,
    resolution: item.code.startsWith('NAME_') ? 'name' : ['PRODUCT_EVALUATION_NOT_READY', 'REQUIRED_ATTRIBUTE_VALUE_MISSING', 'REQUIRED_NATIVE_FIELD_MISSING'].includes(item.code)
      ? 'product' : ['reconciliation_required','TEST_DELETION_PENDING'].includes(item.code) ? 'administrator' : 'integration_configuration' };
}
async function saveDiagnostics(db, automatic, blockers) {
  await db.query(`UPDATE magento_product_sync_requests SET diagnostics=$3::jsonb
    WHERE public_product_identity_id=$1 AND desired_generation=$2`,
  [automatic.publicIdentityId, automatic.generation, JSON.stringify(safeDiagnostics(blockers))]);
}
async function summary(db = pool) {
  const result = (await db.query(`SELECT a.enabled,
    (SELECT count(*)::int FROM (SELECT public_product_identity_id FROM magento_product_sync_requests WHERE state='needs_attention'
      UNION SELECT public_product_identity_id FROM magento_test_deletions WHERE state<>'finalized') pending) AS "problemCount"
    FROM magento_auto_sync_activation a WHERE singleton`)).rows[0];
  return { enabled: Boolean(result?.enabled), problemCount: Number(result?.problemCount || 0) };
}
function presentProblemRow(row) {
  return { productId: row.productId, article: row.article, category: row.category,
    problems: (['reconciliation_required','TEST_DELETION_PENDING'].includes(row.reason_code) ? [{ code: row.reason_code }]
      : ['conflict', 'baseline_required'].includes(row.name_state) ? [{ code: row.name_state === 'conflict' ? 'NAME_CONFLICT' : 'NAME_BASELINE_REQUIRED' }]
        : row.diagnostics?.length ? row.diagnostics : [{ code: row.reason_code || 'data_or_binding' }]).map(presentProblem),
    nameConflict: !['reconciliation_required','TEST_DELETION_PENDING'].includes(row.reason_code) && ['conflict', 'baseline_required'].includes(row.name_state)
      ? { amber: row.observed_amber_names, magento: row.observed_remote_names } : null,
  };
}
async function problems(config, db = pool) {
  const rows = (await db.query(`SELECT p.id AS "productId",i.public_sku AS "article",p.category,
    CASE WHEN d.state<>'finalized' THEN 'TEST_DELETION_PENDING' ELSE r.reason_code END AS reason_code,
    r.diagnostics,n.state AS name_state,n.observed_amber_names,n.observed_remote_names
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
    LEFT JOIN magento_name_sync_states n ON n.public_product_identity_id=i.id AND n.origin_hash=$1
    LEFT JOIN magento_test_deletions d ON d.public_product_identity_id=i.id
    WHERE r.state='needs_attention' OR d.state<>'finalized' ORDER BY i.id`, [config.configured ? originHash(config.baseUrl) : 'unconfigured'])).rows;
  return rows.map(presentProblemRow);
}

function normalizePageValue(value, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    const error = new Error('Некоректні параметри сторінки проблем синхронізації.');
    error.statusCode = 422;
    throw error;
  }
  return Math.min(Math.floor(numeric), maximum);
}

async function problemPage(config, query = {}, db = pool) {
  const limit = Math.max(1, normalizePageValue(query.limit, 30, 100));
  const offset = normalizePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const category = String(query.category || '').trim().slice(0, 40);
  const origin = config.configured ? originHash(config.baseUrl) : 'unconfigured';
  const values = [origin];
  const categoryClause = category ? ` AND p.category=$${values.push(category)}` : '';
  const countValues = values.slice(1);
  const [rowsResult, countResult] = await Promise.all([
    db.query(`SELECT p.id AS "productId",i.public_sku AS "article",p.category,
      CASE WHEN d.state<>'finalized' THEN 'TEST_DELETION_PENDING' ELSE r.reason_code END AS reason_code,
      r.diagnostics,n.state AS name_state,n.observed_amber_names,n.observed_remote_names
      FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
      LEFT JOIN magento_name_sync_states n ON n.public_product_identity_id=i.id AND n.origin_hash=$1
      LEFT JOIN magento_test_deletions d ON d.public_product_identity_id=i.id
      WHERE (r.state='needs_attention' OR d.state<>'finalized')${categoryClause}
      ORDER BY i.id, p.id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset]),
    db.query(`SELECT COUNT(*)::int AS count
      FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
      LEFT JOIN magento_test_deletions d ON d.public_product_identity_id=i.id
      WHERE (r.state='needs_attention' OR d.state<>'finalized')${category ? ' AND p.category=$1' : ''}`,
    countValues),
  ]);
  const total = Number(countResult.rows[0]?.count || 0);
  return {
    items: rowsResult.rows.map(presentProblemRow),
    pageInfo: {
      limit,
      offset,
      total,
      hasPrevious: offset > 0,
      hasNext: offset + rowsResult.rows.length < total,
    },
  };
}
module.exports = { taxonomy, safeDiagnostics, presentProblem, saveDiagnostics, summary, problems, problemPage };
