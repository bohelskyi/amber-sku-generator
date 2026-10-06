const { compileDefinition, getCompiledSourceDependencies } = require('../export-templates/definition');
const { evaluateProduct } = require('../export-templates/evaluate');
const { projectSupportProducts } = require('../export-templates/source-support');
const { CHARACTERISTIC_CONTRACT } = require('../export-templates/version-contract');
const { CODE, REASON } = require('../magento/native-characteristic-upgrade');
const { originHash } = require('../magento/binding-contract');

const SCOPE = 'native_characteristic_source_support';
const QUESTIONS = { NM: 'extra', AR: 'size' };
const message = 'Товар можна зберегти локально. Передавання цієї характеристики Magento потребує підготовки, перевірки й застосування підтримки характеристик нових товарів.';

// This is a narrow prospective diagnostic, never a complete delivery approval.
// No product/public identity or characteristic publication is created here.
function prospectiveIssues(compiled, categoryCode, preview) {
  const candidate = { category: categoryCode, full_sku: null, public_sku: null,
    weight: preview.weightVal, total_price_uah: preview.totalPriceUah,
    details: { answers: preview.normalizedAnswers || {} } };
  // The old evaluator fails before characteristic evidence is requested. The
  // projection is server-owned; neither fake SKU nor fake version ID is needed.
  const [product] = projectSupportProducts([candidate], []);
  return evaluateProduct(compiled, product).errors;
}
function upgradeIssue(compiled, categoryCode, preview, issues = null) {
  const key = QUESTIONS[categoryCode];
  if (!key || !['magento-declarative-3', 'magento-declarative-4'].includes(compiled.definition.evaluatorVersion)) return null;
  return (issues || prospectiveIssues(compiled, categoryCode, preview)).some(issue => issue.code === 'SOURCE_SUPPORT_INVALID'
    && issue.field === 'sourceSupport' && issue.message === `${categoryCode}.${key}: ${REASON}`) ? key : null;
}

async function readCreationDeliveryReadiness(queryable, categoryCode, preview, { config = require('../../config/env').magento, includeIntegrationDefects = false } = {}) {
  const base = { scope: SCOPE, categoryCode, code: null };
  const unavailable = reasonCode => ({ ...base, status: 'not_checked', reasonCode });
  if (!QUESTIONS[categoryCode] && !includeIntegrationDefects) return unavailable('NATIVE_UPGRADE_CHECK_NOT_APPLICABLE');
  if (!config.configured) return unavailable('MAGENTO_NOT_CONFIGURED');
  const row = (await queryable.query(`SELECT to_jsonb(a) AS activation, to_jsonb(r) AS binding, to_jsonb(v) AS template
    FROM magento_auto_sync_activation a
    LEFT JOIN LATERAL (SELECT * FROM magento_binding_revisions WHERE installation_key=a.installation_key
      AND state='published' ORDER BY version_number DESC LIMIT 1) r ON TRUE
    LEFT JOIN export_template_versions v ON v.id=r.template_version_id WHERE a.singleton`)).rows[0];
  if (!row?.activation?.enabled || row.activation.legacy_product_csv_enabled !== false) return unavailable('MAGENTO_AUTOMATIC_DELIVERY_DISABLED');
  const { binding, template } = row;
  if (!binding || !template || binding.origin_hash !== originHash(config.baseUrl)) return unavailable('MAGENTO_CURRENT_BINDING_UNAVAILABLE');
  let compiled;
  try { compiled = compileDefinition(template.definition); } catch { return unavailable('TEMPLATE_VERSION_INTEGRITY'); }
  if (compiled.hash !== template.definition_hash || compiled.hash !== binding.template_definition_hash
    || template.id !== binding.template_version_id || template.template_id !== binding.template_id
    || compiled.definition.evaluatorVersion !== template.evaluator_version || template.evaluator_version !== binding.evaluator_version
    || compiled.definition.outputContract !== template.output_contract || template.output_contract !== binding.output_contract
    || compiled.definition.formatVersion !== template.format_version || template.format_version !== binding.format_version) {
    return unavailable('TEMPLATE_VERSION_INTEGRITY');
  }
  const metadata = { bindingRevisionId: binding.id, templateVersionId: template.id,
    evaluatorVersion: template.evaluator_version, definitionHash: compiled.hash };
  if (!['magento-declarative-3', 'magento-declarative-4', 'magento-declarative-5'].includes(template.evaluator_version)) {
    return { ...unavailable('NATIVE_UPGRADE_EVALUATOR_UNSUPPORTED'), ...metadata };
  }
  const group = compiled.definition.groups.find(group => group.route === categoryCode);
  if (includeIntegrationDefects && !group) return { ...base, ...metadata, status: 'configuration_required',
    code: 'MAGENTO_CATEGORY_NOT_LINKED', questionKey: null, valueId: null,
    message: 'Категорія ще не підготовлена для Magento. Товар можна зберегти локально.' };
  const issues = prospectiveIssues(compiled, categoryCode, preview);
  const valueId = String(preview.normalizedAnswers?.size ?? '');
  const consumed = issues.some(issue => issue.code === 'SOURCE_SUPPORT_INVALID' && issue.field === 'sourceSupport'
    && [`AR.size: ${REASON}`, 'AR.size: authoritative immutable characteristic version required'].includes(issue.message));
  if (categoryCode === 'AR' && /^(0|[1-9][0-9]*)$/.test(valueId)
    && compiled.definition.sourceSupport?.sources['AR.size']?.deferredValues.includes(valueId) && consumed) {
    return { ...base, ...metadata, status: 'configuration_required', code: 'SOURCE_SUPPORT_DEFERRED_VALUE',
      questionKey: 'size', valueId, message: 'Товар можна зберегти локально. Передавання цього значення Magento заблоковано чинними правилами. Оновлення підтримки характеристик саме по собі не дозволяє це значення: потрібен окремий перегляд значення та відповідності Magento.' };
  }
  const questionKey = upgradeIssue(compiled, categoryCode, preview, issues);
  if (questionKey) return { ...base, ...metadata, status: 'configuration_required', code: CODE, questionKey,
    targetContract: CHARACTERISTIC_CONTRACT, message };
  if (includeIntegrationDefects && group) {
    // Only consumed sources establish export intent. A local unused question is not a missing Magento attribute.
    for (const sourceId of getCompiledSourceDependencies(compiled, [categoryCode])) {
      const source = compiled.definition.sources[sourceId]; const contract = compiled.definition.questionContracts?.[sourceId];
      const selected = preview.normalizedAnswers?.[source?.key];
      if (source?.kind !== 'semantic' || source.category !== categoryCode || selected === undefined || selected === null
        || !/^(0|[1-9][0-9]*)$/.test(String(selected))) continue;
      if (!contract?.exists || !contract.allowed.includes(String(selected))) return { ...base, ...metadata,
        status: 'configuration_required', code: 'MAGENTO_SOURCE_VALUE_NOT_LINKED', questionKey: source.key, valueId: String(selected),
        message: 'Вибране значення характеристики ще не включене до чинної інтеграції Magento. Товар можна зберегти локально.' };
    }
  }
  return { ...base, ...metadata, status: 'no_native_upgrade_blocker' };
}

const readCreationIntegrationReadiness = (db, category, preview, options = {}) =>
  readCreationDeliveryReadiness(db, category, preview, { ...options, includeIntegrationDefects: true });
module.exports = { SCOPE, upgradeIssue, readCreationDeliveryReadiness, readCreationIntegrationReadiness };
