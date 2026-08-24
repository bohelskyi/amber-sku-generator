export function parseComboAxisKey(axisKey) {
  const keys = String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);

  return keys.length > 1 ? keys : null;
}

const asRuleObject = (value) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeRuleValue = (value) => {
  if (value === null || value === undefined) return value;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
};

const asRuleValues = (value) => (
  (Array.isArray(value) ? value : [value]).map(normalizeRuleValue)
);

const isRuleCompatibleWithContext = (ruleValue, contextValue) => {
  const rule = asRuleObject(ruleValue);
  const context = asRuleObject(contextValue);

  return Object.entries(rule).every(([key, expected]) => {
    if (!Object.hasOwn(context, key)) return true;

    const expectedValues = asRuleValues(expected);
    const contextValues = asRuleValues(context[key]);
    return expectedValues.some((value) => contextValues.includes(value));
  });
};

const getRuleSpecificity = (ruleValue, contextValue) => {
  const rule = asRuleObject(ruleValue);
  const context = asRuleObject(contextValue);

  return Object.keys(rule).filter((key) => Object.hasOwn(context, key)).length;
};

const getContextualOptions = (options = [], context = {}) => {
  const compatibleOptions = options.filter((option) => (
    isRuleCompatibleWithContext(option.visible_if_json, context)
  ));
  const optionsByValue = new Map();

  compatibleOptions.forEach((option) => {
    const key = String(normalizeRuleValue(option.id));
    const specificity = getRuleSpecificity(option.visible_if_json, context);
    const current = optionsByValue.get(key);

    if (!current || specificity > current.specificity) {
      optionsByValue.set(key, { option, specificity });
    }
  });

  return [...optionsByValue.values()].map(({ option }) => option);
};

export function getPricingAxis(
  axisKey,
  questions,
  fallbackLabel,
  weightBands = [],
  scenarioContext = {}
) {
  if (!axisKey) {
    return {
      label: fallbackLabel,
      options: [{ id: 0, label: fallbackLabel }],
    };
  }

  const comboKeys = parseComboAxisKey(axisKey);
  if (!comboKeys) {
    const question = questions.find((item) => item.id === axisKey);
    if (axisKey === 'weight_band') {
      return {
        label: 'Діапазон ваги',
        options: weightBands.map((band) => ({
          id: Number(band.id),
          label: band.label,
        })),
      };
    }
    if (axisKey === 'weight') {
      return {
        label: question?.label || 'Вага',
        options: [{ id: 0, label: 'Ціна за грам' }],
      };
    }

    return {
      label: question?.label || axisKey,
      options: getContextualOptions(question?.options, scenarioContext),
    };
  }

  if (comboKeys.length === 2) {
    const [flagKey, variantKey] = comboKeys;
    const flagQuestion = questions.find((item) => item.id === flagKey);
    const variantQuestion = questions.find((item) => item.id === variantKey);
    const flagLabel =
      flagQuestion?.options?.find((option) => Number(option.id) === 1)?.label ||
      flagQuestion?.label ||
      flagKey;
    const variantOptions = getContextualOptions(variantQuestion?.options, scenarioContext);
    const baseOptions = [
      { id: 1, label: 'Базова' },
      { id: 2, label: flagLabel },
    ];
    const variantAxisOptions = variantOptions.flatMap((option) => [
      {
        id: (Number(option.id) * 2) + 1,
        label: option.label,
      },
      {
        id: (Number(option.id) * 2) + 2,
        label: `${flagLabel} + ${option.label}`,
      },
    ]);

    return {
      label: [flagQuestion?.label || flagKey, variantQuestion?.label || variantKey].join(' + '),
      options: [...baseOptions, ...variantAxisOptions],
    };
  }

  const labels = comboKeys.map((key) => {
    const question = questions.find((item) => item.id === key);
    return question?.label || key;
  });
  const optionCount = 2 ** labels.length;

  return {
    label: labels.join(' + '),
    options: Array.from({ length: optionCount }, (_, mask) => {
      const activeLabels = labels.filter((_, index) => (mask & (2 ** index)) !== 0);
      return {
        id: mask + 1,
        label: activeLabels.length > 0 ? activeLabels.join(' + ') : 'Базова',
      };
    }),
  };
}
