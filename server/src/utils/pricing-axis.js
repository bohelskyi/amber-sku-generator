function parseComboAxisKey(axisKey) {
  const keys = String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);

  return keys.length > 1 ? keys : null;
}

function getAxisSourceValue(key, answers = {}, extraValues = {}) {
  const value = answers[key] !== undefined && answers[key] !== null && answers[key] !== ''
    ? answers[key]
    : extraValues[key];

  return value === undefined || value === null || value === '' ? 0 : Number(value);
}

function resolveAxisValue(axisKey, answers = {}, extraValues = {}) {
  if (!axisKey) return 0;

  const comboKeys = parseComboAxisKey(axisKey);
  if (!comboKeys) return getAxisSourceValue(axisKey, answers, extraValues);

  if (comboKeys.length === 2) {
    const [flagKey, variantKey] = comboKeys;
    const flagValue = getAxisSourceValue(flagKey, answers, extraValues) === 1 ? 1 : 0;
    const variantValue = getAxisSourceValue(variantKey, answers, extraValues);

    return (variantValue * 2) + flagValue + 1;
  }

  const mask = comboKeys.reduce((value, key, index) => {
    const isActive = getAxisSourceValue(key, answers, extraValues) === 1;
    return isActive ? value + (2 ** index) : value;
  }, 0);

  return mask + 1;
}

module.exports = {
  parseComboAxisKey,
  resolveAxisValue,
};
