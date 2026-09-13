const crypto = require('node:crypto');

const { toUahNumber } = require('../../utils/money');

function stableAnswerEntries(answers = {}) {
  return Object.entries(answers || {})
    .map(([key, value]) => [key, value ?? null])
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey));
}

function getProductStateSignature(product) {
  const relevantState = {
    id: Number(product?.id),
    fullSku: product?.full_sku || null,
    category: product?.category || null,
    weight: product?.weight === null ? null : Number(product?.weight),
    totalPrice: product?.total_price === null ? null : Number(product?.total_price),
    totalPriceUah: product?.total_price_uah === null ? null : Number(product?.total_price_uah),
    pricePerGram: product?.price_per_gram === null ? null : Number(product?.price_per_gram),
    uahRate: product?.uah_rate === null ? null : Number(product?.uah_rate),
    status: product?.status || 'active',
    correctedToProductId: product?.corrected_to_product_id || null,
    schemaVersionId: product?.sku_schema_version_id || null,
    details: product?.details && typeof product.details === 'object' ? product.details : {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevantState)).digest('hex');
}

function getProductPreviewToken(preview, categoryCode, answers, isCalibrated) {
  const payload = {
    categoryCode,
    answers: stableAnswerEntries(answers),
    isCalibrated: Number(answers.is_calibrated ?? isCalibrated ?? 0),
    weight: Number(preview.weightVal || 0),
    skuSchemaVersionId: Number(preview.skuSchemaVersionId),
    baseSku: preview.baseSku,
    mode: preview.mode,
    priceMode: preview.priceMode,
    pricePerGram: preview.pricePerGram,
    fixedPriceUah: preview.fixedPriceUah ?? null,
    totalPrice: preview.totalPrice,
    calculatedPriceUah: preview.calculatedPriceUah ?? null,
    totalPriceUah: preview.totalPriceUah ?? null,
    uahRate: preview.uahRate ?? null,
    uahRateDate: preview.uahRateDate ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getCorrectionPreviewSignature(preview) {
  const snapshot = {
    source: {
      productId: Number(preview?.source?.productId || 0),
      sku: preview?.source?.sku || null,
      totalPriceUah: toUahNumber(preview?.source?.totalPriceUah),
      answers: stableAnswerEntries(preview?.source?.answers),
    },
    corrected: {
      sku: preview?.corrected?.fullSku || null,
      proposedSku: preview?.corrected?.proposedFullSku || null,
      calculatedPriceUah: toUahNumber(preview?.corrected?.calculatedPriceUah),
      autoPriceUah: toUahNumber(preview?.corrected?.autoPriceUah),
      totalPriceUah: toUahNumber(preview?.corrected?.totalPriceUah),
      answers: stableAnswerEntries(preview?.corrected?.answers),
    },
  };

  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

module.exports = {
  getCorrectionPreviewSignature,
  getProductPreviewToken,
  getProductStateSignature,
  stableAnswerEntries,
};
