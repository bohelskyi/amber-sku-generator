const c = require('../magento/binding-contract');
const { compileDefinition } = require('../export-templates/definition');
const { POLICY, validPair } = require('../export-templates/effective-product-names');
const { evaluate } = require('../magento/binding-evidence-products');
const { loadSupportInputs, loadProspectiveSupportInput } = require('../export-templates/support-inputs');

// The current published binding is the authority. No activation, publication,
// remote request or mutable template draft can be substituted here.
async function current(queryable, { config = require('../../config/env').magento, lock = false } = {}) {
  if (!config.configured) return null;
  let activation = (await queryable.query('SELECT installation_key FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  if (!activation?.installation_key) return null;
  if (lock) {
    await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${activation.installation_key}`]);
    const fresh = (await queryable.query('SELECT installation_key FROM magento_auto_sync_activation WHERE singleton FOR SHARE')).rows[0];
    if (fresh?.installation_key !== activation.installation_key) throw c.error(409, 'PRODUCT_NAMES_STALE', 'Відповідності змінилися. Повторіть перевірку.');
    activation = fresh;
  }
  const row = (await queryable.query(`SELECT to_jsonb(b) AS binding,to_jsonb(v) AS template
    FROM magento_binding_revisions b JOIN export_template_versions v ON v.id=b.template_version_id
    WHERE b.installation_key=$1 AND b.state='published' ORDER BY b.version_number DESC LIMIT 1`, [activation.installation_key])).rows[0];
  if (!row || row.binding.origin_hash !== c.originHash(config.baseUrl)) return null;
  const { binding, template } = row;
  const compiled = compileDefinition(template.definition);
  if (compiled.hash !== template.definition_hash || compiled.hash !== binding.template_definition_hash
    || template.template_id !== binding.template_id || template.evaluator_version !== binding.evaluator_version
    || compiled.definition.evaluatorVersion !== template.evaluator_version || compiled.definition.outputContract !== template.output_contract
    || template.output_contract !== binding.output_contract || compiled.definition.formatVersion !== template.format_version
    || template.format_version !== binding.format_version) throw c.error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Опублікована версія шаблону не пройшла перевірку.');
  if (compiled.definition.nameReadiness !== POLICY) return null;
  return { compiled, binding, metadata: { policy: POLICY, bindingRevisionId: binding.id,
    templateVersionId: template.id, definitionHash: compiled.hash } };
}
async function availability(queryable, options = {}) {
  const context = await current(queryable, options);
  return context ? { available: true, ...context.metadata } : { available: false };
}
function manualNames(value) {
  if (value === undefined) return null;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['all', 'en'].includes(key)) || !validPair(value)) {
    throw c.error(422, 'PRODUCT_NAMES_INVALID', 'Введіть повні українську та англійську назви (до 1024 символів, без переносів рядка).');
  }
  return { all: value.all, en: value.en };
}
function view(mapped) {
  const names = { all: mapped.base.name ?? null, en: mapped.english.name ?? null };
  return { names, generated: mapped.generatedNames, ready: validPair(names) && !mapped.issueFields.includes('name'),
    source: mapped.nameSource || (mapped.generatedNames && mapped.generatedNames.all === names.all && mapped.generatedNames.en === names.en ? 'template' : 'stored_full_names') };
}
async function prospective(queryable, context, payload, preview) {
  let product = { id: null, public_sku: 'AG-PREVIEW', full_sku: preview.fullProposedSku,
    category: String(payload.categoryCode).trim().toUpperCase(), status: 'active', exclude_from_export: 0,
    sku_schema_version_id: preview.skuSchemaVersionId, weight: preview.weightVal, total_price_uah: preview.totalPriceUah,
    details: { answers: preview.normalizedAnswers || payload.answers },
    magento_name_subject_ua: payload.magento_name_subject_ua || null, magento_name_subject_en: payload.magento_name_subject_en || null };
  product = preview.mode === 'public_identity'
    ? await loadProspectiveSupportInput(queryable, context.compiled.definition, product, preview.characteristicConfigHash)
    : (await loadSupportInputs(queryable, context.compiled.definition, [product])).products[0];
  const generated = evaluate(context, product);
  const supplied = manualNames(payload.magentoNames);
  if (supplied && view(generated).ready) throw c.error(422, 'PRODUCT_NAMES_ALREADY_AVAILABLE', 'Шаблон уже сформував повні назви. Перевірте їх перед збереженням.');
  if (supplied) product.magento_name_override = { generated: generated.generatedNames, values: supplied };
  return { ...view(supplied ? evaluate(context, product) : generated), manualNames: supplied, hypothetical: true };
}
async function completeCreated(queryable, context, productId, supplied, actorUserId) {
  const amber = await require('../magento/sync-preview-db').readPreviewProductOnClient(queryable,
    { productId, bindingRevisionId: context.binding.id });
  const generated = evaluate(amber, amber.product);
  if (supplied) {
    const override = { generated: generated.generatedNames, values: manualNames(supplied) };
    amber.product.magento_name_override = override;
    if (!view(evaluate(amber, amber.product)).ready) throw c.error(422, 'PRODUCT_NAMES_REQUIRED', 'Шаблон не підтверджує повні назви товару.');
    await queryable.query('UPDATE products SET magento_name_override=$2::jsonb,magento_name_review_required=FALSE WHERE id=$1', [productId, JSON.stringify(override)]);
    await require('../magento/name-state').auditName(queryable, actorUserId, amber.product, 'completed', { source: 'manual_full_names', after: supplied });
  } else if (!view(generated).ready) throw c.error(422, 'PRODUCT_NAMES_REQUIRED', 'Потрібні повні українська та англійська назви товару.');
}
module.exports = { current, availability, manualNames, view, prospective, completeCreated };
