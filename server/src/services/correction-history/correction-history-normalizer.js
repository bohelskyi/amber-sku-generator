const { getAnswerChanges } = require('../../utils/answer-changes');
const { asRuleObject, isRuleMatched } = require('../../utils/rules');
const { toUahNumber } = require('../../utils/money');

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
  const oldPriceUah = toUahNumber(oldPayload.totalPriceUah);
  const newPriceUah = toUahNumber(newPayload.totalPriceUah);
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
      ? toUahNumber(storedDelta)
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

module.exports = {
  normalizeCorrectionRow,
};
