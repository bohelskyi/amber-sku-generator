export function createRequirements(config, category, answers, preview = null, names = {}) {
  const rule = config?.productCreateRequirements?.[category];
  const optionalAnswers = Object.entries(rule?.optionalAnswersWhen || {}).filter(([, condition]) =>
    condition.values.includes(String(answers?.[condition.question]))).map(([key]) => key);
  const fullNames = config?.productNameReadiness?.available === true && config.productNameReadiness.policy === 'effective-product-names-v1';
  return { ...(fullNames ? { fullNames: true } : {}), requiredAnswers: (rule?.requiredAnswers || []).filter(key => !optionalAnswers.includes(key)), optionalAnswers,
    namesRequired: fullNames ? preview?.creationNames?.ready === false || Object.values(names).some(value => String(value).trim()) : Boolean(rule?.automaticName
      && !rule.automaticName.values.includes(String(answers?.[rule.automaticName.question]))) };
}

export function isCreateQuestionRequired(question, rules) {
  if (question.input_type === 'text' && question.include_in_sku !== 1 && rules.optionalAnswers.includes(question.id)) return false;
  return question.required === 1 || rules.requiredAnswers.includes(question.id);
}
