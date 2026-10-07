const pool = require('../../db/pool');
const configuration = require('../../config/env');
const c = require('./binding-contract');
const { readPreviewProduct, readPreviewProductOnClient, selection } = require('./sync-preview-db');
const { evaluate } = require('./binding-evidence-products');
const { same } = require('./name-reconciliation');
const { auditName } = require('./name-state');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { readFullProductStates, advanceFullProductRevision } = require('../full-product-export.service');

function validateNames(names) {
  if (!names || typeof names !== 'object' || Array.isArray(names)
    || Object.keys(names).some((key) => !['all', 'en'].includes(key))
    || ['all', 'en'].some((key) => typeof names[key] !== 'string' || !names[key].trim()
      || names[key].length > 1024 || /[\u0000-\u001f\u007f]/.test(names[key]))) {
    throw c.error(422, 'PRODUCT_NAMES_INVALID', 'Введіть українську та англійську назви (до 1024 символів, без переносів рядка).');
  }
  return { all: names.all, en: names.en };
}

function validateEvaluatedNames(names, amber, mapped) {
  try { return validateNames(names); }
  catch (error) {
    if (error.code !== 'PRODUCT_NAMES_INVALID') throw error;
    const nameConflict = ['conflict', 'baseline_required'].includes(amber.nameState?.state);
    throw c.error(422, 'PRODUCT_NAMES_INVALID', error.message, {
      nameConflict,
      repair: !nameConflict && mapped.issueFields.includes('name')
        ? amber.compiled?.definition.nameReadiness === require('../export-templates/effective-product-names').POLICY
          ? 'effective_product_names' : amber.product.category === 'SV' ? 'product_magento_name' : null : null,
    });
  }
}

async function read(productId, options = {}) {
  selection({ productId });
  const db = options.queryable || options.databasePool || pool; const config = options.config || configuration.magento;
  const binding = config.configured ? (await db.query(`SELECT b.id FROM magento_binding_revisions b
    JOIN magento_auto_sync_activation a ON a.installation_key=b.installation_key
    WHERE a.singleton AND b.origin_hash=$1 AND b.state='published'
    ORDER BY b.version_number DESC LIMIT 1`, [c.originHash(config.baseUrl)])).rows[0] : null;
  const input = { productId, ...(binding ? { bindingRevisionId: binding.id } : {}), lockNameState: options.lockNameState === true };
  const amber = options.queryable ? await readPreviewProductOnClient(db, input) : await readPreviewProduct(db, input);
  if (!amber.revision && config.configured) amber.nameState = await require('./name-state').readNameState(db,
    c.originHash(config.baseUrl), amber.product.public_product_identity_id, { lock: options.lockNameState === true });
  if (amber.product.status !== 'active' || amber.product.corrected_to_product_id) {
    throw c.error(409, 'PRODUCT_NAMES_RETIRED', 'Відкрийте актуальний товар.');
  }
  const mapped = evaluate(amber, amber.product);
  let names = { all: mapped.base.name, en: mapped.english.name };
  const effective = amber.compiled.definition.nameReadiness === require('../export-templates/effective-product-names').POLICY;
  if (options.allowUnavailable && (!names.all || !names.en)) names = null;
  else validateEvaluatedNames(names, amber, mapped);
  const previewToken = c.hash({ product: amber.product, template: amber.template, bindingId: binding?.id ?? null, names });
  return { productId, names, previewToken, nameConflict: ['conflict', 'baseline_required'].includes(amber.nameState?.state),
    ...(options.readiness && effective ? { readiness: { policy: require('../export-templates/effective-product-names').POLICY,
      ready: require('../product/effective-name-readiness').view(mapped).ready, source: mapped.nameSource || 'template',
      generated: mapped.generatedNames, article: amber.product.public_sku } } : {}),
    ...(options.internal ? { amber, generated: mapped.generatedNames, effective } : {}) };
}

async function save(payload, options = {}) {
  selection({ productId: payload.productId });
  const names = validateNames(payload.names); const db = options.databasePool || pool;
  if (typeof payload.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(payload.previewToken)) {
    throw c.error(422, 'PRODUCT_NAMES_PREVIEW_REQUIRED', 'Оновіть назви перед збереженням.');
  }
  return runAccessAdminMutation({ databasePool: db, actorUserId: options.mutationContext?.actorUserId,
    requiredPermission: 'exports.create', createError: c.error, operation: async (client) => {
      const context = await require('../product/effective-name-readiness').current(client, { config: options.config || configuration.magento, lock: true });
      const product = (await client.query('SELECT * FROM products WHERE id=$1 FOR NO KEY UPDATE', [payload.productId])).rows[0];
      const fresh = await read(payload.productId, { ...options, queryable: client, lockNameState: true, internal: true, allowUnavailable: Boolean(context) });
      if (fresh.effective && (['conflict', 'baseline_required'].includes(fresh.amber.nameState?.state)
        || await require('./name-discovery').unresolvedDispatch(client, fresh.amber.revision.originHash, fresh.amber.product.public_sku))) {
        throw c.error(409, 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED', 'Спочатку узгодьте попередню зміну або конфлікт назв.');
      }
      if (fresh.previewToken !== payload.previewToken || !product
        || c.hash(product) !== c.hash(Object.fromEntries(Object.keys(product).map((key) => [key, fresh.amber.product[key]])))) {
        throw c.error(409, 'PRODUCT_NAMES_STALE', 'Товар або назви змінилися. Оновіть дані та повторіть зміни.');
      }
      if (fresh.effective) {
        // Preserve the private source-support association on the loaded object.
        const previous = fresh.amber.product.magento_name_override;
        const owned = Object.hasOwn(fresh.amber.product, 'magento_name_override');
        let valid;
        try {
          fresh.amber.product.magento_name_override = { generated: fresh.generated, values: names };
          valid = require('../product/effective-name-readiness').view(evaluate(fresh.amber, fresh.amber.product)).ready;
        } finally {
          if (owned) fresh.amber.product.magento_name_override = previous; else delete fresh.amber.product.magento_name_override;
        }
        if (!valid) throw c.error(422, 'PRODUCT_NAMES_REQUIRED', 'Опубліковані правила не підтверджують цю пару назв.');
      }
      if (!same(names, fresh.names)) {
        await client.query('UPDATE products SET magento_name_override=$2::jsonb,magento_name_review_required=FALSE WHERE id=$1',
          [product.id, JSON.stringify({ generated: fresh.generated, values: names })]);
        const [lifecycle] = await readFullProductStates(client, [product.id], { lock: true });
        await advanceFullProductRevision(client, product.id, lifecycle.revision);
        await auditName(client, options.mutationContext.actorUserId, product, 'amber_changed', { before: fresh.names, after: names });
      }
      // The existing input trigger queues the new generation and preserves any
      // reconciliation_required request. Never approve a conflict or baseline here.
      return { productId: product.id, names };
    } });
}
module.exports = { read, save, validateNames, validateEvaluatedNames };
