const pool = require('../db/pool');
const { getAppConfig } = require('./catalog.service');
const { getAnswerChanges } = require('../utils/answer-changes');
const { asRuleObject, isRuleMatched } = require('../utils/rules');
const { roundUah } = require('../utils/money');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sameAnswerValue(firstValue, secondValue) {
  if (firstValue === null || firstValue === undefined) {
    return secondValue === null || secondValue === undefined;
  }
  const firstNumber = Number(firstValue);
  const secondNumber = Number(secondValue);
  if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber)) {
    return firstNumber === secondNumber;
  }
  return String(firstValue) === String(secondValue);
}

function getQuestion(config, categoryCode, key) {
  return (config?.questions?.[categoryCode] || []).find((question) => question.id === key) || null;
}

function getQuestionLabel(config, categoryCode, key, historicalAnswer) {
  return historicalAnswer?.label
    || getQuestion(config, categoryCode, key)?.label
    || config?.extraConfig?.[key]?.label
    || (key === 'is_calibrated' ? 'Калібрування' : key);
}

function getOptionLabel(config, categoryCode, key, value, answers = {}) {
  if (value === null || value === undefined || value === '') return 'Не вказано';
  const question = getQuestion(config, categoryCode, key);
  const options = question?.options || config?.extraConfig?.[key]?.options || [];
  const candidates = options.filter((option) => sameAnswerValue(option.id, value));
  const contextualOption = candidates.find((option) => (
    option.visible_if_json
    && isRuleMatched(asRuleObject(option.visible_if_json), answers)
  ));
  const option = contextualOption || candidates.find((item) => !item.visible_if_json) || candidates[0];
  if (option?.label) return option.label;
  if (question?.required !== 1 && Number(value) === 0) return 'Не обрано';
  return String(value);
}

function getHistoricalAnswerMap(payload) {
  return new Map(
    (Array.isArray(payload?.decodedAnswers) ? payload.decodedAnswers : [])
      .map((answer) => [answer.key, answer])
  );
}

function getMatrixName(payload, side) {
  const pricing = asObject(payload?.pricing);
  const pricingDetails = asObject(payload?.pricingDetails);
  const name = side === 'old'
    ? pricing.matrixName || pricing.details?.scenario?.name
    : pricingDetails.scenario?.name || pricing.matrixName;
  if (name) return String(name);

  const logMessage = String(payload?.logMessage || pricing.logMessage || '');
  const detailsIndex = logMessage.indexOf(' (');
  return detailsIndex > 0 ? logMessage.slice(0, detailsIndex) : logMessage || null;
}

function normalizeCorrectionRow(row, config) {
  const oldPayload = asObject(row.old_payload);
  const newPayload = asObject(row.new_payload);
  const oldAnswers = asObject(oldPayload.answers);
  const newAnswers = asObject(newPayload.answers);
  const oldAnswerMap = getHistoricalAnswerMap(oldPayload);
  const categoryCode = String(
    row.category_code || newPayload.categoryCode || oldPayload.categoryCode || ''
  ).toUpperCase();
  const changes = getAnswerChanges(oldAnswers, newAnswers).map((change) => {
    const historicalAnswer = oldAnswerMap.get(change.key);
    const fromLabel = historicalAnswer && sameAnswerValue(historicalAnswer.value_id, change.from)
      ? historicalAnswer.value_label
      : getOptionLabel(config, categoryCode, change.key, change.from, oldAnswers);
    return {
      ...change,
      questionLabel: getQuestionLabel(config, categoryCode, change.key, historicalAnswer),
      fromLabel: fromLabel || String(change.from ?? 'Не вказано'),
      toLabel: getOptionLabel(config, categoryCode, change.key, change.to, newAnswers),
    };
  });
  const oldPriceUah = roundUah(oldPayload.totalPriceUah);
  const newPriceUah = roundUah(newPayload.totalPriceUah);
  const storedDelta = Number(row.price_delta_uah);

  return {
    id: Number(row.id),
    sourceProductId: row.source_product_id === null ? null : Number(row.source_product_id),
    correctedProductId: row.corrected_product_id === null
      ? null
      : Number(row.corrected_product_id),
    categoryCode,
    categoryName: config?.categories?.[categoryCode]?.name || categoryCode,
    sourceSku: row.source_sku,
    correctedSku: row.corrected_sku,
    oldPriceUah,
    newPriceUah,
    priceDeltaUah: Number.isFinite(storedDelta)
      ? roundUah(storedDelta)
      : newPriceUah - oldPriceUah,
    oldPricePerGram: oldPayload.pricePerGram ?? oldPayload.pricing?.pricePerGram ?? null,
    newPricePerGram: newPayload.pricePerGram ?? newPayload.pricing?.pricePerGram ?? null,
    oldMatrixName: getMatrixName(oldPayload, 'old'),
    newMatrixName: getMatrixName(newPayload, 'new'),
    weight: newPayload.weight ?? oldPayload.weight ?? null,
    reason: row.reason || '',
    changes,
    createdAt: row.created_at,
  };
}

