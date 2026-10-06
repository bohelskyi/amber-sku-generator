const { loadMagentoCatalog } = require('../magento-products-v1');
const { loadDraftPreviewProducts } = require('../export-templates/draft-inputs');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { materializeMagentoV1 } = require('../export-templates/magento-v1-definition');
const { compileDefinition } = require('../export-templates/definition');
const { error, identity } = require('./binding-contract');
const { resolveProductLookup } = require('../product/public-identity');

function selection({ sku, productId }) {
  if ((sku !== undefined) === (productId !== undefined)
    || (sku !== undefined && (typeof sku !== 'string' || !sku.trim() || sku.length > 256 || /[\u0000-\u001f\u007f]/.test(sku)))
    || (productId !== undefined && (!Number.isSafeInteger(productId) || productId < 1 || productId > 2147483647))) {
    throw error(422, 'MAGENTO_PREVIEW_SELECTION_INVALID', 'Select exactly one SKU or product ID');
  }
}

async function readPreviewProductOnClient(client, options) {
  selection(options);
    const resolved = options.sku !== undefined ? await resolveProductLookup(client, options.sku) : null;
    const selected = options.sku !== undefined
      ? resolved.product
      : (await client.query(`SELECT p.*, i.public_sku, COALESCE((to_jsonb(i)->>'is_test_product')::boolean,FALSE) AS is_test_product FROM products p
          JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`,
      [options.productId])).rows[0];
    if (!selected) throw error(422, 'MAGENTO_PREVIEW_PRODUCT_NOT_UNIQUE', 'Product selection must match exactly one Amber product');
    // An ID or an internal-SKU lookup must not hide historical duplicates. A
    // public lookup is intentionally resolved through the one-current invariant.
    if (selected.full_sku != null && (options.productId !== undefined || resolved.lookupKind === 'internal')) {
      const duplicates = (await client.query('SELECT id FROM products WHERE full_sku=$1 ORDER BY id LIMIT 2', [selected.full_sku])).rows;
      if (duplicates.length !== 1) throw error(422, 'MAGENTO_PREVIEW_PRODUCT_NOT_UNIQUE', 'Amber SKU is not unique');
    }
    const revision = options.bindingRevisionId
      ? await require('./binding.service').readRevisionOnClient(client, options.bindingRevisionId) : null;
    if (revision && options.templateVersionId && options.templateVersionId !== revision.templateVersionId) {
      throw error(422, 'MAGENTO_PREVIEW_TEMPLATE_MISMATCH', 'Binding and requested template differ');
    }
    const versionId = revision?.templateVersionId || options.templateVersionId;
    let compiled; let template;
    if (versionId) {
      identity(versionId);
      const row = (await client.query('SELECT * FROM export_template_versions WHERE id=$1', [versionId])).rows[0];
      if (!row) throw error(404, 'TEMPLATE_VERSION_NOT_FOUND', 'Published template not found');
      compiled = compileDefinition(row.definition);
      if (compiled.hash !== row.definition_hash || compiled.definition.evaluatorVersion !== row.evaluator_version
        || compiled.definition.outputContract !== row.output_contract || compiled.definition.formatVersion !== row.format_version
        || (revision && (revision.definitionHash !== compiled.hash || revision.templateId !== row.template_id))) {
        throw error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Template identity is inconsistent');
      }
      template = { kind: 'published', versionId, definitionHash: compiled.hash };
    } else {
      compiled = compileDefinition(materializeMagentoV1(await loadMagentoCatalog(client), { publicSku: true }));
      template = { kind: 'system', definitionHash: compiled.hash };
    }
    const loaded = await loadDraftPreviewProducts(client, [selected.id]);
    const supported = await loadSupportInputs(client, compiled.definition, loaded.products);
    const exportState = (await client.query(`SELECT route, hold_reason, source_correction_id,
      business_exclusion_state, recount_compatibility_excluded,
      evidence->'independentExclusion' AS "independentExclusion"
      FROM product_full_export_state WHERE product_id=$1`, [selected.id])).rows[0] || null;
    // Preserve the loader's private historical-schema association. Spreading this
    // object discards source-support proof, including NM's optional zero placeholder.
    const product = Object.assign(supported.products[0], selected, { exportState });
    if (revision) {
      const pin = (await client.query('SELECT generated,effective_names FROM magento_binding_name_pins WHERE binding_revision_id=$1 AND product_id=$2', [revision.id,selected.id])).rows[0];
      if (pin) product.magento_name_rule_pin = { generated: pin.generated, values: pin.effective_names };
    }
    const nameState = revision ? await require('./name-state').readNameState(client, revision.originHash,
      selected.public_product_identity_id, { lock: options.lockNameState === true }) : null;
    const observedAt = (await client.query('SELECT transaction_timestamp() AS observed_at')).rows[0].observed_at.toISOString();
    const result = { product, compiled, template, revision, observedAt, nameState };
     await require('./native-identity-ownership').load(client, result, revision?.originHash);
     return result;
}
async function readPreviewProduct(databasePool, options) {
  selection(options);
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readPreviewProductOnClient(client, options);
    await client.query('COMMIT');
    return result;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {});
    throw cause;
  } finally { client.release(); }
}
module.exports = { selection, readPreviewProduct, readPreviewProductOnClient };
