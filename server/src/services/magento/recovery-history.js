const c = require('./binding-contract');
const editor = require('./integration-editor.service');
const { buildLineageGraph } = require('../export-exposure/manifest');
const { assertActorStillAuthorized } = require('../access-admin-transaction');
const { createMutationContext } = require('../../audit/mutation-context');
const { boundedGet } = require('./integration-readiness');
const { observe } = require('./exposure-reconciliation');

const LIMIT = 30;
function describe(rows, corrections, productId, complete = true) {
  const graph = buildLineageGraph(rows, corrections);
  const current = rows.find(p => p.id === productId);
  const component = graph.components.get(productId);
  const issues = [...(component?.issues || [])];
  if (component?.productIds.length !== rows.length) issues.push({ code: 'DISCONNECTED_IDENTITY_HISTORY', productId });
  for (const p of rows) {
    if (p.corrected_from_product_id == null) continue;
    const links = corrections.filter(v => v.corrected_product_id === p.id);
    if (links.length === 1 && p.source_correction_id !== links[0].id) issues.push({
      code: p.source_correction_id == null ? 'SOURCE_CORRECTION_NOT_RECORDED' : 'SOURCE_CORRECTION_MISMATCH',
      productId: p.id, correctionId: links[0].id, recordedCorrectionId: p.source_correction_id,
    });
  }
  const hasRecount = rows.length > 1 || corrections.length > 0 || rows.some(p => p.corrected_from_product_id != null || p.corrected_to_product_id != null);
  const identityChanged = rows.some(p => String(p.public_product_identity_id) !== String(current.public_product_identity_id) || p.public_sku !== current.public_sku);
  const stableRecount = complete && hasRecount && !identityChanged && !issues.length
    && current.status === 'active' && current.exclude_from_export === 0 && current.corrected_to_product_id == null && current.corrected_from_product_id != null
    && c.hash(graph.terminals(productId)) === c.hash([productId])
    && rows.every(p => p.business_exclusion_state === 'none' && p.recount_compatibility_excluded === false
      && !p.independent_exclusion && !['unknown', 'independent_exclusion'].includes(p.exclusion_provenance)
      && (p.id === productId || p.status === 'corrected' && p.route === 'retired'));
  const historicalRecount = complete && hasRecount && !stableRecount
    && current.status === 'active' && current.exclude_from_export === 0 && current.corrected_to_product_id == null && current.corrected_from_product_id != null
    && current.business_exclusion_state === 'none'
    && !require('./historical-recount-exposure').lineageBlockers(rows.map(p => ({ product: p,
      lifecycle: { route: p.route, business_exclusion_state: p.business_exclusion_state, recount_compatibility_excluded: p.recount_compatibility_excluded,
        source_correction_id: p.source_correction_id, evidence: { origin: p.lifecycle_origin, coverage: p.lifecycle_coverage,
          exclusionProvenance: p.exclusion_provenance, independentExclusion: p.independent_exclusion } },
      reservation: { first_product_id: p.id } })),corrections,productId).length;
  return { productId, complete, hasRecount, identityChanged, stableRecount, historicalRecount,
    products: rows.map(p => ({ productId: p.id, article: p.public_sku, internalSku: p.full_sku, status: p.status,
      previousProductId: p.corrected_from_product_id, nextProductId: p.corrected_to_product_id,
      route: p.route, holdReason: p.hold_reason, businessExclusion: p.business_exclusion_state,
      compatibilityExcluded: p.recount_compatibility_excluded, exclusionProvenance: p.exclusion_provenance,
      independentExclusion: p.independent_exclusion === true, legacyExportExcluded: p.exclude_from_export === 1,
      sourceCorrectionId: p.source_correction_id })),
    corrections: corrections.map(v => ({ correctionId: v.id, sourceProductId: v.source_product_id,
      successorProductId: v.corrected_product_id, sourceInternalSku: v.source_sku, successorInternalSku: v.corrected_sku })),
    issues };
}

// Bound the returned component, including incoming links and disconnected users
// of the same identity. Never diagnose from stored ancestor hints alone.
async function read(client, productId) {
  const rows = (await client.query(`WITH RECURSIVE edges(a,b) AS (
    SELECT id,corrected_from_product_id FROM products WHERE corrected_from_product_id IS NOT NULL
    UNION SELECT id,corrected_to_product_id FROM products WHERE corrected_to_product_id IS NOT NULL
    UNION SELECT source_product_id,corrected_product_id FROM product_corrections
  ), component(id) AS (
    SELECT id FROM products WHERE public_product_identity_id=(SELECT public_product_identity_id FROM products WHERE id=$1)
    UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM component c JOIN edges e ON e.a=c.id OR e.b=c.id
  ) SELECT p.id,p.full_sku,p.status,p.exclude_from_export,p.corrected_from_product_id,p.corrected_to_product_id,p.public_product_identity_id,i.public_sku,
    f.route,f.hold_reason,f.business_exclusion_state,f.recount_compatibility_excluded,f.source_correction_id,
    f.evidence->>'exclusionProvenance' exclusion_provenance,(f.evidence->'independentExclusion'='true'::jsonb) independent_exclusion,
    f.evidence->>'origin' lifecycle_origin,f.evidence->>'coverage' lifecycle_coverage
    FROM component c JOIN products p ON p.id=c.id JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id
    ORDER BY (p.id=$1) DESC,p.id LIMIT $2`, [productId, LIMIT + 1])).rows;
  if (!rows.length) throw c.error(404, 'PRODUCT_NOT_FOUND', 'Товар не знайдено.');
  const complete = rows.length <= LIMIT;
  const bounded = rows.slice(0, LIMIT);
  const corrections = (await client.query(`SELECT id,source_product_id,corrected_product_id,source_sku,corrected_sku
    FROM product_corrections WHERE source_product_id=ANY($1::int[]) OR corrected_product_id=ANY($1::int[])
    ORDER BY id LIMIT $2`, [bounded.map(p => p.id), LIMIT + 1])).rows;
  return describe(bounded, corrections.slice(0, LIMIT), productId, complete && corrections.length <= LIMIT);
}

async function inspect(config, productId, options = {}) {
  const local = () => editor.read(options, async client => {
    await assertActorStillAuthorized(client, createMutationContext(options.mutationContext).actorUserId,
      'exports.reconcile', c.error, { readOnly: true });
    return read(client, productId);
  });
  const history = await local();
  if (!history.complete) throw c.error(409, 'MAGENTO_HISTORY_TOO_LARGE', 'Історія містить забагато версій для перевірки на цьому екрані. Збережіть звіт для окремого розбору.');
  if (!config.configured) throw c.error(422, 'MAGENTO_NOT_CONFIGURED', 'Спочатку налаштуйте підключення до Magento.');
  const articles = [...new Set(history.products.map(p => p.article))];
  const remote = [];
  const fetchImpl = boundedGet(options.fetchImpl, { maxRequests: LIMIT, timeoutMs: 60000 });
  // Explicit, bounded GETs, outside all product/access/publication transactions.
  // The result is diagnostic evidence, never a lifecycle apply token.
  for (const article of articles) remote.push({ article, ...await observe(config, article, { ...options, fetchImpl }) });
  const fresh = await local();
  return { history, remote, observedAt: new Date().toISOString(), stale: c.hash(history) !== c.hash(fresh), remoteWrites: 0 };
}
module.exports = { LIMIT, describe, read, inspect };
