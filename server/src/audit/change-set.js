function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
}

function valuesEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function addAuditChange(changes, field, previousValue, nextValue, options = {}) {
  if (valuesEqual(previousValue, nextValue)) return;
  changes[field] = options.sensitive
    ? { changed: true }
    : { from: previousValue, to: nextValue };
}

module.exports = {
  addAuditChange,
  stableValue,
  valuesEqual,
};
