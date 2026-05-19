function asRuleObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function parseOptionalRule(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function normalizeRuleValue(value) {
  if (value === null || value === undefined) return value;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
}

function isRuleMatched(rule, context = {}) {
  if (!rule || typeof rule !== 'object') return true;

  for (const [key, expected] of Object.entries(rule)) {
    const actual = normalizeRuleValue(context[key]);

    if (Array.isArray(expected)) {
      const expectedValues = expected.map((item) => normalizeRuleValue(item));
      if (!expectedValues.includes(actual)) return false;
    } else if (actual !== normalizeRuleValue(expected)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  asRuleObject,
  isRuleMatched,
  parseOptionalRule,
};
