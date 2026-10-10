const pool = require('../../db/pool');
const { originHash } = require('./binding-contract');
const { eligibilityIssue, lifecycleProjectionSql } = require('./lifecycle-issue');
const { isUpgradeProblem } = require('./native-characteristic-upgrade');
const { PHASES } = require('./sync-local-diagnostics');
const taxonomy = Object.freeze({
  FIRST_SYNC_FIELD_CONFLICT: 'Значення Amber і Magento відрізняються. Адміністратор має вибрати значення для цього поля.',
  FIRST_SYNC_FIELD_UNKNOWN: 'Не вдалося достовірно прочитати поле Magento. Відсутність значення не підтверджена.',
  FIRST_SYNC_FIELD_REVIEW_REQUIRED: 'Для цього поля немає підтвердженого безпечного способу прийняти значення Magento.',
  FIRST_SYNC_FIELD_VALIDATION_REQUIRED: 'Значення Magento не пройшло перевірку для збереження в Amber.',
  FIRST_SYNC_UNSETTLED_PRIOR_FIELD: 'Попереднє рішення щодо поля ще не завершене, а поле змінилося в опублікованих відповідностях.',
  FIRST_SYNC_POST_ADOPTION_RECHECK_REQUIRED: 'Дані прийнято в Amber. Перед доставкою потрібна нова перевірка товару.',
  FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED: 'Попередню позначку порожнього поля не можна безпечно зарахувати. Потрібна окрема перевірка.',
  FIRST_SYNC_UNFINISHED_WORK: 'Незавершена операція товару блокує перше прийняття полів. Спочатку потрібно перевірити її результат.',
  FIRST_SYNC_HISTORY_REVIEW_REQUIRED: 'Історія попередньої доставки не дає достовірного підтвердження першої синхронізації.',
  FIRST_SYNC_ORIGIN_REVIEW_REQUIRED: 'Історія товару належить іншому підключенню Magento. Потрібна перевірка адміністратором.',
  FIRST_SYNC_IDENTITY_CHANGED: 'SKU, товар Magento або підключення відрізняється від збереженої історії прийняття полів.',
  unexpected_failure: 'Не вдалося завершити синхронізацію. Потрібна перевірка адміністратором; причина не підтверджена.',
  LOCAL_DATABASE_FAILURE: 'Внутрішня операція бази даних не завершилася. Потрібна технічна перевірка; подробиці доступні в даних для підтримки.',
  product_retired: 'Товар архівований у Manager; автоматичне передавання зупинено.',
  TEST_PRODUCT_REMOTE_ENABLED: 'TEST товар увімкнено поза Amber. Передавання заблоковано; потрібна окрема перевірка Адміністратором.',
  MAGENTO_NATIVE_IDENTITY_COLLISION: 'Артикул уже існує в Magento без підтвердження належності цьому новому товару. Доставку заблоковано; вибір назви не усуває колізію.',
  LIFECYCLE_HISTORICAL_AMBIGUITY: 'Потрібне підтвердження історії доставки',
  AMBER_SYNC_ELIGIBILITY_UNRESOLVED: 'Дозвіл на автоматичну доставку потребує перевірки відповідальним оператором.',
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
  PRODUCT_EVALUATION_NOT_READY: 'Товар не готовий до синхронізації. Потрібно доповнити або виправити дані товару.',
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
    ...(/^LOCAL_DATABASE_FAILURE$/.test(item.code || '') && /^[0-9A-Z]{5}$/.test(item.sqlState || '')
      ? { sqlState: item.sqlState, phase: PHASES.has(item.phase) ? item.phase : 'unknown' } : {}),
    ...Object.fromEntries(['target', 'field', 'path', 'routeKey', 'status', 'scope', 'reason'].map((key) => [key, item[key] ?? item.diagnostic?.[key]])
      .filter(([, value]) => typeof value === 'string' && value.length <= 500)),
    ...(isUpgradeProblem({ ...item, diagnosticCode: item.diagnostic?.code }) ? { question: item.question } : {}),
    ...(item.diagnostic?.code ? { diagnosticCode: String(item.diagnostic.code).slice(0, 100) } : {}),
    ...(Array.isArray(item.issueFields) ? { issueFields: item.issueFields.filter((f) => typeof f === 'string').slice(0, 20) } : {}),
    ...(Array.isArray(item.evaluationIssues) ? { evaluationIssues: item.evaluationIssues.slice(0, 40).map((issue) =>
      Object.fromEntries(['code', 'field', 'message'].filter((key) => typeof issue?.[key] === 'string')
        .map((key) => [key, issue[key].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, key === 'message' ? 600 : 100)]))) } : {}),
  }));
}
function presentProblem(item, lifecycle) {
  if(item.code.startsWith('FIRST_SYNC_')) {
    const reasons={CANONICAL_WEIGHT_SETTER_UNSUPPORTED:'Автоматичне прийняття ваги поки не підтримує всі пов’язані дані товару.',
      CANONICAL_GENERIC_SETTER_UNSUPPORTED:'Історичне значення характеристики потребує окремого підтвердженого способу збереження.',
      POST_IMPORT_CANONICAL_RECHECK_REQUIRED:'Пов’язані поля потрібно порівняти заново після прийняття даних.',
      OUTWARD_POLICY_NOT_AUTHORITATIVE:'Для цього поля не дозволено автоматично передавати значення Amber.',
      REQUIRED_BOTH_EMPTY:'Обов’язкове поле порожнє і в Amber, і в Magento.'};
    return {...item,resolution:'first_sync_fields',message:reasons[item.reason] || taxonomy[item.code]
      || 'Перше прийняття поля потребує перевірки точного збереженого підтвердження.'};
  }
  if (['unexpected_failure', 'MAGENTO_NATIVE_IDENTITY_COLLISION', 'TEST_PRODUCT_REMOTE_ENABLED', 'LOCAL_DATABASE_FAILURE'].includes(item.code)) return { ...item, resolution: 'administrator', message: taxonomy[item.code] };
  if (isUpgradeProblem(item)) return { ...item, resolution: 'integration_configuration',
    message: 'Товар збережено в Amber. Для його характеристик потрібно підготувати, перевірити й застосувати підтримку нових товарів у налаштуваннях категорії Magento.' };
  const issue = item.code === 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED' ? eligibilityIssue(lifecycle) : null;
  if (issue) return { ...item, message: taxonomy.LIFECYCLE_HISTORICAL_AMBIGUITY,
    resolution: 'lifecycle_reconciliation', eligibilityIssue: issue };
  // Evaluator readiness is local product evidence. A nested diagnostic can
  // describe one failed expression, but must not reclassify the whole failure
  // as a Magento read problem.
  const message = item.code === 'PRODUCT_EVALUATION_NOT_READY'
    ? taxonomy.PRODUCT_EVALUATION_NOT_READY
    : taxonomy[item.diagnosticCode] || taxonomy[item.code] || taxonomy.data_or_binding;
  return { ...item, message,
    resolution: item.code.startsWith('NAME_') ? 'name' : ['PRODUCT_EVALUATION_NOT_READY', 'REQUIRED_ATTRIBUTE_VALUE_MISSING', 'REQUIRED_NATIVE_FIELD_MISSING'].includes(item.code)
      ? 'product' : ['reconciliation_required','TEST_DELETION_PENDING','AMBER_SYNC_ELIGIBILITY_UNRESOLVED'].includes(item.code) ? 'administrator'
        : item.code === 'LIFECYCLE_HISTORICAL_AMBIGUITY' ? 'lifecycle_reconciliation'
          : ['configuration','ATTRIBUTE_NOT_FOUND','ATTRIBUTE_METADATA_UNRESOLVED','CATEGORY_PATH_MISSING',
            'attribute_missing','attribute_not_in_selected_set','ATTRIBUTE_NOT_IN_SELECTED_SET'].includes(item.diagnosticCode || item.code)
            ? 'integration_preparation' : 'integration_configuration' };
}
function presentProblems(items = [], lifecycle) {
  const localNameNotReady = items.some((item) => item.code === 'PRODUCT_EVALUATION_NOT_READY'
    && Array.isArray(item.issueFields) && item.issueFields.includes('name'));
  return items.map((item) => {
    const problem = presentProblem(item, lifecycle);
    if (localNameNotReady && item.code === 'NAME_READ_UNAVAILABLE') {
      return { ...problem,
        message: 'Назви товару в Amber потрібно заповнити або виправити.',
        resolution: 'product' };
    }
    return problem;
  });
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
  const foreignIdentity = row.diagnostics?.some(item => item.code === 'MAGENTO_NATIVE_IDENTITY_COLLISION');
  const firstFields=row.diagnostics?.some(item=>item.code.startsWith('FIRST_SYNC_'));
  return { productId: row.productId, article: row.article, category: row.category,
    ...(row.binding_revision_id ? {bindingRevisionId:row.binding_revision_id} : {}),
    ...(row.category_name ? { categoryName: row.category_name } : {}),
    ...(row.product_status ? { productStatus: row.product_status } : {}),
    ...(row.state || (row.deletion_state && row.deletion_state !== 'finalized')
      ? { state: row.deletion_state && row.deletion_state !== 'finalized' ? 'needs_attention' : row.state } : {}),
    ...(row.observed_at ? { observedAt: row.observed_at } : {}),
    ...(row.state === 'synced' && !(row.deletion_state && row.deletion_state !== 'finalized') && row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    problems: presentProblems(['reconciliation_required','TEST_DELETION_PENDING'].includes(row.reason_code) ? [{ code: row.reason_code }]
      : foreignIdentity || firstFields ? row.diagnostics : ['conflict', 'baseline_required'].includes(row.name_state) ? [{ code: row.name_state === 'conflict' ? 'NAME_CONFLICT' : 'NAME_BASELINE_REQUIRED' }]
        : row.diagnostics?.length ? row.diagnostics : [{ code: row.reason_code || 'data_or_binding' }], row.lifecycle),
    nameConflict: !foreignIdentity && !['reconciliation_required','TEST_DELETION_PENDING'].includes(row.reason_code) && ['conflict', 'baseline_required'].includes(row.name_state)
      ? { amber: row.observed_amber_names, magento: row.observed_remote_names } : null,
  };
}
async function problems(config, db = pool) {
  const rows = (await db.query(`SELECT p.id AS "productId",i.public_sku AS "article",p.category,(SELECT b.id FROM magento_binding_revisions b JOIN magento_auto_sync_activation a ON a.installation_key=b.installation_key AND a.singleton WHERE b.state='published' AND b.origin_hash=$1 ORDER BY b.version_number DESC LIMIT 1) AS binding_revision_id,
    CASE WHEN d.state<>'finalized' THEN 'TEST_DELETION_PENDING' ELSE r.reason_code END AS reason_code,
    r.diagnostics,n.state AS name_state,n.observed_amber_names,n.observed_remote_names,${lifecycleProjectionSql}
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id
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

const problemJoinSql = `FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
  LEFT JOIN categories c ON c.code=p.category
  LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
  LEFT JOIN product_full_export_state f ON f.product_id=p.id
  LEFT JOIN magento_name_sync_states n ON n.public_product_identity_id=i.id AND n.origin_hash=$1
  LEFT JOIN magento_test_deletions d ON d.public_product_identity_id=i.id`;
const problemSelectSql = `SELECT p.id AS "productId",i.public_sku AS "article",p.category,(SELECT b.id FROM magento_binding_revisions b JOIN magento_auto_sync_activation a ON a.installation_key=b.installation_key AND a.singleton WHERE b.state='published' AND b.origin_hash=$1 ORDER BY b.version_number DESC LIMIT 1) AS binding_revision_id,c.name AS category_name,p.status AS product_status,
  r.state,d.state AS deletion_state,r.updated_at AS observed_at,CASE WHEN r.state='synced' AND r.public_product_identity_id=p.public_product_identity_id THEN (SELECT max(j.acknowledged_at) FROM magento_sync_jobs j
      WHERE j.product_id=p.id AND j.public_product_identity_id=p.public_product_identity_id
        AND j.automatic_generation=r.desired_generation AND j.state='succeeded'
        AND j.origin_hash=(SELECT b.origin_hash FROM magento_binding_revisions b
          JOIN magento_auto_sync_activation a ON a.installation_key=b.installation_key AND a.singleton
          WHERE b.state='published' ORDER BY b.version_number DESC LIMIT 1)) END AS confirmed_at,
  CASE WHEN d.state<>'finalized' THEN 'TEST_DELETION_PENDING' ELSE r.reason_code END AS reason_code,
  r.diagnostics,n.state AS name_state,n.observed_amber_names,n.observed_remote_names,${lifecycleProjectionSql}`;
const reasonGroupSql = `CASE
  WHEN d.state<>'finalized' OR r.reason_code='reconciliation_required'
    OR r.diagnostics @> '[{"code":"AMBER_SYNC_ELIGIBILITY_UNRESOLVED"}]'::jsonb THEN 'recovery'
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.diagnostics,'[]'::jsonb)) e WHERE e->>'code' LIKE 'FIRST_SYNC_%') THEN 'integration'
  WHEN n.state IN ('conflict','baseline_required') THEN 'names'
  WHEN r.diagnostics @> '[{"code":"PRODUCT_EVALUATION_NOT_READY"}]'::jsonb
    OR r.diagnostics @> '[{"code":"REQUIRED_ATTRIBUTE_VALUE_MISSING"}]'::jsonb
    OR r.diagnostics @> '[{"code":"REQUIRED_NATIVE_FIELD_MISSING"}]'::jsonb THEN 'product'
  WHEN r.reason_code IN ('authorization','configuration') THEN 'connection'
  ELSE 'integration' END`;

async function problemPage(config, query = {}, db = pool) {
  const limit = Math.max(1, normalizePageValue(query.limit, 30, 100));
  const offset = normalizePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const category = String(query.category || '').trim().slice(0, 40);
  const search = String(query.search || '').trim().slice(0, 120);
  const reason = String(query.reason || '');
  if (reason && !['recovery', 'names', 'product', 'connection', 'integration'].includes(reason)) {
    const error = new Error('Невідомий тип проблеми.'); error.statusCode = 422; throw error;
  }
  const values = [config.configured ? originHash(config.baseUrl) : 'unconfigured'];
  let filter = "WHERE (r.state='needs_attention' OR d.state<>'finalized')";
  if (category) filter += ` AND p.category=$${values.push(category)}`;
  if (search) filter += ` AND i.public_sku ILIKE $${values.push('%' + search.replace(/[\\%_]/g, '\\$&') + '%')} ESCAPE '\\'`;
  if (reason) filter += ` AND (${reasonGroupSql})=$${values.push(reason)}`;
  const [rowsResult, countResult, categoriesResult] = await Promise.all([
    db.query(`${problemSelectSql} ${problemJoinSql} ${filter} ORDER BY i.id,p.id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
    db.query(`SELECT COUNT(*)::int AS count ${problemJoinSql} ${filter}`, values),
    db.query(`SELECT p.category,c.name,COUNT(*)::int AS count FROM products p
      LEFT JOIN categories c ON c.code=p.category
      LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
      LEFT JOIN magento_test_deletions d ON d.product_id=p.id
      WHERE r.state='needs_attention' OR d.state<>'finalized'
      GROUP BY p.category,c.name ORDER BY p.category LIMIT 100`, []),
  ]);
  const total = Number(countResult.rows[0]?.count || 0);
  return { items: rowsResult.rows.map(presentProblemRow),
    categories: categoriesResult.rows.filter((row) => typeof row.category === 'string')
      .map((row) => ({ code: row.category, name: row.name || row.category, count: Number(row.count) })),
    pageInfo: { limit, offset, total, hasPrevious: offset > 0, hasNext: offset + rowsResult.rows.length < total } };
}

async function problemDetail(config, productId, db = pool) {
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error('Некоректний товар.'); error.statusCode = 422; throw error;
  }
  const row = (await db.query(`${problemSelectSql} ${problemJoinSql} WHERE p.id=$2`,
    [config.configured ? originHash(config.baseUrl) : 'unconfigured', id])).rows[0];
  if (!row) { const error = new Error('Товар не знайдено.'); error.statusCode = 404; throw error; }
  const presented = presentProblemRow(row);
  const state = presented.state || 'not_tracked';
  return { ...presented, state, problems: state === 'needs_attention' ? presented.problems : [],
    nameConflict: state === 'needs_attention' ? presented.nameConflict : null };
}
module.exports = { taxonomy, safeDiagnostics, presentProblem, presentProblems, saveDiagnostics, summary, problems, problemPage, problemDetail };
