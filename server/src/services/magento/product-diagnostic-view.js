const { presentProblem, safeDiagnostics } = require('./sync-problems');

const labels = { name: 'Назва товару', price: 'Ціна', weight: 'Вага', sku: 'Артикул',
  attribute_set_code: 'Набір характеристик', categories: 'Категорії Magento',
  kamin_obrobka: 'Обробка каменю', rozmir_suveniriv: 'Розмір', product_online: 'Доступність товару',
  visibility: 'Видимість товару', product_type: 'Тип товару', description: 'Опис', short_description: 'Короткий опис' };
const text = (value) => typeof value === 'string' ? value.slice(0, 2000) : null;
function displayValue(value) {
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(displayValue).filter((item) => item !== null);
  return null;
}
function sourceContext(attribute) {
  const semantic = (attribute?.source || []).filter((source) => source.kind === 'semantic' && source.questionKey);
  if (semantic.length !== 1) return {};
  return { question: text(semantic[0].questionKey),
    ...(['string', 'number'].includes(typeof semantic[0].storedValue) ? { value: String(semantic[0].storedValue).slice(0, 500) } : {}) };
}
function diagnosticProblem(problem, report) {
  const safe = safeDiagnostics([problem])[0];
  const target = safe.target || safe.field;
  const attribute = report.attributes.find((item) => item.target === target || item.magentoAttributeCode === target);
  return { ...presentProblem({ ...problem, ...safe }),
    ...(target ? { fieldLabel: labels[target] || text(attribute?.magentoAttributeLabel) || target } : {}),
    ...sourceContext(attribute),
    ...(attribute && attribute.evaluatedValue !== null && attribute.evaluatedValue !== undefined
      ? { expectedValue: displayValue(attribute.resolvedOptionLabel ?? attribute.evaluatedValue) } : {}) };
}
function comparisons(report) {
  const result = report.attributes.filter((attribute) => !['categories', 'qty', 'is_in_stock', 'product_websites', 'store_view_code'].includes(attribute.target)).map((attribute) => {
    const diff = report.diff?.find((item) => item.target === attribute.target);
    const ownership = report.fieldOwnership?.find((item) => item.target === attribute.target);
    const set = attribute.target === 'attribute_set_code';
    const current = set ? report.attributeSet.currentMagentoSet?.name ?? report.attributeSet.currentMagentoSet?.id
      : attribute.currentResolvedOptions?.length ? attribute.currentResolvedOptions.map((option) => option.label ?? `Magento #${option.optionId}`)
        : attribute.currentRawValue;
    const desired = set ? report.attributeSet.selected?.name ?? report.attributeSet.selected?.id
      : attribute.resolvedOptionLabel ?? diff?.candidate ?? attribute.evaluatedValue;
    const blockers = report.blockers.filter((issue) => (issue.target || issue.field || issue.diagnostic?.target) === attribute.target);
    const warnings = report.warnings.filter((issue) => issue.target === attribute.target || set && issue.code === 'PRODUCT_ATTRIBUTE_SET_MISMATCH');
    return { target: attribute.target, label: labels[attribute.target] || text(attribute.magentoAttributeLabel) || attribute.target,
      current: { state: report.mode === 'create' ? 'product_absent' : 'known', value: displayValue(current) },
      expected: { state: desired === undefined || desired === null ? 'unresolved' : 'known', value: displayValue(desired) },
      action: diff?.action || ownership?.action || 'unresolved', policy: ownership?.policy || 'unknown',
      policyState: ownership?.persistedDecision?.reviewState ?? null,
      includedInPayload: diff?.includedInPayload === true,
      severity: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'info',
      ...sourceContext(attribute) };
  });
  if (report.categories) {
    const diff = report.diff?.find((item) => item.target === 'categories');
    const ownership = report.fieldOwnership?.find((item) => item.target === 'categories');
    result.push({ target: 'categories', label: labels.categories,
      current: { state: report.mode === 'create' ? 'product_absent' : report.categories.currentKnown ? 'known' : 'unavailable',
        value: (report.categories.current || []).map((item) => text(item.path) || `Magento #${item.categoryId}`) },
      expected: { state: 'known', value: (report.categories.requested || []).map((item) => text(item.requestedPath)) },
      action: diff?.action || 'unresolved', policy: ownership?.policy || 'unknown', includedInPayload: diff?.includedInPayload === true,
      policyState: ownership?.persistedDecision?.reviewState ?? null,
      severity: report.blockers.some((item) => item.operation === 'categories' || item.code.startsWith('CATEGORY_') || item.code === 'CURRENT_CATEGORY_ASSIGNMENTS_UNAVAILABLE') ? 'blocked' : 'info',
    });
  }
  return result;
}

module.exports = { comparisons, diagnosticProblem };
