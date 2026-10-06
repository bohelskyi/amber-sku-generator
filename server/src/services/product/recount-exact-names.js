const configuration = require('../../config/env');
const { read, validateNames } = require('../magento/product-names.service');
const { nameStateEvidence } = require('../magento/name-state');
const { evaluate } = require('../magento/binding-evidence-products');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { same } = require('../magento/name-reconciliation');
const c = require('../magento/binding-contract');

async function recountExactNames(client, source, target, { lock, nameChange, nameConfig = configuration.magento } = {}) {
  if (!source.public_product_identity_id) return null;
  const current = await read(Number(source.id), { queryable: client, config: nameConfig,
    internal: true, allowUnavailable: true, lockNameState: lock });
  const selected = nameChange === undefined ? current.names : validateNames(nameChange);
  const changed = !same(selected, current.names);
  if (changed && current.nameConflict) {
    throw c.error(409, 'RECOUNT_NAME_CONFLICT', 'Спочатку узгодьте назву в розділі «Проблеми синхронізації».');
  }
  const candidate = { ...current.amber.product, full_sku: target.fullSku, public_sku: target.publicSku,
    weight: target.weight, sku_schema_version_id: target.skuSchemaVersionId,
    characteristic_version_id: null,
    details: { ...current.amber.product.details, answers: target.answers }, magento_name_override: null };
  const supported = await loadSupportInputs(client, current.amber.compiled.definition, [candidate]);
  const generated = evaluate(current.amber, supported.products[0]).generatedNames || {};
  return { source: current.names, next: selected, changed, conflict: current.nameConflict,
    override: selected ? { generated, values: selected } : source.magento_name_override ?? null,
    evidence: { template: current.amber.template, bindingId: current.amber.revision?.id ?? null,
      state: nameStateEvidence(current.amber.nameState), names: current.names, selected, generated } };
}
module.exports = { recountExactNames };
