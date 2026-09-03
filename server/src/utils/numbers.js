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

function parsePositiveDecimal(value, fieldLabel = 'Значення') {
  if (typeof value !== 'number' && typeof value !== 'string') {
    const error = new Error(`${fieldLabel} має бути числом, більшим за 0.`);
    error.statusCode = 400;
    throw error;
  }
  const parsed = parseNonNegativeDecimal(value, fieldLabel);
  if (parsed <= 0) {
    const error = new Error(`${fieldLabel} має бути числом, більшим за 0.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

module.exports = { parseNonNegativeDecimal, parsePositiveDecimal };
