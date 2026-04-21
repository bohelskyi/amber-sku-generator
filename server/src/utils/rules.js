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

module.exports = {
  asRuleObject,
  parseOptionalRule,
};
