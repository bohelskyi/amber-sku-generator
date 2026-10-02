function normalizeLabel(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    const error = new Error('Назва варіанта має містити від 1 до 255 символів без крайніх пробілів або керівних символів.');
    error.statusCode = 400; error.code = 'CATALOG_OPTION_LABEL_INVALID'; throw error;
  }
  return value;
}
module.exports = { normalizeLabel };
