export function createRequirements(config, category, answers) {
  const rule = config?.productCreateRequirements?.[category];
  return { requiredAnswers: rule?.requiredAnswers || [],
    namesRequired: Boolean(rule?.automaticName
      && !rule.automaticName.values.includes(String(answers?.[rule.automaticName.question]))) };
}
