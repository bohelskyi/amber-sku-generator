const { hash, stableJson, buildExposureIndex } = require('./export-exposure/evidence');
const { readLineageExposure } = require('./full-product-export-exposure');

const LIFECYCLE_VERSION = 1;
function lifecycleError(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: 'FULL_PRODUCT_STATE_CONFLICT' });
}
const productIds = (ids) => [...new Set(ids.map(Number))].sort((a, b) => a - b);

async function readFullProductStates(client, ids, { lock = false } = {}) {
  const ordered = productIds(ids);
  if (!ordered.length) return [];
  const result = await client.query(`SELECT * FROM product_full_export_state
    WHERE product_id = ANY($1::int[]) ORDER BY product_id${lock ? ' FOR UPDATE' : ''}`, [ordered]);
  if (result.rows.length !== ordered.length) throw lifecycleError('Missing full-product lifecycle state');
  return result.rows;
}

async function initializeNewProduct(client, productId) {
  await client.query(`INSERT INTO product_full_export_state(product_id, route, evidence)
    VALUES ($1, 'normal', '{"origin":"ordinary_save"}'::jsonb)`, [productId]);
}

async function retireFullProduct(client, productId) {
  await readFullProductStates(client, [productId], { lock: true });
  await client.query(`UPDATE product_full_export_state SET route='retired', hold_reason=NULL,
    delivery_version=delivery_version+1, updated_at=CURRENT_TIMESTAMP
    WHERE product_id=$1 AND route <> 'retired'`, [productId]);
}

