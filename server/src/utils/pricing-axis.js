function parseComboAxisKey(axisKey) {
  const keys = String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);

  return keys.length > 1 ? keys : null;
}

function resolveAxisValue(axisKey, answers = {}) {
  if (!axisKey) return 0;

  const comboKeys = parseComboAxisKey(axisKey);
  if (!comboKeys) return Number(answers[axisKey] || 0);

  if (comboKeys.length === 2) {
    const [flagKey, variantKey] = comboKeys;
    const flagValue = Number(answers[flagKey] || 0) === 1 ? 1 : 0;
    const variantValue = Number(answers[variantKey] || 0);

    return (variantValue * 2) + flagValue + 1;
  }

  const mask = comboKeys.reduce((value, key, index) => {
    const isActive = Number(answers[key] || 0) === 1;
    return isActive ? value + (2 ** index) : value;
  }, 0);

  return mask + 1;
}

module.exports = {
  parseComboAxisKey,
  resolveAxisValue,
};
