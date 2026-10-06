// Versioned integration syntax only. No catalog capture, upgrade or publication.
const EXTENSIBLE_EVALUATOR = 'magento-declarative-4';
const CHARACTERISTIC_EVALUATOR = 'magento-declarative-5';
const CHARACTERISTIC_CONTRACT = 'public-product-characteristics-v1';
const isExtensibleEvaluator = (version) => [EXTENSIBLE_EVALUATOR, CHARACTERISTIC_EVALUATOR].includes(version);
const MAX_GROUPS = 64;
const isPublicEvaluator = (version) => ['magento-declarative-3', EXTENSIBLE_EVALUATOR, CHARACTERISTIC_EVALUATOR].includes(version);
const isIntegrationCategoryCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
module.exports = { CHARACTERISTIC_EVALUATOR, CHARACTERISTIC_CONTRACT, isExtensibleEvaluator, EXTENSIBLE_EVALUATOR, MAX_GROUPS, isPublicEvaluator, isIntegrationCategoryCode };
