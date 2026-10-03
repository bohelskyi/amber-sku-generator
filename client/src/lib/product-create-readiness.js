export function createRequirements(config, category, answers) {
  const rule = config?.productCreateRequirements?.[category];
  const optionalAnswers = Object.entries(rule?.optionalAnswersWhen || {}).filter(([, condition]) =>
    condition.values.includes(String(answers?.[condition.question]))).map(([key]) => key);
  return { requiredAnswers: (rule?.requiredAnswers || []).filter(key => !optionalAnswers.includes(key)), optionalAnswers,
    namesRequired: Boolean(rule?.automaticName
      && !rule.automaticName.values.includes(String(answers?.[rule.automaticName.question]))) };
}

export function isCreateQuestionRequired(question, rules) {
  if (question.input_type === 'text' && question.include_in_sku !== 1 && rules.optionalAnswers.includes(question.id)) return false;
  return question.required === 1 || rules.requiredAnswers.includes(question.id);
}
