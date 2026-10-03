const pool = require('../../db/pool');
const c = require('./binding-contract');
const bindings = require('./binding.service');
const { getAppConfig } = require('../catalog/catalog-read-model');
const { compileDefinition } = require('../export-templates/definition');
const { loadDraftPreviewProducts } = require('../export-templates/draft-inputs');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { evaluate } = require('./binding-evidence-products');
const { semanticReadiness, boundedGet, previewView } = require('./integration-readiness');
const { createMagentoClient } = require('./client');
const { auditMagentoSchema } = require('./schema-audit');
const { indexTrees } = require('./sync-preview-categories');
const { assertEvidenceSafe } = require('./binding-evidence-audit');

async function read(options, operation) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await operation(client); await client.query('COMMIT'); return result;
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}
async function selected(client, config, id) {
  if (id) c.identity(id);
  const row = id ? { id } : (await client.query(`SELECT id FROM magento_binding_revisions
    WHERE state='published' AND origin_hash=$1
      AND installation_key=(SELECT installation_key FROM magento_auto_sync_activation WHERE singleton)
    ORDER BY version_number DESC LIMIT 1`,
  [config.configured ? c.originHash(config.baseUrl) : ''])).rows[0];
  if (!row) return null;
  const revision = await bindings.readRevisionOnClient(client, row.id);
  if (!config.configured || revision.originHash !== c.originHash(config.baseUrl)) {
    throw c.error(422, 'MAGENTO_BINDING_INSTALLATION_OR_SCOPE_MISMATCH', 'Binding does not match configured Magento');
  }
  return revision;
}
async function compiledRevision(client, revision) {
  const row = (await client.query('SELECT * FROM export_template_versions WHERE id=$1', [revision.templateVersionId])).rows[0];
  const compiled = row && compileDefinition(row.definition);
  if (!compiled || compiled.hash !== revision.definitionHash || row.definition_hash !== compiled.hash
    || row.evaluator_version !== compiled.definition.evaluatorVersion || row.output_contract !== compiled.definition.outputContract) {
    throw c.error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Template identity changed');
  }
  return { compiled, template: { kind: 'published', versionId: row.id, definitionHash: compiled.hash } };
}
async function overview(config, input = {}, options = {}) {
  c.command(input, [], ['bindingRevisionId']);
  return read(options, async (client) => {
    const catalog = await getAppConfig(client);
    const revision = await selected(client, config, input.bindingRevisionId);
    const current = revision ? await require('./binding-repository').current(client, revision.installationKey) : null;
    const schemas = (await client.query(`SELECT id,category_code,version,published_at FROM sku_schema_versions
      WHERE status='active' ORDER BY category_code,version DESC`)).rows;
    const revisions = (await client.query(`SELECT id,state,revision,version_number,template_version_id,observed_at
      FROM magento_binding_revisions WHERE origin_hash=$1 ORDER BY created_at DESC LIMIT 100`,
    [config.configured ? c.originHash(config.baseUrl) : ''])).rows;
    const templateVersions = (await client.query(`SELECT v.id,v.template_id,v.version_number,v.evaluator_version,t.display_name
      FROM export_template_versions v JOIN export_templates t ON t.id=v.template_id ORDER BY v.published_at DESC LIMIT 100`)).rows;
    const totals = (await client.query(`SELECT category,count(*)::int AS total FROM products
      WHERE status='active' AND exclude_from_export=0 GROUP BY category ORDER BY category`)).rows;
    const samples = (await client.query(`SELECT id FROM products WHERE status='active' AND exclude_from_export=0
      ORDER BY category,id LIMIT 100`)).rows;
    const local = {}; const amber = revision ? await compiledRevision(client, revision) : null;
    if (revision && samples.length) {
      const loaded = await loadDraftPreviewProducts(client, samples.map((p) => p.id));
      const supported = await loadSupportInputs(client, amber.compiled.definition, loaded.products);
      for (const p of supported.products) {
        const count = local[p.category] ||= { checked: 0, evaluated: 0, blocked: 0 };
        count.checked++; count[evaluate(amber, p).ready ? 'evaluated' : 'blocked']++;
      }
    }
    const observedAt = (await client.query('SELECT transaction_timestamp() AS at')).rows[0].at.toISOString();
    return { observedAt, configured: config.configured, revision, currentPublishedId: current?.id || null, revisions, templateVersions,
      categories: semanticReadiness(catalog, schemas, revision, amber?.compiled.definition), catalog,
      products: totals.map((t) => ({ category: t.category, total: t.total,
        ...(local[t.category] || { checked: 0, evaluated: 0, blocked: 0 }),
        unexamined: t.total - (local[t.category]?.checked || 0), remoteChecked: 0 })),
      limitations: ['Структурна та локальна перевірка не підтверджують готовність доставки. Magento перевіряється лише окремим preview.',
        'Збережений стан Magento є спостереженням на вказану дату.'] };
  });
}
async function discovery(config, options = {}) {
  const fetchImpl = boundedGet(options.fetchImpl);
  const schema = c.normalizeSchema(await auditMagentoSchema(config, { fetchImpl, storeCode: 'all' }));
  const client = createMagentoClient(config, { fetchImpl, storeCode: 'all' });
  const roots = [...new Set(schema.storeTopology.storeGroups.map((g) => g.root_category_id).filter((v) => v > 0))];
  if (roots.length > 100) c.invalid();
  const trees = [];
  for (const root of roots) {
    const tree = await client.getCategoryTree(root);
    if (Number(tree.id) !== root) c.invalid(); trees.push(tree);
  }
  const result = { observedAt: new Date().toISOString(), schema, categories: indexTrees(trees),
    consistency: 'sequential_gets', fingerprint: c.hash(schema) };
  assertEvidenceSafe(result, config); return result;
}
async function creationInputs(input, options = {}) {
  c.command(input, ['categoryCode']);
  if (typeof input.categoryCode !== 'string' || !input.categoryCode || input.categoryCode.length > 64) c.invalid();
  return read(options, async (client) => {
    const config = await require('../sku-schema.service').getPublicConfig(client);
    const category = input.categoryCode;
    if (!Object.hasOwn(config.categories, category)) {
      throw c.error(404, 'MAGENTO_CREATION_CATEGORY_NOT_FOUND', 'Категорію не знайдено.');
    }
    const requirements = require('../product/new-product-readiness').requirements;
    return { categories: { [category]: config.categories[category] },
      questions: { [category]: config.questions[category] || [] },
      productCreateRequirements: Object.hasOwn(requirements, category) ? { [category]: requirements[category] } : {} };
  });
}
async function currentPreview(config, input, options = {}) {
  c.command(input, ['productId'], ['bindingRevisionId']);
  const revision = await read(options, (client) => selected(client, config, input.bindingRevisionId));
  if (!revision) throw c.error(422, 'MAGENTO_BINDING_REQUIRED', 'Published or draft binding required');
  return previewView(await require('./sync-preview').previewProduct(config, { databasePool: options.databasePool || pool,
    fetchImpl: boundedGet(options.fetchImpl), productId: input.productId, bindingRevisionId: revision.id }));
}
async function prospectivePreview(config, input, options = {}) {
  c.command(input, ['bindingRevisionId','product'], ['pricingDecision']);
  c.command(input.product, ['categoryCode','answers'], ['weight','isCalibrated','magentoNameSubjectUa','magentoNameSubjectEn']);
  const amber = await read(options, async (client) => {
    const revision = await selected(client, config, input.bindingRevisionId);
    const context = await compiledRevision(client, revision);
    const decision = input.pricingDecision === undefined ? null : require('../product/correction-pricing-decision').normalizePricingDecision(input.pricingDecision);
    const built = await require('../product.service').buildNewProductPreview({ ...input.product,
      magento_name_subject_ua: input.product.magentoNameSubjectUa,
      magento_name_subject_en: input.product.magentoNameSubjectEn }, { queryable: client, pricingDecision: decision });
    const product = { id: null, public_sku: 'AG-PREVIEW', full_sku: built.fullProposedSku,
      category: input.product.categoryCode, status: 'active', exclude_from_export: 0,
      sku_schema_version_id: built.skuSchemaVersionId, weight: built.weightVal,
      total_price_uah: decision?.mode === 'manual_uah' ? decision.manualPriceUah : built.totalPriceUah,
      details: { answers: input.product.categoryCode === 'SV'
        ? require('../product/product-answers').normalizeProductInputAnswers('SV', input.product.answers) : input.product.answers },
      magento_name_subject_ua: built.newProductInput?.names.ua ?? null,
      magento_name_subject_en: built.newProductInput?.names.en ?? null };
    const supported = await loadSupportInputs(client, context.compiled.definition, [product]);
    return { ...context, revision, product: supported.products[0], observedAt: new Date().toISOString() };
  });
  const fetchImpl = boundedGet(options.fetchImpl);
  const observed = await (options.discover || discovery)(config, { fetchImpl });
  const domainEvidence = await require('./sync-preview-domains').readDomains(config, {
    client: createMagentoClient(config, { fetchImpl }), schema: observed.schema, sku: amber.product.public_sku,
    raw: null, expected: evaluate(amber, amber.product), fetchImpl });
  const report = require('./sync-preview').planPreview(amber, observed.schema, null, observed.categories, { domainEvidence });
  assertEvidenceSafe(report, config);
  return { ...previewView(report), hypothetical: true, limitations: ['Артикул AG-PREVIEW умовний. Товар, SKU та завдання синхронізації не створюються.'] };
}
module.exports = { overview, discovery, creationInputs, currentPreview, prospectivePreview, selected, compiledRevision, read };
