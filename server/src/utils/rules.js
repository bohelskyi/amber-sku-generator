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
  const normalizedRule = asRuleObject(rule);
  if (!normalizedRule || typeof normalizedRule !== 'object' || Array.isArray(normalizedRule)) {
    return true;
  }

  for (const [key, expected] of Object.entries(normalizedRule)) {
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some((branch) => isRuleMatched(branch, context))) {
        return false;
      }
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(expected) || !expected.every((branch) => isRuleMatched(branch, context))) {
        return false;
      }
      continue;
    }

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

function getRuleDependencies(rule) {
  const normalizedRule = asRuleObject(rule);
  if (!normalizedRule || typeof normalizedRule !== 'object' || Array.isArray(normalizedRule)) {
    return [];
  }

  const dependencies = [];
  for (const [key, expected] of Object.entries(normalizedRule)) {
    if (key === '$or' || key === '$and') {
      if (Array.isArray(expected)) {
        expected.forEach((branch) => dependencies.push(...getRuleDependencies(branch)));
      }
    } else {
      dependencies.push(key);
    }
  }
  return Array.from(new Set(dependencies));
}

module.exports = {
  asRuleObject,
  getRuleDependencies,
  isRuleMatched,
  parseOptionalRule,
};
