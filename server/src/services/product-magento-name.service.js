const lifecycleGate = require('./full-product-cutover-gate');
const crypto = require('node:crypto');
const pool = require('../db/pool');
const config = require('../config/env');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { getProductStateSignature } = require('./product/product-signatures');
const { readFullProductStates, advanceFullProductRevision,
  advanceFullProductDeliveryVersion } = require('./full-product-export.service');

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

function reviewedSubject(value, language, confirmUnchanged) {
  const normalized = normalizeSubject(value, language);
  // Explicit review preserves the exact inherited pair; it is not text cleanup.
  return confirmUnchanged === true ? value : normalized;
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

function previewFor(product, subjectUa, subjectEn, lifecycle, confirmUnchanged = false) {
  assertEligible(product);
  const unchanged = product.magento_name_subject_ua === subjectUa
      && product.magento_name_subject_en === subjectEn;
  const sameOutput = product.magento_name_subject_ua?.trim() === subjectUa.trim()
      && product.magento_name_subject_en?.trim() === subjectEn.trim();
  const reviewRequired = product.magento_name_review_required === true;
  if (confirmUnchanged && (!unchanged || !reviewRequired)) {
    throw nameError('Успадковані назви або їх перевірка змінилися. Оновіть дані.', 409, 'STALE_MAGENTO_NAME');
  }
  if (sameOutput && !confirmUnchanged) {
    throw nameError('Назви не змінилися.', 422, 'NO_CHANGE');
  }
  const sku = product.public_sku || product.full_sku;
  const previewToken = crypto.createHash('sha256').update(JSON.stringify({
    version: 2,
    productState: getProductStateSignature(product),
    revision: lifecycle.revision, deliveryVersion: lifecycle.delivery_version,
    reviewRequired, confirmUnchanged,
    before: [product.magento_name_subject_ua, product.magento_name_subject_en],
    after: [subjectUa, subjectEn],
  })).digest('hex');
  return {
    productId: Number(product.id), sku: product.full_sku, internalSku: product.full_sku,
    publicSku: sku, subjectUa, subjectEn, previewToken,
    reviewRequired, canConfirmUnchanged: unchanged && reviewRequired,
    action: unchanged ? 'confirm_inherited' : 'change',
    nameUa: `${subjectUa} з бурштину. Арт: ${sku}`,
    nameEn: `Amber ${subjectEn}. Art: ${sku}`,
  };
}

async function previewProductMagentoName(payload = {}, options = {}) {
  if (payload.intent === 'historical-create') return require('./magento/historical-create-names.service').preview(payload, options);
  const productId = parseProductId(payload.productId);
  const client = await (options.databasePool || pool).connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const product = (await client.query(`SELECT p.*,i.public_sku FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id = $1`, [productId])).rows[0];
    const effective = await require('./product/effective-name-readiness').current(client);
    if (effective) {
      if (Object.hasOwn(payload, 'subjectUa') || Object.hasOwn(payload, 'subjectEn')) throw nameError('Чинні правила використовують повні назви. Оновіть форму.', 409, 'PRODUCT_NAMES_POLICY_CHANGED');
      const result = await require('./magento/product-names.service').read(productId, { queryable: client, readiness: true, allowUnavailable: true });
      await lifecycleGate.commit(client);
      return { ...result, effectiveNames: true, publicSku: product?.public_sku };
    }
    assertEligible(product);
    const [lifecycle] = await readFullProductStates(client, [productId]);
    const readCurrent = !Object.hasOwn(payload, 'subjectUa') && !Object.hasOwn(payload, 'subjectEn');
    const preview = readCurrent ? { productId, sku: product.full_sku, internalSku: product.full_sku,
      publicSku: product.public_sku,
      subjectUa: product.magento_name_subject_ua, subjectEn: product.magento_name_subject_en,
      reviewRequired: product.magento_name_review_required,
      canConfirmUnchanged: product.magento_name_review_required === true
        && Boolean(product.magento_name_subject_ua && product.magento_name_subject_en) }
      : previewFor(product, reviewedSubject(payload.subjectUa, 'українську', payload.confirmUnchanged),
        reviewedSubject(payload.subjectEn, 'англійську', payload.confirmUnchanged), lifecycle, payload.confirmUnchanged === true);
    if (readCurrent && preview.canConfirmUnchanged) {
      preview.previewToken = previewFor(product, preview.subjectUa, preview.subjectEn, lifecycle, true).previewToken;
    }
    await lifecycleGate.commit(client);
    return preview;
  } catch (error) { await lifecycleGate.rollback(client); throw error; }
  finally { await lifecycleGate.release(client); client.release(); }
}

async function applyProductMagentoName(payload = {}, options = {}) {
  if (payload.intent === 'historical-create') return require('./magento/historical-create-names.service').apply(payload, options);
  const productId = parseProductId(payload.productId);
  const subjectUa = reviewedSubject(payload.subjectUa, 'українську', payload.confirmUnchanged);
  const subjectEn = reviewedSubject(payload.subjectEn, 'англійську', payload.confirmUnchanged);
  const previewToken = String(payload.previewToken || '').trim();
  if (!previewToken) throw nameError('Потрібен актуальний previewToken.');
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await (options.databasePool || pool).connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    if (await require('./product/effective-name-readiness').current(client, { lock: true })) throw nameError('Чинні правила використовують повні назви. Оновіть форму.', 409, 'PRODUCT_NAMES_POLICY_CHANGED');
    const result = await client.query(`SELECT p.*,i.public_sku FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id = $1 FOR UPDATE OF p`, [productId]);
    const product = result.rows[0];
    assertEligible(product);
    const [lifecycle] = await readFullProductStates(client, [productId], { lock: true });
    const preview = previewFor(product, subjectUa, subjectEn, lifecycle, payload.confirmUnchanged === true);
    if (preview.previewToken !== previewToken) {
      throw nameError('Товар змінився після перегляду. Оновіть дані.',
        409, 'STALE_MAGENTO_NAME');
    }
    await client.query(
      `UPDATE products SET magento_name_subject_ua = $1,
                           magento_name_subject_en = $2,
                           magento_name_review_required = FALSE
       WHERE id = $3`,
      [subjectUa, subjectEn, productId]
    );
    const fullState = preview.action === 'change'
      ? await advanceFullProductRevision(client, productId, lifecycle.revision) : lifecycle;
    if (product.magento_name_review_required) {
      await advanceFullProductDeliveryVersion(client, productId, lifecycle.delivery_version);
    }
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: preview.action === 'confirm_inherited' ? 'product_magento_name.reviewed' : 'product_magento_name.updated',
      subjectType: 'product',
      subjectId: productId,
      details: {
        sku: product.full_sku,
        version: 1,
        before: { subjectUa: product.magento_name_subject_ua,
          subjectEn: product.magento_name_subject_en },
        after: { subjectUa, subjectEn },
        ...(product.magento_name_review_required ? { inheritedReviewCompleted: true } : {}),
      },
    });
    await lifecycleGate.commit(client);
    return { ...preview, reviewRequired: false, canConfirmUnchanged: false, fullRevision: fullState.revision };
  } catch (error) {
    await lifecycleGate.rollback(client);
    throw error;
  } finally {
    await lifecycleGate.release(client); client.release();
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
  normalizeSubject,
  applyProductMagentoName,
  previewProductMagentoName,
  suggestEnglishSubject,
};
