export const asRuleObject = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const normalizeRuleValue = (value) => {
  if (value === null || value === undefined) return value;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
};

const asRuleValues = (value) => (
  (Array.isArray(value) ? value : [value]).map(normalizeRuleValue)
);

const getRuleParts = (ruleValue) => {
  const rule = asRuleObject(ruleValue);
  const entries = Object.entries(rule).filter(([key]) => key !== '$or' && key !== '$and');
  const hasAndOperator = Object.hasOwn(rule, '$and');
  const hasOrOperator = Object.hasOwn(rule, '$or');
  const orRules = Array.isArray(rule.$or) ? rule.$or : [];
  const andRules = Array.isArray(rule.$and) ? rule.$and : [];
  return { andRules, entries, hasAndOperator, hasOrOperator, orRules };
};

export const hasRuleConditions = (ruleValue) => {
  const { andRules, entries, orRules } = getRuleParts(ruleValue);
  return entries.length > 0 || andRules.length > 0 || orRules.length > 0;
};

export const isRuleMatched = (ruleValue, context = {}) => {
  const { andRules, entries, hasAndOperator, hasOrOperator, orRules } = getRuleParts(ruleValue);

  const entriesMatch = entries.every(([key, expected]) => {
    const actual = normalizeRuleValue(context[key]);
    return asRuleValues(expected).includes(actual);
  });
  if (!entriesMatch) return false;
  if (hasAndOperator && !Array.isArray(asRuleObject(ruleValue).$and)) return false;
  if (hasOrOperator && !Array.isArray(asRuleObject(ruleValue).$or)) return false;
  if (andRules.length > 0 && !andRules.every((rule) => isRuleMatched(rule, context))) return false;
  if (hasOrOperator && !orRules.some((rule) => isRuleMatched(rule, context))) return false;
  return true;
};

export const isRuleCompatibleWithContext = (ruleValue, contextValue) => {
  const { andRules, entries, orRules } = getRuleParts(ruleValue);
  const context = asRuleObject(contextValue);

  const entriesCompatible = entries.every(([key, expected]) => {
    if (!Object.hasOwn(context, key)) return true;
    const expectedValues = asRuleValues(expected);
    return asRuleValues(context[key]).some((value) => expectedValues.includes(value));
  });

  if (!entriesCompatible) return false;
  if (andRules.length > 0 && !andRules.every((rule) => isRuleCompatibleWithContext(rule, context))) {
    return false;
  }
  if (orRules.length > 0 && !orRules.some((rule) => isRuleCompatibleWithContext(rule, context))) {
    return false;
  }
  return true;
};

export const isRuleGuaranteedByContext = (ruleValue, contextValue) => {
  const { andRules, entries, orRules } = getRuleParts(ruleValue);
  const context = asRuleObject(contextValue);
  if (!hasRuleConditions(ruleValue)) return false;

  const entriesGuaranteed = entries.every(([key, expected]) => {
    if (!Object.hasOwn(context, key)) return false;
    const expectedValues = asRuleValues(expected);
    return asRuleValues(context[key]).every((value) => expectedValues.includes(value));
  });

  if (!entriesGuaranteed) return false;
  if (andRules.length > 0 && !andRules.every((rule) => isRuleGuaranteedByContext(rule, context))) {
    return false;
  }
  if (orRules.length > 0 && !orRules.some((rule) => isRuleGuaranteedByContext(rule, context))) {
    return false;
  }
  return true;
};

export const getRuleDependencies = (ruleValue) => {
  const { andRules, entries, orRules } = getRuleParts(ruleValue);
  const nestedRules = [...andRules, ...orRules];
  return Array.from(new Set([
    ...entries.map(([key]) => key),
    ...nestedRules.flatMap(getRuleDependencies),
  ]));
};
