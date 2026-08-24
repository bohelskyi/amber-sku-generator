function parseNonNegativeDecimal(value, fieldLabel = 'Значення') {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/,/g, '.')
    : value;
  const parsed = Number(normalized);

  if (normalized === '' || !Number.isFinite(parsed) || parsed < 0) {
    const error = new Error(`${fieldLabel} має бути невід'ємним числом.`);
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

module.exports = { parseNonNegativeDecimal };
