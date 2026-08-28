export function getQuestionLabel(config, categoryCode, key) {
  const question = (config?.questions?.[categoryCode] || []).find((item) => item.id === key);
  return question?.label
    || config?.extraConfig?.[key]?.label
    || (key === 'is_calibrated' ? 'Калібрування' : key);
}

export function getAnswerValueLabel(config, categoryCode, key, value) {
  const question = (config?.questions?.[categoryCode] || []).find((item) => item.id === key);
  const options = question?.options || config?.extraConfig?.[key]?.options || [];
  const option = options.find((item) => Number(item.id) === Number(value));
  if (option) return option.label;
  if (
    question?.required !== 1
    && (value === null || value === undefined || value === '' || Number(value) === 0)
  ) {
    return 'Не обрано';
  }
  if (value === null || value === undefined || value === '') return 'Невідомо';
  return String(value);
}
