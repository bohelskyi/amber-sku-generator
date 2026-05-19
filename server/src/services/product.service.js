const pool = require('../db/pool');
const { calculatePricing } = require('./pricing.service');
const {
  appendSkuSuffix,
  buildBaseSku,
  decodeSkuAnswers,
  decodeVisibleSkuAnswers,
  parseVariationSku,
} = require('../utils/sku');
const { isRuleMatched } = require('../utils/rules');

async function getAllCategories() {
  const result = await pool.query(
    `SELECT code, name, requires_weight, skip_hidden_sku_questions
     FROM categories
     ORDER BY LENGTH(code) DESC, code ASC`
  );

  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    requires_weight: Number(row.requires_weight),
    skip_hidden_sku_questions: Number(row.skip_hidden_sku_questions || 0),
  }));
}

async function getQuestionsForCategory(categoryCode) {
  const result = await pool.query(
    `
      SELECT
        q.key,
        q.label AS q_label,
        q.sku_index,
        COALESCE(q.sku_separator, '') AS sku_separator,
        q.required,
        q.visible_if_json,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON q.id = o.question_id
      WHERE q.category_code = $1 AND COALESCE(q.include_in_sku, 1) = 1
      ORDER BY q.sku_index, LENGTH(CAST(o.value_id AS TEXT)) DESC, o.value_id ASC
    `,
    [categoryCode]
  );

  const questions = [];
  let currentQuestion = null;

  for (const row of result.rows) {
    if (!currentQuestion || currentQuestion.key !== row.key) {
      currentQuestion = {
        key: row.key,
        label: row.q_label,
        sku_index: Number(row.sku_index),
        sku_separator: row.sku_separator || '',
        required: Number(row.required),
        visible_if_json: row.visible_if_json || null,
        options: [],
      };
      questions.push(currentQuestion);
    }

    if (row.value_id !== null && row.value_id !== undefined) {
      currentQuestion.options.push({
        id: Number(row.value_id),
        label: row.o_label,
      });
    }
  }

  return questions;
}

async function decodeSku(skuValue) {
  const { normalizedSku, baseFullSku, variationNumber } = parseVariationSku(skuValue);
  if (!normalizedSku) {
    throw new Error('Введіть артикул для розшифровки');
  }

  const categories = await getAllCategories();
  const category = categories.find((item) => baseFullSku.startsWith(item.code));
  if (!category) {
    throw new Error('Не вдалося визначити категорію за кодом артикула');
  }

  const questions = await getQuestionsForCategory(category.code);
  const skuWithoutCategory = baseFullSku.slice(category.code.length);
  const attempts = [];

  if (skuWithoutCategory.length >= 3) {
    attempts.push({
      encodedPart: skuWithoutCategory.slice(0, -3),
      suffixRaw: skuWithoutCategory.slice(-3),
      hasSuffix: true,
    });
  }

  attempts.push({
    encodedPart: skuWithoutCategory,
    suffixRaw: null,
    hasSuffix: false,
  });

  for (const attempt of attempts) {
    const decodedAnswers =
      Number(category.skip_hidden_sku_questions || 0) === 1
        ? decodeVisibleSkuAnswers(questions, attempt.encodedPart)
        : decodeSkuAnswers(questions, attempt.encodedPart);
    if (!decodedAnswers) continue;

    const suffixValue =
      attempt.suffixRaw !== null && /^\d+$/.test(attempt.suffixRaw)
        ? Number(attempt.suffixRaw)
        : null;

    const productResult = await pool.query(
      'SELECT id, full_sku, base_sku, sequence_number, category, weight, total_price, created_at FROM products WHERE full_sku = $1 LIMIT 1',
      [normalizedSku]
    );

    return {
      sku: normalizedSku,
      category: {
        code: category.code,
        name: category.name,
        requires_weight: category.requires_weight,
        skip_hidden_sku_questions: category.skip_hidden_sku_questions,
      },
      baseSku: category.code + attempt.encodedPart,
      decodedAnswers,
      suffix: {
        raw: attempt.suffixRaw,
        type: attempt.hasSuffix
          ? category.requires_weight === 1
            ? 'weight'
            : 'sequence'
          : 'none',
        value: suffixValue,
      },
      variation:
        variationNumber !== null
          ? {
              number: variationNumber,
              suffix: `-${String(variationNumber).padStart(3, '0')}`,
            }
          : null,
      existsInDb: productResult.rows.length > 0,
      product: productResult.rows[0] || null,
    };
  }

  throw new Error('Артикул не відповідає поточній конфігурації категорії');
}

async function getNextVariationSku(skuValue) {
  const { baseFullSku } = parseVariationSku(skuValue);
  if (!baseFullSku) {
    throw new Error('Потрібен базовий артикул');
  }

  const result = await pool.query(
    'SELECT full_sku FROM products WHERE full_sku = $1 OR full_sku LIKE $2',
    [baseFullSku, `${baseFullSku}-%`]
  );

  let maxVariationNumber = 0;
  for (const row of result.rows) {
    const match = String(row.full_sku).match(
      new RegExp(`^${baseFullSku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\-(\\d{3})$`)
    );
    if (!match) continue;
    maxVariationNumber = Math.max(maxVariationNumber, Number(match[1]));
  }

  const nextVariationNumber = maxVariationNumber + 1;
  if (nextVariationNumber > 999) {
    throw new Error('Досягнуто ліміт варіацій для цього артикула');
  }

  return {
    baseFullSku,
    variationNumber: nextVariationNumber,
    fullSku: `${baseFullSku}-${String(nextVariationNumber).padStart(3, '0')}`,
  };
}

