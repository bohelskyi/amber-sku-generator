const CODE = 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED';
const REASON = 'native characteristics require a reviewed evaluator 5 template and binding successor';
const QUESTIONS = { NM: 'extra', AR: 'size' };

function matchesIssue(issue, category) {
  const key = QUESTIONS[category];
  return Boolean(key && issue?.code === 'SOURCE_SUPPORT_INVALID' && issue.field === 'sourceSupport'
    && issue.message === `${category}.${key}: ${REASON}`);
}

// Derive navigation only from the actual local product, frozen evaluator and
// evaluator diagnostic. A missing answer or a deferred value does not qualify.
function upgradeRequirement(definition, product, evaluation) {
  if (!['magento-declarative-3', 'magento-declarative-4'].includes(definition?.evaluatorVersion)
    || product?.full_sku != null || !product?.characteristic_version_id
    || !QUESTIONS[product.category] || evaluation?.ready !== false
    || !evaluation.evaluationIssues?.some((issue) => matchesIssue(issue, product.category))) return null;
  return { diagnostic: { code: CODE }, question: QUESTIONS[product.category] };
}

function isUpgradeProblem(problem) {
  return problem?.code === 'PRODUCT_EVALUATION_NOT_READY' && problem.diagnosticCode === CODE
    && Object.entries(QUESTIONS).some(([category, key]) => problem.question === key
      && problem.evaluationIssues?.some((issue) => matchesIssue(issue, category)));
}

module.exports = { CODE, REASON, upgradeRequirement, isUpgradeProblem };
