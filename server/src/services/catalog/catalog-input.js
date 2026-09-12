const { normalizeSkuSeparator } = require('../../utils/sku');

function normalizeInputType(inputType) {
  return String(inputType || 'options').trim().toLowerCase() === 'text' ? 'text' : 'options';
}

function normalizeEditableSkuSeparator(separator) {
  const rawSeparator = String(separator || '').trim();
  const normalizedSeparator = normalizeSkuSeparator(rawSeparator);

  if (rawSeparator && !normalizedSeparator) {
    const err = new Error('Розділювач SKU може містити тільки -, _, . або /');
    err.statusCode = 400;
    throw err;
  }

  return normalizedSeparator;
}

function normalizeCategoryCode(code) {
  return String(code || '').trim().toUpperCase();
}

function normalizeQuestionKey(key) {
  return String(key || '').trim();
}

function getNormalizedQuestionNumbers(payload, includeInSku) {
  const skuIndex = includeInSku === 1 ? Number(payload.sku_index) : 0;
  if (includeInSku === 1 && !Number.isFinite(skuIndex)) {
    const err = new Error('Для питання, яке додається в SKU, потрібен SKU index');
    err.statusCode = 400;
    throw err;
  }

  const displayOrder =
    payload.display_order !== undefined && payload.display_order !== ''
      ? Number(payload.display_order)
      : skuIndex;

  if (!Number.isFinite(displayOrder)) {
    const err = new Error('Потрібен порядок питання у формі');
    err.statusCode = 400;
    throw err;
  }

  return { skuIndex, displayOrder };
}

module.exports = {
  normalizeInputType,
  normalizeEditableSkuSeparator,
  normalizeCategoryCode,
  normalizeQuestionKey,
  getNormalizedQuestionNumbers,
};
