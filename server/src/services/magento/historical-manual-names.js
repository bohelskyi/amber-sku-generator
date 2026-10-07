const missingPair = product => !product.magento_name_subject_ua?.trim() || !product.magento_name_subject_en?.trim();
function available(amber, report) {
  if (amber.product.category !== 'SV' || !(Number(amber.product.weight) > 0)
    || amber.compiled.definition.nameReadiness || !missingPair(amber.product)
    || report.mode !== 'create' || report.identity?.state !== 'absent' || report.identity.confirmedMagentoId != null) return false;
  const evaluation = report.blockers.filter(b => b.code === 'PRODUCT_EVALUATION_NOT_READY');
  if (evaluation.length !== 1 || !evaluation[0].evaluationIssues?.length
    || evaluation[0].evaluationIssues.some(issue => issue.code !== 'manual_name_required' || issue.field !== 'name')) return false;
  return report.blockers.every(b => b.code === 'PRODUCT_EVALUATION_NOT_READY'
    || b.code === 'REQUIRED_NATIVE_FIELD_MISSING' && b.field === 'name'
    || b.code === 'REQUIRED_ATTRIBUTE_VALUE_MISSING' && b.target === 'name');
}
module.exports = { available, missingPair };
