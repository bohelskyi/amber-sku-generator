export function parseComboAxisKey(axisKey) {
  const keys = String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);

  return keys.length > 1 ? keys : null;
}

export function getPricingAxis(axisKey, questions, fallbackLabel) {
  if (!axisKey) {
    return {
      label: fallbackLabel,
      options: [{ id: 0, label: fallbackLabel }],
    };
  }

  const comboKeys = parseComboAxisKey(axisKey);
  if (!comboKeys) {
    const question = questions.find((item) => item.id === axisKey);
    return {
      label: question?.label || axisKey,
      options: question?.options || [],
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
    const variantOptions = variantQuestion?.options || [];
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