async function initializeRecountSuccessor(client, source, successorId, correctionId, reviewedDisposition) {
  const disposition = reviewedDisposition || await readLineageExposure(client, Number(source.id), source);
  // All pre-existing state locks are acquired in stable order after product/SKU/
  // request finalization. Neither this service nor confirmation locks products.
  await readFullProductStates(client, disposition.productIds, { lock: true });
  await retireFullProduct(client, source.id);
  await client.query(`INSERT INTO product_full_export_state
    (product_id, route, hold_reason, source_correction_id, evidence)
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [successorId, disposition.route,
    disposition.holdReason, correctionId, JSON.stringify(disposition.evidence)]);
  return disposition;
}

// Caller must already hold its product lock. CAS protects reviewed mutations.
async function advanceFullProductRevision(client, productId, expectedRevision) {
  await readFullProductStates(client, [productId], { lock: true });
  const result = await client.query(`UPDATE product_full_export_state
    SET revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE product_id=$1 AND revision=$2::bigint AND route <> 'retired' RETURNING *`,
  [productId, String(expectedRevision)]);
  if (!result.rows.length) throw lifecycleError('Full-product revision changed');
  return result.rows[0];
}

async function advanceFullProductDeliveryVersion(client, productId, expectedVersion) {
  const result = await client.query(`UPDATE product_full_export_state
    SET delivery_version=delivery_version+1, updated_at=CURRENT_TIMESTAMP
    WHERE product_id=$1 AND delivery_version=$2::bigint AND route <> 'retired' RETURNING *`,
  [productId, String(expectedVersion)]);
  if (!result.rows.length) throw lifecycleError('Full-product delivery state changed');
  return result.rows[0];
}

async function captureFullProductStates(client, rows, { lock = false } = {}) {
  if (new Set(rows.map((p) => Number(p.id))).size !== rows.length) throw lifecycleError('Duplicate represented product');
  const states = await readFullProductStates(client, rows.map((p) => p.id), { lock });
  // Holds are recorded, not activated as selection gates in Phase 1. The current
  // cursor/exclusion path remains authoritative until the coordinated Phase 4 switch.
  if (states.some((s) => s.route === 'retired')) throw lifecycleError('Retired product cannot be captured');
  return { version: LIFECYCLE_VERSION, products: states.map((s) => ({
    productId: Number(s.product_id), revision: s.revision, deliveryVersion: s.delivery_version,
    route: s.route, holdReason: s.hold_reason,
  })) };
}

function snapshotFileHashes(snapshot, artifacts) {
  return { csvHash: hash(snapshot.csv_content), artifacts: artifacts.map((a) => ({
    group: a.groupCode, profile: a.profileVersion, hash: hash(a.csvContent),
  })).sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : 0) };
}

function membershipEvidence(snapshot, product, state, artifacts, qualifying, files = snapshotFileHashes(snapshot, artifacts)) {
  return { version: LIFECYCLE_VERSION, snapshotId: snapshot.id, productId: Number(product.id),
    sku: product.full_sku, fullRevision: qualifying ? state.revision : null,
    deliveryVersion: qualifying ? state.deliveryVersion : null,
    captureKind: qualifying ? 'full_product' : 'legacy_compatibility',
    csvHash: files.csvHash, artifacts: files.artifacts.filter((a) => a.group === product.category) };
}

async function captureSnapshotMembership(client, snapshot, rows, captured, artifacts) {
  if (snapshot.full_product_lifecycle_version !== LIFECYCLE_VERSION
    || captured.version !== LIFECYCLE_VERSION || rows.length !== Number(snapshot.row_count)
    || rows.length !== captured.products.length) throw lifecycleError('Invalid lifecycle capture version or count');
  // Reuse the trusted CSV evidence parser to check exact SKU sets and Main/EN
  // representation against the actual immutable bytes, not artifact row counts.
  const evidence = buildExposureIndex({ products: rows, snapshots: [snapshot],
    artifacts: artifacts.map((a) => ({ snapshot_id: snapshot.id, group_code: a.groupCode,
      profile_version: a.profileVersion, file_name: a.fileName, csv_content: a.csvContent,
      product_count: a.productCount, row_count: a.rowCount })), revisions: [], events: [],
    state: [{ exported_to_product_id: 0 }] });
  if (evidence.diagnostics.length || evidence.snapshotEvidence[0].files[0].members.length !== rows.length) {
    throw lifecycleError('Snapshot bytes do not match represented products');
  }
  const qualifying = artifacts.length > 0;
  const files = snapshotFileHashes(snapshot, artifacts);
  const byProduct = new Map(captured.products.map((s) => [s.productId, s]));
  for (const row of rows) {
    const state = byProduct.get(Number(row.id));
    if (!state) throw lifecycleError('Missing captured lifecycle state');
    const member = membershipEvidence(snapshot, row, state, artifacts, qualifying, files);
    await client.query(`INSERT INTO export_snapshot_products
      (snapshot_id, product_id, sku_at_capture, full_revision, delivery_version,
       capture_kind, evidence_origin, evidence_hash)
      VALUES ($1,$2,$3,$4,$5,$6,'live_capture',$7)`, [snapshot.id, row.id, row.full_sku,
      member.fullRevision, member.deliveryVersion, member.captureKind, hash(stableJson(member))]);
  }
}

async function confirmFullProductRevisions(client, snapshot) {
  if (snapshot.full_product_lifecycle_version == null) return; // Historical behavior is unchanged.
  if (snapshot.full_product_lifecycle_version !== LIFECYCLE_VERSION) throw lifecycleError('Unknown lifecycle version');
  const members = (await client.query(`SELECT * FROM export_snapshot_products
    WHERE snapshot_id=$1 ORDER BY product_id`, [snapshot.id])).rows;
  if (members.length !== Number(snapshot.row_count)) throw lifecycleError('Incomplete snapshot membership');
  const qualifying = members.filter((m) => m.capture_kind === 'full_product');
  const states = await readFullProductStates(client, qualifying.map((m) => m.product_id), { lock: true });
  for (let i = 0; i < qualifying.length; i += 1) {
    const member = qualifying[i]; const state = states[i];
    // A later delivery version (e.g. retirement) is valid. Never release its
    // route, acknowledge an uncaptured revision, or follow a successor pointer.
    if (BigInt(member.full_revision) > BigInt(state.revision)
      || BigInt(member.delivery_version) > BigInt(state.delivery_version)) throw lifecycleError('Invalid captured lifecycle counters');
    await client.query(`UPDATE product_full_export_state
      SET confirmed_revision=GREATEST(confirmed_revision,$2::bigint), updated_at=CURRENT_TIMESTAMP
      WHERE product_id=$1 AND confirmed_revision < $2::bigint`, [member.product_id, member.full_revision]);
  }
}

module.exports = { LIFECYCLE_VERSION, initializeNewProduct, initializeRecountSuccessor,
  retireFullProduct, readFullProductStates, advanceFullProductRevision, captureFullProductStates,
  captureSnapshotMembership, confirmFullProductRevisions, membershipEvidence, advanceFullProductDeliveryVersion };
