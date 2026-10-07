const pool = require('../../db/pool');
const configuration = require('../../config/env');
const c = require('./binding-contract');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { readPreviewProduct } = require('./sync-preview-db');
const { readNames, unresolvedDispatch } = require('./name-discovery');
const { decisionFor, readNameState, nameStateEvidence, saveObservation, importRemote, auditName } = require('./name-state');
const { same } = require('./name-reconciliation');

async function preview(payload, options = {}) {
  const db = options.databasePool || pool; const config = options.config || configuration.magento;
  if (!Number.isSafeInteger(payload.productId) || !['amber', 'magento'].includes(payload.choice)) {
    throw c.error(422, 'MAGENTO_NAME_SELECTION_INVALID', 'Оберіть товар і актуальну назву.');
  }
  if (!config.configured) throw c.error(422, 'MAGENTO_NAME_UNAVAILABLE', 'Magento не налаштовано.');
  const gate = (await db.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  const binding = (await db.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
    AND origin_hash=$2 AND state='published' ORDER BY version_number DESC LIMIT 1`, [gate?.installation_key, c.originHash(config.baseUrl)])).rows[0];
  if (!binding) throw c.error(409, 'MAGENTO_NAME_BINDING_REQUIRED', 'Немає опублікованих відповідностей Magento.');
  const amber = await readPreviewProduct(db, { productId: payload.productId, bindingRevisionId: binding.id });
  if (amber.product.status !== 'active' || amber.product.corrected_to_product_id) {
    throw c.error(409, 'MAGENTO_NAME_PRODUCT_RETIRED', 'Відкрийте актуальний товар.');
  }
  if (await unresolvedDispatch(db, c.originHash(config.baseUrl), amber.product.public_sku)) {
    throw c.error(409, 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED', 'Попередню надіслану зміну ще не підтверджено. Потрібна перевірка адміністратором.');
  }
  const completion = payload.intent === 'complete';
  if (payload.intent !== undefined && !completion) throw c.error(422, 'MAGENTO_NAME_SELECTION_INVALID', 'Некоректний спосіб заповнення назв.');
  if (completion) {
    const policy = require('../export-templates/effective-product-names');
    const mapped = require('./binding-evidence-products').evaluate(amber, amber.product);
    if (payload.choice !== 'magento' || amber.compiled.definition.nameReadiness !== policy.POLICY
      || policy.validPair({ all: mapped.base.name, en: mapped.english.name })) {
      throw c.error(409, 'MAGENTO_NAME_COMPLETION_UNAVAILABLE', 'Окреме заповнення потрібне лише для відсутньої повної пари назв.');
    }
  }
  const observation = await readNames(config, amber, { ...options, ...(completion ? { completion: true, fetchImpl: require('./integration-readiness').boundedGet(options.fetchImpl, { maxRequests: 3 }) } : {}) });
  require('./native-identity-ownership').assertOwned(amber, observation.raw);
  const result = decisionFor(observation, { allowIncompleteAmber: completion });
  if (['unavailable', 'identity_changed'].includes(result.action)) throw c.error(409, 'MAGENTO_NAME_READ_UNAVAILABLE', 'Не вдалося безпечно перевірити назви.');
  const token = c.hash({ product: amber.product, binding: binding.id, state: nameStateEvidence(amber.nameState),
    names: [result.amber, result.remote], remoteId: observation.raw.id, choice: payload.choice,
    ...(completion ? { intent: 'complete', storeEvidence: observation.domainEvidence } : {}) });
  return { productId: payload.productId, article: amber.product.public_sku, choice: payload.choice,
    amber: result.amber, magento: result.remote, previewToken: token, ...(completion ? { intent: 'complete', source: 'verified_magento_ua_en' } : {}),
    ...(options.internal ? { observation, result, bindingId: binding.id } : {}) };
}
async function apply(payload, options = {}) {
  const db = options.databasePool || pool; const config = options.config || configuration.magento;
  const initial = await preview(payload, { ...options, internal: true });
  const product = initial.observation.amber.product;
  const lockClient = await db.connect(); const locks = [`amber_magento_public_identity:${product.public_product_identity_id}`,
    `amber_magento_sync:${c.originHash(config.baseUrl)}:${product.public_sku}`];
  let held = 0;
  try {
    for (const lock of locks) {
      if (!(await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held) {
        throw c.error(409, 'MAGENTO_SYNC_BUSY', 'Стан товару змінюється. Повторіть перегляд.');
      }
      held++;
    }
    const fresh = await preview(payload, { ...options, internal: true });
    if (typeof payload.previewToken !== 'string' || payload.previewToken !== fresh.previewToken) {
      throw c.error(409, 'MAGENTO_NAME_PREVIEW_STALE', 'Назви змінилися після перегляду. Перегляньте їх ще раз.');
    }
    return await runAccessAdminMutation({ databasePool: db, actorUserId: options.mutationContext?.actorUserId,
      requiredPermission: 'exports.create', createError: c.error, operation: async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${fresh.observation.amber.revision.installationKey}`]);
        if (payload.intent === 'complete') {
          const context = await require('../product/effective-name-readiness').current(client, { config, lock: true });
          if (!context || context.binding.id !== fresh.bindingId) throw c.error(409, 'MAGENTO_NAME_PREVIEW_STALE', 'Опубліковані правила назв змінилися. Повторіть перегляд.');
        }
        const current = (await client.query('SELECT * FROM products WHERE id=$1 FOR NO KEY UPDATE', [product.id])).rows[0];
        const expected = fresh.observation.amber.product;
        const state = await readNameState(client, c.originHash(config.baseUrl), product.public_product_identity_id);
        const binding = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
          AND state='published' ORDER BY version_number DESC LIMIT 1`, [fresh.observation.amber.revision.installationKey])).rows[0];
        if (!current || c.hash(current) !== c.hash(Object.fromEntries(Object.keys(current).map((key) => [key, expected[key]])))
          || !same(nameStateEvidence(state), nameStateEvidence(fresh.observation.amber.nameState)) || binding?.id !== fresh.bindingId) {
          throw c.error(409, 'MAGENTO_NAME_PREVIEW_STALE', 'Товар або назви змінилися. Повторіть перегляд.');
        }
        const result = fresh.result;
        let resolution = null; let baseline = state?.baseline_names ?? null;
        if (payload.choice === 'magento') {
          await importRemote(client, options.mutationContext.actorUserId, current, result);
          baseline = result.remote; result.action = 'accept_external';
        } else {
          resolution = { amber: result.amber, remote: result.remote };
          result.action = same(result.amber, result.remote) ? 'confirm' : 'send_amber';
          if (result.action === 'confirm') baseline = result.amber;
          await client.query('UPDATE products SET magento_name_review_required=FALSE WHERE id=$1', [current.id]);
        }
        await saveObservation(client, c.originHash(config.baseUrl), current, fresh.observation.raw.id, result, baseline, resolution);
        await auditName(client, options.mutationContext.actorUserId, current, 'conflict_resolved', { choice: payload.choice,
          amber: result.amber, magento: result.remote });
        // Only an explicit reviewed local change resumes ordinary evaluation.
        // Uncertain dispatch can never reach this path or be reset by it.
        await client.query(`UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1,
          state='pending',reason_code=NULL,diagnostics='[]'::jsonb,next_attempt_at=CURRENT_TIMESTAMP
          WHERE public_product_identity_id=$1 AND reason_code IS DISTINCT FROM 'reconciliation_required'`, [current.public_product_identity_id]);
        return { productId: current.id, choice: payload.choice, state: 'pending' };
      } });
  } finally {
    while (held > 0) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [locks[--held]]).catch(() => {});
    lockClient.release();
  }
}
module.exports = { preview, apply };
