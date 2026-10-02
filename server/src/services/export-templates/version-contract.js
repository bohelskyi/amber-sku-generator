// Versioned integration syntax only. No catalog capture, upgrade or publication.
const EXTENSIBLE_EVALUATOR = 'magento-declarative-4';
const MAX_GROUPS = 64;
const isPublicEvaluator = (version) => ['magento-declarative-3', EXTENSIBLE_EVALUATOR].includes(version);
const isIntegrationCategoryCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
module.exports = { EXTENSIBLE_EVALUATOR, MAX_GROUPS, isPublicEvaluator, isIntegrationCategoryCode };
