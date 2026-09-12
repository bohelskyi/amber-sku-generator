const EXPRESSION_KEYS = new Set([
  'Filter',
  'Index Cond',
  'Hash Cond',
  'Join Filter',
  'Merge Cond',
  'Output',
  'Recheck Cond',
  'Sort Key',
  'Group Key',
]);

function sanitizeExpression(value) {
  return String(value)
    .replace(/'(?:''|[^'])*'/g, "'<redacted>'")
    .replace(/\b(?:[0-9]+(?:\.[0-9]+)?)\b/g, '<number>');
}

function sanitizePlan(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => sanitizePlan(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizePlan(childValue, childKey),
      ])
    );
  }
  if (typeof value === 'string' && EXPRESSION_KEYS.has(key)) {
    return sanitizeExpression(value);
  }
  return value;
}

module.exports = { sanitizeExpression, sanitizePlan };
