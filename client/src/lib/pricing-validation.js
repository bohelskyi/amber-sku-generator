export function isValidPositivePrice(value) {
  return value !== null
    && value !== undefined
    && String(value).trim() !== ''
    && Number.isFinite(Number(value))
    && Number(value) > 0;
}

export function requiresManualPrice(preview) {
  return Boolean(preview) && !isValidPositivePrice(preview.totalPriceUah);
}
