const gate = require('./full-product-cutover-gate');
const base = "p.status='active' AND p.corrected_to_product_id IS NULL AND COALESCE(p.exclude_from_export,0)=0 AND f.business_exclusion_state='none' AND NOT f.recount_compatibility_excluded";
const floor = 'GREATEST(f.confirmed_revision,f.cutover_baseline_revision,f.csv_retired_revision)';
const pending = `f.revision>${floor}`;
const first = `${base} AND f.route='normal' AND ${floor}=0 AND ${pending}`;
const update = `${base} AND f.route='normal' AND ${floor}>0 AND ${pending}`;
async function predicate(client, mode, input = {}) {
  const current = await gate.readGate(client);
  if (current.phase === 'preparing') throw gate.error('EXPORT_CUTOVER_PREPARING', 'Export cutover is preparing', 503);
  if (current.phase !== 'active') {
    if (mode === 'replacement') throw gate.error('LIFECYCLE_ACTIVATION_REQUIRED', 'Replacement selection is not active');
    return null;
  }
  if (mode === 'new') return first;
  if (mode === 'replacement') {
    if (!Number.isSafeInteger(input.productId) || input.productId <= 0 || !/^[1-9]\d*$/.test(String(input.deliveryVersion))) {
      throw gate.error('REPLACEMENT_SELECTION_REQUIRED', 'Select one product with its reviewed delivery version', 422);
    }
    return `${base} AND f.route='replacement' AND ${pending}`;
  }
  // Explicit same-SKU re-export is allowed; held and replacement routes never
  // become reachable by choosing wider range endpoints.
  return `${base} AND f.route='normal'`;
}
async function replacementAnchors(client, input) {
  await predicate(client, 'replacement', input);
  const row = (await client.query(`SELECT i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    JOIN product_full_export_state f ON f.product_id=p.id
    WHERE p.id=$1 AND f.delivery_version=$2::bigint AND f.route='replacement' AND ${base} AND ${pending}`,
  [input.productId,String(input.deliveryVersion)])).rows[0];
  if (!row) throw gate.error('REPLACEMENT_SELECTION_STALE', 'Replacement authorization changed');
  return { fromSku: row.public_sku, toSku: row.public_sku };
}
async function queues(client) {
  const current = await gate.readGate(client);
  const counts = (await client.query(`SELECT
    count(*) FILTER(WHERE ${first})::int AS "firstDelivery",
    count(*) FILTER(WHERE ${update})::int AS "fullUpdate",
    count(*) FILTER(WHERE ${base} AND f.route='replacement' AND ${pending})::int AS "replacementReady",
    count(*) FILTER(WHERE p.status='active' AND (f.route='hold' OR f.business_exclusion_state<>'none' OR f.recount_compatibility_excluded))::int AS held
    FROM products p JOIN product_full_export_state f ON f.product_id=p.id`)).rows[0];
  return { phase: current.phase, generation: current.generation, counts };
}
async function list(client, { queue, after = 0, limit = 50 }) {
  if (!['new','update','replacement','hold'].includes(queue) || !Number.isSafeInteger(Number(after)) || Number(after)<0
    || !Number.isSafeInteger(Number(limit)) || Number(limit)<1 || Number(limit)>100) throw gate.error('EXPORT_QUEUE_INVALID', 'Invalid queue/page', 422);
  await gate.requireActive(client);
  const where = { new:first, update, replacement:`${base} AND f.route='replacement' AND ${pending}`,
    hold:"p.status='active' AND (f.route='hold' OR f.business_exclusion_state<>'none' OR f.recount_compatibility_excluded)" }[queue];
  const rows = (await client.query(`SELECT p.id,p.full_sku,i.public_sku,p.category,p.magento_name_review_required,
    f.revision,f.confirmed_revision,f.cutover_baseline_revision,f.delivery_version,f.route,f.hold_reason,
    f.business_exclusion_state FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    JOIN product_full_export_state f ON f.product_id=p.id
    WHERE ${where} AND p.id>$1 ORDER BY p.id LIMIT $2`, [Number(after),Number(limit)+1])).rows;
  return { items:rows.slice(0,Number(limit)), next:rows.length>Number(limit) ? rows[Number(limit)-1].id : null };
}
module.exports = { predicate, replacementAnchors, queues, list };
