const crypto = require('node:crypto');
const pool = require('../db/pool');
const config = require('../config/env');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { getProductStateSignature } = require('./product/product-signatures');

const TRANSLATION_URL = 'https://translation.googleapis.com/language/translate/v2';
const TRANSLATION_TIMEOUT_MS = 4000;

function nameError(message, statusCode = 422, publicCode = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicCode = publicCode;
  return error;
}

function normalizeSubject(value, language) {
  if (typeof value !== 'string') throw nameError(`Вкажіть ${language} назву.`);
  const subject = value.trim();
  if (!subject || subject.length > 200 || /[\u0000-\u001f\u007f]/u.test(subject)) {
    throw nameError(`Вкажіть коректну ${language} назву до 200 символів.`);
  }
  return subject;
}

function parseProductId(value) {
  const productId = Number(value);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw nameError('Вкажіть чинний товар.');
  }
  return productId;
}

function assertEligible(product) {
  if (!product) throw nameError('Товар не знайдено.', 404);
  if (product.category !== 'SV' || String(product.status || 'active') !== 'active'
      || product.corrected_to_product_id) {
    throw nameError('Ручну назву можна зберегти лише для чинного активного сувеніра.', 409);
  }
}

function previewFor(product, subjectUa, subjectEn) {
  assertEligible(product);
  if (product.magento_name_subject_ua === subjectUa
      && product.magento_name_subject_en === subjectEn) {
    throw nameError('Назви не змінилися.', 422, 'NO_CHANGE');
  }
  const sku = product.full_sku;
  const previewToken = crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    productState: getProductStateSignature(product),
    before: [product.magento_name_subject_ua, product.magento_name_subject_en],
    after: [subjectUa, subjectEn],
  })).digest('hex');
  return {
    productId: Number(product.id), sku, subjectUa, subjectEn, previewToken,
    nameUa: `${subjectUa} з бурштину. Арт: ${sku}`,
    nameEn: `Amber ${subjectEn}. Art: ${sku}`,
  };
}

async function previewProductMagentoName(payload = {}) {
  const productId = parseProductId(payload.productId);
  const subjectUa = normalizeSubject(payload.subjectUa, 'українську');
  const subjectEn = normalizeSubject(payload.subjectEn, 'англійську');
  const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
  return previewFor(result.rows[0], subjectUa, subjectEn);
}

async function applyProductMagentoName(payload = {}, options = {}) {
  const productId = parseProductId(payload.productId);
  const subjectUa = normalizeSubject(payload.subjectUa, 'українську');
  const subjectEn = normalizeSubject(payload.subjectEn, 'англійську');
  const previewToken = String(payload.previewToken || '').trim();
  if (!previewToken) throw nameError('Потрібен актуальний previewToken.');
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const product = result.rows[0];
    const preview = previewFor(product, subjectUa, subjectEn);
    if (preview.previewToken !== previewToken) {
      throw nameError('Товар змінився після перегляду. Оновіть дані.',
        409, 'STALE_MAGENTO_NAME');
    }
    await client.query(
      `UPDATE products SET magento_name_subject_ua = $1,
                           magento_name_subject_en = $2
       WHERE id = $3`,
      [subjectUa, subjectEn, productId]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'product_magento_name.updated',
      subjectType: 'product',
      subjectId: productId,
      details: {
        sku: product.full_sku,
        version: 1,
        before: { subjectUa: product.magento_name_subject_ua,
          subjectEn: product.magento_name_subject_en },
        after: { subjectUa, subjectEn },
      },
    });
    await client.query('COMMIT');
    return preview;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function suggestEnglishSubject(payload = {}, options = {}) {
  const apiKey = options.apiKey ?? config.googleTranslationApiKey;
  if (!apiKey) {
    throw nameError('Автоматичний переклад не налаштовано. Введіть англійську назву вручну.',
      503, 'TRANSLATION_NOT_CONFIGURED');
  }
  const productId = parseProductId(payload.productId);
  const subjectUa = normalizeSubject(payload.subjectUa, 'українську');
  const result = await pool.query(
    'SELECT id, category, status, corrected_to_product_id FROM products WHERE id = $1',
    [productId]
  );
  assertEligible(result.rows[0]);
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(TRANSLATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({ q: subjectUa, source: 'uk', target: 'en', format: 'text' }),
      signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Provider response failed');
    const body = await response.json();
    const suggestion = body?.data?.translations?.[0]?.translatedText;
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      throw new Error('Provider response missing translation');
    }
    return { subjectEn: normalizeSubject(suggestion, 'англійську') };
  } catch {
    throw nameError('Не вдалося запропонувати переклад. Введіть англійську назву вручну або повторіть спробу.',
      502, 'TRANSLATION_FAILED');
  }
}

module.exports = {
  applyProductMagentoName,
  previewProductMagentoName,
  suggestEnglishSubject,
};
