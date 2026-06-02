const normalizeValue = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

export const parseConditionRows = (value) => {
  if (!value) return { isValid: true, rows: [] };

  try {
    const rule = typeof value === 'string' ? JSON.parse(value) : value;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      return { isValid: false, rows: [] };
    }

    return {
      isValid: true,
      rows: Object.entries(rule).map(([key, expected]) => ({
        key,
        values: Array.isArray(expected) ? expected.map(normalizeValue) : [normalizeValue(expected)],
      })),
    };
  } catch {
    return { isValid: false, rows: [] };
  }
};

const toRuleValue = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const numericValue = Number(trimmed);
  return Number.isNaN(numericValue) ? trimmed : numericValue;
};

export const stringifyConditionRows = (rows) => {
  const rule = {};

  rows.forEach((row) => {
    if (!row.key) return;

    const values = row.values
      .map(toRuleValue)
      .filter((value) => value !== '');
    if (values.length === 0) return;

    rule[row.key] = values.length === 1 ? values[0] : values;
  });

  return Object.keys(rule).length > 0 ? JSON.stringify(rule) : '';
};

export const getConditionSources = (questions, config, excludeQuestionId) => {
  const sources = (questions || [])
    .filter((question) => question.id !== excludeQuestionId)
    .map((question) => ({
      key: question.id,
      label: question.label || question.id,
      input_type: question.input_type || 'options',
      options: question.options || [],
    }));

  const calibratedConfig = config?.extraConfig?.is_calibrated;
  const hasCalibratedQuestion = sources.some((source) => source.key === 'is_calibrated');
  if (!hasCalibratedQuestion && calibratedConfig?.options?.length) {
    sources.push({
      key: 'is_calibrated',
      label: calibratedConfig.label || 'Калібрування',
      input_type: 'options',
      options: calibratedConfig.options,
    });
  }

  return sources;
};

export const formatConditionSummary = (value, questions, config, fallback = 'Завжди') => {
  const parsed = parseConditionRows(value);
  if (!parsed.isValid) return 'Некоректна умова';
  if (parsed.rows.length === 0) return fallback;

  const sources = getConditionSources(questions, config);

  return parsed.rows
    .map((row) => {
      const source = sources.find((item) => item.key === row.key);
      const sourceLabel = source?.label || row.key;
      const valueLabels = row.values.map((item) => {
        const option = source?.options?.find(
          (sourceOption) => normalizeValue(sourceOption.id) === normalizeValue(item)
        );
        return option?.label || item;
      });

      return `${sourceLabel} = ${valueLabels.join(' або ')}`;
    })
    .join('; ');
};