async function getProductBySku(fullSku) {
  const result = await pool.query(
    'SELECT id, full_sku, created_at FROM products WHERE full_sku = $1 ORDER BY id ASC LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );

  return result.rows[0] || null;
}

function isQuestionVisibleForSku(question, answers, isCalibrated) {
  return isRuleMatched(question.visible_if_json, {
    ...answers,
    is_calibrated: isCalibrated,
  });
}

async function buildProductPreview({ categoryCode, answers = {}, weight, isCalibrated }) {
  const categoryResult = await pool.query(
    `SELECT requires_weight, COALESCE(sku_separator, '') AS legacy_sku_separator, skip_hidden_sku_questions
     FROM categories
     WHERE code = $1`,
    [categoryCode]
  );
  const skipHiddenSkuQuestions =
    Number(categoryResult.rows[0]?.skip_hidden_sku_questions || 0) === 1;

  const questionRows = await pool.query(
    `SELECT key, sku_index, COALESCE(sku_separator, '') AS sku_separator, visible_if_json
     FROM questions
     WHERE category_code = $1 AND COALESCE(include_in_sku, 1) = 1
     ORDER BY sku_index ASC`,
    [categoryCode]
  );

  const answerCodes = [];
  const answerCodeParts = [];
  for (const question of questionRows.rows) {
    if (
      skipHiddenSkuQuestions &&
      !isQuestionVisibleForSku(question, answers, isCalibrated)
    ) {
      continue;
    }

    const value = answers[question.key];
    const normalizedValue = value !== undefined && value !== null && value !== '' ? value : 0;
    answerCodes.push(normalizedValue);
    answerCodeParts.push({
      value: normalizedValue,
      sku_separator: question.sku_separator || '',
    });
  }

  const legacySkuSeparator = categoryResult.rows[0]?.legacy_sku_separator || '';
  const baseSku = buildBaseSku(categoryCode, answerCodeParts);
  const compactBaseSku = buildBaseSku(categoryCode, answerCodes);
  const legacySeparatedBaseSku = buildBaseSku(categoryCode, answerCodes, legacySkuSeparator);
  const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
  const { weightVal, pricePerGram, totalPrice, logMessage, currencyPayload } = pricing;

  const requiresWeight =
    categoryResult.rows.length > 0 &&
    Number(categoryResult.rows[0].requires_weight) === 1 &&
    categoryCode !== 'SK';

  if (!requiresWeight) {
    const baseSkuCandidates = Array.from(
      new Set([baseSku, compactBaseSku, legacySeparatedBaseSku])
    );
    const sequenceResult = await pool.query(
      `SELECT sequence_number, full_sku
       FROM products
       WHERE base_sku = ANY($1::text[])
       ORDER BY sequence_number DESC
       LIMIT 1`,
      [baseSkuCandidates]
    );

    const lastSeq =
      sequenceResult.rows.length > 0 && sequenceResult.rows[0].sequence_number
        ? Number(sequenceResult.rows[0].sequence_number)
        : 0;
    const nextSeq = lastSeq + 1;
    const fullProposedSku = appendSkuSuffix(baseSku, nextSeq);
    const prevFullSku =
      lastSeq > 0 ? sequenceResult.rows[0].full_sku || appendSkuSuffix(baseSku, lastSeq) : 'Немає';

    return {
      mode: 'sequence',
      baseSku,
      nextSeq,
      fullProposedSku,
      prevFullSku,
      pricePerGram: pricePerGram.toFixed(2),
      totalPrice,
      logMessage,
      ...currencyPayload,
    };
  }

  const weightInt = Math.round(weightVal);
  const fullProposedSku = appendSkuSuffix(baseSku, weightInt);
  const existingProduct = await pool.query(
    'SELECT full_sku FROM products WHERE full_sku = ANY($1::text[]) LIMIT 1',
    [
      Array.from(
        new Set([
          fullProposedSku,
          appendSkuSuffix(compactBaseSku, weightInt),
          appendSkuSuffix(legacySeparatedBaseSku, weightInt),
        ])
      ),
    ]
  );

  return {
    mode: 'weight',
    baseSku,
    nextSeq: weightInt,
    fullProposedSku,
    existsInDb: existingProduct.rows.length > 0,
    pricePerGram: pricePerGram.toFixed(2),
    totalPrice,
    logMessage,
    ...currencyPayload,
  };
}

async function saveProduct(payload) {
  const result = await pool.query(
    `INSERT INTO products
     (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah, price_per_gram, uah_rate, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      payload.fullSku,
      payload.baseSku,
      Number(payload.nextSeq),
      payload.category,
      Number(payload.weight || 0),
      Number(payload.totalPrice || 0),
      payload.totalPriceUah !== undefined && payload.totalPriceUah !== null
        ? Number(payload.totalPriceUah)
        : null,
      Number(payload.pricePerGram || 0),
      payload.uahRate !== undefined && payload.uahRate !== null ? Number(payload.uahRate) : null,
      JSON.stringify(payload.details || {}),
    ]
  );

  return { success: true, id: result.rows[0].id };
}

async function deleteProductBySku(skuToDelete) {
  const result = await pool.query('DELETE FROM products WHERE full_sku = $1', [skuToDelete]);
  if (result.rowCount === 0) {
    const err = new Error('Артикул не знайдено.');
    err.statusCode = 404;
    throw err;
  }

  return {
    success: true,
    message: `Артикул ${skuToDelete} успішно видалено.`,
  };
}

async function getRecentProducts() {
  const result = await pool.query(
    'SELECT * FROM products ORDER BY created_at DESC LIMIT 15',
    []
  );

  return result.rows;
}

module.exports = {
  decodeSku,
  getNextVariationSku,
  buildProductPreview,
  saveProduct,
  deleteProductBySku,
  getRecentProducts,
  getProductBySku,
};
