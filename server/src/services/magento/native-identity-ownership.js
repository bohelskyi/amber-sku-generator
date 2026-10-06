const { error } = require('./binding-contract');
const CODE = 'MAGENTO_NATIVE_IDENTITY_COLLISION';
const proofs = new WeakMap();
const native = (product) => product?.characteristic_version_id != null && Number(product.id) > 0;
// Request-owned database evidence. Name observations/resolutions cannot confer ownership.
async function load(client, amber, origin) {
  if (!native(amber.product)) return;
  const product = amber.product;
  const row = (await client.query(`SELECT i.origin,
    (SELECT j.remote_product_id FROM magento_sync_jobs j
      WHERE j.public_product_identity_id=i.id AND j.origin_hash=$2 AND j.sku=i.public_sku
        AND j.state='succeeded' AND j.acknowledged_at IS NOT NULL AND j.remote_product_id IS NOT NULL
      ORDER BY j.acknowledged_at DESC,j.created_at DESC,j.id DESC LIMIT 1) AS remote_id
    FROM public_product_identities i WHERE i.id=$1 AND i.public_sku=$3`,
  [product.public_product_identity_id, origin || null, product.public_sku])).rows[0];
  proofs.set(amber, { origin: row?.origin, remoteId: row?.remote_id, identity: String(product.public_product_identity_id),
    sku: product.public_sku, originHash: origin });
}
function issue(amber, raw) {
  if (!raw || !native(amber?.product)) return null;
  const proof = proofs.get(amber), product = amber.product;
  if (proof?.origin === 'legacy') return null;
  if (proof?.origin !== 'allocated' || proof.identity !== String(product.public_product_identity_id)
    || proof.sku !== product.public_sku || proof.originHash !== amber.revision?.originHash
    || raw.sku !== proof.sku || !Number.isSafeInteger(Number(proof.remoteId)) || Number(proof.remoteId) <= 0
    || Number(proof.remoteId) !== Number(raw.id)) return CODE;
  return null;
}
function assertOwned(amber, raw) {
  if (issue(amber, raw)) throw error(409, CODE,
    'Цей артикул уже належить іншому або непідтвердженому товару Magento. Зміна назви не усуває колізію. Доставку заблоковано.');
}
module.exports = { CODE, load, issue, assertOwned };
