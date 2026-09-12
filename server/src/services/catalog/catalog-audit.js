const { addAuditChange } = require('../../audit/change-set');

function buildCategoryChanges(currentCategory, {
  nextCode,
  name,
  requiresWeight,
  skipHiddenSkuQuestions,
}) {
  const changes = {};
  addAuditChange(changes, 'code', currentCategory.code, nextCode);
  addAuditChange(changes, 'name', currentCategory.name, name);
  addAuditChange(
    changes,
    'requiresWeight',
    Number(currentCategory.requires_weight),
    requiresWeight
  );
  addAuditChange(
    changes,
    'skipHiddenSkuQuestions',
    Number(currentCategory.skip_hidden_sku_questions),
    skipHiddenSkuQuestions
  );
  return changes;
}

function buildQuestionChanges(currentQuestion, {
  nextKey,
  label,
  skuIndex,
  displayOrder,
  required,
  includeInSku,
  inputType,
  skuSeparator,
  visibleRule,
}) {
  const changes = {};
  addAuditChange(changes, 'key', currentQuestion.key, nextKey);
  addAuditChange(changes, 'label', currentQuestion.label, label);
  addAuditChange(changes, 'skuIndex', Number(currentQuestion.sku_index), skuIndex);
  addAuditChange(changes, 'displayOrder', Number(currentQuestion.display_order), displayOrder);
  addAuditChange(changes, 'required', Number(currentQuestion.required), required);
  addAuditChange(
    changes,
    'includeInSku',
    Number(currentQuestion.include_in_sku),
    includeInSku
  );
  addAuditChange(changes, 'inputType', currentQuestion.input_type, inputType);
  addAuditChange(changes, 'skuSeparator', currentQuestion.sku_separator || '', skuSeparator);
  addAuditChange(changes, 'visibleRule', currentQuestion.visible_if_json, visibleRule, {
    sensitive: true,
  });
  return changes;
}

function buildOptionChanges(currentOption, {
  valueId,
  skuCode,
  label,
  visibleRule,
  hiddenRule,
  archived,
}) {
  const changes = {};
  addAuditChange(changes, 'valueId', Number(currentOption.value_id), valueId);
  addAuditChange(changes, 'skuCode', currentOption.sku_code, skuCode);
  addAuditChange(changes, 'label', currentOption.label, label);
  addAuditChange(changes, 'visibleRule', currentOption.visible_if_json, visibleRule, {
    sensitive: true,
  });
  addAuditChange(changes, 'hiddenRule', currentOption.hidden_if_json, hiddenRule, {
    sensitive: true,
  });
  addAuditChange(changes, 'archived', Boolean(currentOption.archived), archived);
  return changes;
}

module.exports = {
  buildCategoryChanges,
  buildQuestionChanges,
  buildOptionChanges,
};
