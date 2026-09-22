const crypto = require('node:crypto');
const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { getRuleDependencies } = require('../utils/rules');
const { isQuestionVisibleForSku } = require('./product/product-answers');
const { getProductStateSignature } = require('./product/product-signatures');

// Version 1 contains only Magento output inputs that do not define a SKU or a price.
// SV.weight is deliberately absent: it is an axis of an active pricing scenario.
const INFORMATION_FIELDS_V1 = Object.freeze({
  BR: Object.freeze(['braclet_size']),
  NM: Object.freeze(['neckle_size']),
  KL: Object.freeze(['exact_size']),
  CH: Object.freeze(['bead_length', 'bead_width', 'rosary_length']),
  SV: Object.freeze(['size']),
});

function informationError(message, statusCode = 422, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.publicCode = code;
  return error;
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).length === 0) {
    throw informationError('Вкажіть інформаційні поля для оновлення.');
  }
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => {
    if (typeof value !== 'string' && value !== null) {
      throw informationError(`Некоректне значення поля ${key}.`);
    }
    const normalized = value === null ? null : value.trim();
    if (normalized && (normalized.length > 500 || /[\u0000-\u001f]/.test(normalized))) {
      throw informationError(`Некоректне значення поля ${key}.`);
    }
    return [key, normalized || null];
  }));
}

function axisUsesKey(axis, key) {
  return String(axis || '').split('+').some((part) => part.trim() === key);
}

async function assertSafeCatalogField(client, category, key, lockCatalog) {
  if (!INFORMATION_FIELDS_V1[category]?.includes(key)) {
    throw informationError(`Поле ${key} не входить до дозволеного переліку Magento v1.`);
  }
  const questions = await client.query(
    `SELECT key, required, include_in_sku, input_type, visible_if_json
     FROM questions WHERE category_code = $1 ORDER BY id ${lockCatalog ? 'FOR SHARE' : ''}`,
    [category]
  );
  const target = questions.rows.find((row) => row.key === key);
  if (!target || Number(target.include_in_sku) !== 0 || target.input_type !== 'text') {
    throw informationError(`Поле ${key} більше не є безпечним інформаційним полем.`, 409);
  }
  if (questions.rows.some((row) => getRuleDependencies(row.visible_if_json).includes(key))) {
    throw informationError(`Поле ${key} використовується правилом видимості.`, 409);
  }
  const optionRules = await client.query(
    `SELECT o.visible_if_json, o.hidden_if_json
     FROM options o JOIN questions q ON q.id = o.question_id
     WHERE q.category_code = $1 ${lockCatalog ? 'FOR SHARE OF o' : ''}`,
    [category]
  );
  if (optionRules.rows.some((row) => (
    getRuleDependencies(row.visible_if_json).includes(key)
    || getRuleDependencies(row.hidden_if_json).includes(key)
  ))) {
    throw informationError(`Поле ${key} використовується правилом опції.`, 409);
  }
  const scenarios = await client.query(
    `SELECT match_json, axis_x_key, axis_y_key
     FROM price_scenarios WHERE category_code = $1 ${lockCatalog ? 'FOR SHARE' : ''}`,
    [category]
  );
  if (scenarios.rows.some((row) => (
    getRuleDependencies(row.match_json).includes(key)
    || axisUsesKey(row.axis_x_key, key) || axisUsesKey(row.axis_y_key, key)
  ))) {
    throw informationError(`Поле ${key} використовується ціноутворенням.`, 409);
  }
  const modifiers = await client.query(
    `SELECT match_json, trigger_key
     FROM price_modifiers WHERE category_code = $1 ${lockCatalog ? 'FOR SHARE' : ''}`,
    [category]
  );
  if (modifiers.rows.some((row) => (
    getRuleDependencies(row.match_json).includes(key) || row.trigger_key === key
  ))) {
    throw informationError(`Поле ${key} використовується модифікатором ціни.`, 409);
  }
  return target;
}

function getAnswers(product) {
  const answers = product.details?.answers;
  return answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
}

