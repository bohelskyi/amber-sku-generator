export function getValidationIssues(config) {
  const validationIssues = [];
  if (!config?.categories || !config?.questions) return validationIssues;

  Object.values(config.categories).forEach((category) => {
    const questions = config.questions[category.code] || [];
    const keySet = new Set();
    const indexSet = new Set();

    questions.forEach((question) => {
      if (!question.label || question.label.trim().length === 0) {
        validationIssues.push(`Категорія ${category.code}: питання ${question.id} без назви`);
      }
      if (keySet.has(question.id)) {
        validationIssues.push(`Категорія ${category.code}: дубль key ${question.id}`);
      }
      keySet.add(question.id);

      if (question.include_in_sku === 1) {
        if (indexSet.has(question.sku_index)) {
          validationIssues.push(`Категорія ${category.code}: дубль індексу ${question.sku_index}`);
        }
        indexSet.add(question.sku_index);
      }

      if ((question.input_type || 'options') !== 'text' && (!question.options || question.options.length === 0)) {
        validationIssues.push(`Категорія ${category.code}: питання ${question.id} без варіантів`);
      }
    });
  });

  return validationIssues;
}