function normalizeHistoryFilters(filters = {}) {
  const categoryCode = String(filters.category || '').trim().toUpperCase().slice(0, 12);
  const search = String(filters.search || '').trim().slice(0, 120);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (from && !datePattern.test(from)) {
    const error = new Error('Некоректна початкова дата.');
    error.statusCode = 400;
    throw error;
  }
  if (to && !datePattern.test(to)) {
    const error = new Error('Некоректна кінцева дата.');
    error.statusCode = 400;
    throw error;
  }
  if (from && to && from > to) {
    const error = new Error('Початкова дата не може бути пізніше кінцевої.');
    error.statusCode = 400;
    throw error;
  }
  return { categoryCode, search, from, to };
}

function buildHistoryWhere(filters) {
  const values = [];
  const where = [];
  const categoryExpression = `COALESCE(
    NULLIF(pc.new_payload ->> 'categoryCode', ''),
    cp.category,
    sp.category,
    ''
  )`;

  if (filters.categoryCode) {
    values.push(filters.categoryCode);
    where.push(`${categoryExpression} = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    where.push(`(
      pc.source_sku ILIKE $${values.length}
      OR pc.corrected_sku ILIKE $${values.length}
      OR COALESCE(pc.reason, '') ILIKE $${values.length}
    )`);
  }
  if (filters.from) {
    values.push(filters.from);
    where.push(`pc.created_at >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`pc.created_at < ($${values.length}::date + INTERVAL '1 day')`);
  }

  return {
    categoryExpression,
    values,
    sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
  };
}

async function getCorrectionHistory(filters = {}, options = {}) {
  const normalizedFilters = normalizeHistoryFilters(filters);
  const forExport = options.forExport === true;
  const limit = Math.min(Math.max(Math.floor(Number(filters.limit) || 200), 1), 500);
  const offset = Math.max(Math.floor(Number(filters.offset) || 0), 0);
  const where = buildHistoryWhere(normalizedFilters);
  const values = [...where.values];
  let paginationSql = '';
  if (!forExport) {
    values.push(limit, offset);
    paginationSql = `LIMIT $${values.length - 1} OFFSET $${values.length}`;
  }
  const configPromise = getAppConfig();
  const [itemsResult, summaryResult, categoriesResult, config] = await Promise.all([
    pool.query(
      `SELECT pc.*, ${where.categoryExpression} AS category_code
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       ${where.sql}
       ORDER BY pc.created_at DESC, pc.id DESC
       ${paginationSql}`,
      values
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE pc.price_delta_uah > 0)::int AS increased_count,
         COUNT(*) FILTER (WHERE pc.price_delta_uah < 0)::int AS decreased_count,
         COUNT(*) FILTER (WHERE COALESCE(pc.price_delta_uah, 0) = 0)::int AS unchanged_count,
         COALESCE(SUM(pc.price_delta_uah), 0)::numeric AS net_price_delta_uah,
         MIN(pc.created_at) AS first_at,
         MAX(pc.created_at) AS last_at
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       ${where.sql}`,
      where.values
    ),
    pool.query(
      `SELECT ${where.categoryExpression} AS category_code, COUNT(*)::int AS count
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       GROUP BY ${where.categoryExpression}
       ORDER BY category_code`
    ),
    configPromise,
  ]);
  const summary = summaryResult.rows[0];

  return {
    items: itemsResult.rows.map((row) => normalizeCorrectionRow(row, config)),
    summary: {
      totalCount: Number(summary.total_count || 0),
      increasedCount: Number(summary.increased_count || 0),
      decreasedCount: Number(summary.decreased_count || 0),
      unchangedCount: Number(summary.unchanged_count || 0),
      netPriceDeltaUah: roundUah(summary.net_price_delta_uah) || 0,
      firstAt: summary.first_at,
      lastAt: summary.last_at,
    },
    categories: categoriesResult.rows
      .filter((row) => row.category_code)
      .map((row) => ({
        code: row.category_code,
        name: config?.categories?.[row.category_code]?.name || row.category_code,
        count: Number(row.count || 0),
      })),
    limit,
    offset,
  };
}

function getCorrectionChangesText(item) {
  return item.changes
    .map((change) => `${change.questionLabel}: ${change.fromLabel} -> ${change.toLabel}`)
    .join('; ');
}

module.exports = {
  getCorrectionChangesText,
  getCorrectionHistory,
  normalizeCorrectionRow,
  normalizeHistoryFilters,
};