async function getExportGuidance(client, product) {
  if (Number(product.exclude_from_export) === 1) {
    return { mode: 'excluded', eligible: false };
  }
  const result = await client.query(
    `SELECT COALESCE(r.has_product_snapshot, FALSE) AS has_product_snapshot,
            COALESCE(s.exported_to_product_id, 0) AS exported_to_product_id
     FROM (SELECT 1) anchor
     LEFT JOIN product_export_revisions r ON r.product_id = $1
     LEFT JOIN export_state s ON s.singleton = TRUE`,
    [product.id]
  );
  const evidence = result.rows[0];
  if (evidence.has_product_snapshot
      || Number(evidence.exported_to_product_id) >= Number(product.id)) {
    return { mode: 'reexport', eligible: true };
  }
  return { mode: 'next_normal_export', eligible: true };
}

async function evaluate(client, product, patch, lockCatalog = false) {
  if (!product) throw informationError('Товар не знайдено.', 404);
  if (String(product.status || 'active') !== 'active' || product.corrected_to_product_id) {
    throw informationError('Оновлювати можна лише чинний активний товар.', 409);
  }
  const active = await client.query(
    `SELECT id FROM correction_requests
     WHERE source_product_id = $1 AND status IN ('pending', 'in_progress')
     LIMIT 1`,
    [product.id]
  );
  if (active.rows.length) {
    throw informationError(
      `Для товару є активний запит #${active.rows[0].id}. Завершіть його перед оновленням.`,
      409, 'ACTIVE_CORRECTION_REQUEST'
    );
  }
  const oldAnswers = getAnswers(product);
  const newAnswers = { ...oldAnswers };
  const changes = [];
  for (const [key, value] of Object.entries(patch)) {
    const question = await assertSafeCatalogField(client, product.category, key, lockCatalog);
    if (!isQuestionVisibleForSku(question, newAnswers, product.details?.isCalibrated)) {
      throw informationError(`Поле ${key} не є видимим для цього товару.`, 409);
    }
    if (value === null && Number(question.required) === 1) {
      throw informationError(`Поле ${key} є обов'язковим.`);
    }
    const before = oldAnswers[key] === undefined ? null : String(oldAnswers[key]);
    if (before === value) continue;
    if (value === null) delete newAnswers[key];
    else newAnswers[key] = value;
    changes.push({ key, before, after: value });
  }
  if (!changes.length) throw informationError('Інформаційні відповіді не змінилися.', 422, 'NO_CHANGE');
  const token = crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    sourceSignature: getProductStateSignature(product),
    patch: Object.entries(patch).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
  return { changes, newAnswers, previewToken: token,
    exportGuidance: await getExportGuidance(client, product) };
}

async function previewProductInformation(payload = {}) {
  const productId = Number(payload.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw informationError('Вкажіть чинний товар.');
  }
  const patch = normalizePatch(payload.answersPatch);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query('SELECT * FROM products WHERE id = $1', [productId]);
    const product = result.rows[0];
    const preview = await evaluate(client, product, patch);
    await client.query('COMMIT');
    return { productId, sku: product.full_sku, ...preview, newAnswers: undefined };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyProductInformation(payload = {}, options = {}) {
  const productId = Number(payload.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw informationError('Вкажіть чинний товар.');
  }
  const patch = normalizePatch(payload.answersPatch);
  const token = String(payload.previewToken || '').trim();
  if (!token) throw informationError('Потрібен актуальний previewToken.');
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const product = result.rows[0];
    const preview = await evaluate(client, product, patch, true);
    if (preview.previewToken !== token) {
      throw informationError('Товар змінився після перегляду. Оновіть дані.', 409, 'STALE_PRODUCT_INFORMATION');
    }
    await client.query(
      `UPDATE products SET details = jsonb_set(
         COALESCE(details, '{}'::jsonb), '{answers}', $1::jsonb, TRUE
       )
       WHERE id = $2`,
      [JSON.stringify(preview.newAnswers), productId]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product_information.updated',
      subjectType: 'product',
      subjectId: productId,
      details: { sku: product.full_sku, version: 1, changes: preview.changes,
        reason: String(payload.reason || '').trim() || null },
    });
    await client.query('COMMIT');
    return { productId, sku: product.full_sku, changes: preview.changes,
      exportGuidance: preview.exportGuidance };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  INFORMATION_FIELDS_V1,
  applyProductInformation,
  previewProductInformation,
};
