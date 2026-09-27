const { buildExposureIndex, hash, stableJson, uniqueSorted, compare } = require('./evidence');
const { readStoredCsv } = require('./csv-reader');
const { membershipEvidence } = require('../full-product-export.service');

const memberShape = (m) => Object.fromEntries(['snapshot_id', 'product_id', 'sku_at_capture',
  'full_revision', 'delivery_version', 'capture_kind', 'evidence_origin', 'evidence_hash'].map((k) => [k, m[k]]));
const fileProof = ({ csv_content, ...file }) => ({ ...file, csvSha256: hash(csv_content) });
function immutableSnapshot(snapshot) {
  const { status, confirmed_at, confirmed_by_user_id, ...immutable } = snapshot;
  void status; void confirmed_at; void confirmed_by_user_id;
  return fileProof(immutable);
}

function buildHistoricalIndex(input) {
  const index = buildExposureIndex(input);
  const diagnostics = [...index.diagnostics];
  const proposed = []; const existing = []; const snapshots = [];
  const byProduct = new Map(input.products.map((p) => [Number(p.id), p]));
  const registry = new Map(input.registry.map((r) => [r.full_sku, r]));
  for (const snapshot of [...input.snapshots].sort((a,b) => compare(a.id,b.id))) {
    const parsed = index.snapshotEvidence.find((s) => s.snapshotId === snapshot.id);
    const artifacts = input.artifacts.filter((a) => a.snapshot_id === snapshot.id)
      .sort((a,b) => compare(stableJson([a.group_code,a.profile_version]),stableJson([b.group_code,b.profile_version])));
    const issues = [...parsed.issues];
    const issue = (code, extra = {}) => issues.push({ code, snapshotId: snapshot.id, ...extra });
    if (!artifacts.length && (snapshot.request_contract === 'template-v1' || snapshot.legacy_preview_fingerprint)) {
      issue('MISSING_ARTIFACT');
    }
    if (snapshot.resolved_to_sku != null && !input.products.some((p) =>
      p.full_sku === snapshot.resolved_to_sku && Number(p.id) === Number(snapshot.exported_to_product_id))) {
      issue('SNAPSHOT_METADATA_MISMATCH');
    }
    if (snapshot.status === 'confirmed' && Object.hasOwn(snapshot, 'confirmed_at') && !snapshot.confirmed_at) {
      issue('SNAPSHOT_METADATA_MISMATCH');
    }
    for (const artifact of artifacts) {
      try {
        const [headers, ...rows] = readStoredCsv(artifact.csv_content);
        if (new Set(headers).size !== headers.length) issue('DUPLICATE_HEADER');
        const si = headers.indexOf('sku'); const vi = headers.indexOf('store_view_code');
        const grouped = new Map();
        for (const row of rows) {
          if (!grouped.has(row[si])) grouped.set(row[si], []);
          grouped.get(row[si]).push(row);
        }
        for (const [sku, pair] of grouped) {
          if (pair.length !== 2 || !pair.some((r) => r[vi] === '') || !pair.some((r) => r[vi] === 'en')) {
            issue('MAIN_EN_DISAGREEMENT', { sku }); continue;
          }
          for (const key of ['attribute_set_code', 'product_type']) {
            const at = headers.indexOf(key);
            if (at >= 0 && pair[0][at] !== pair[1][at]) issue('MAIN_EN_DISAGREEMENT', { sku, field: key });
          }
        }
      } catch { /* Phase-0 parser already records the corruption. */ }
    }
    const evidence = { version: 2, snapshot: immutableSnapshot(snapshot), artifacts: artifacts.map(fileProof) };
    const ids = [...new Set(parsed.files[0]?.members.map((m) => m.productId) || [])].sort((a,b) => a-b);
    const expected = ids.map((id) => {
      const p = byProduct.get(id);
      if (!registry.has(p.full_sku) || Number(registry.get(p.full_sku).first_product_id) !== id) {
        issue('PRODUCT_SKU_IDENTITY_CONFLICT', { productId: id, sku: p.full_sku });
      }
      return { snapshot_id: snapshot.id, product_id: id, sku_at_capture: p.full_sku,
        full_revision: null, delivery_version: null, capture_kind: 'legacy_compatibility',
        evidence_origin: 'verified_stored_csv', evidence_hash: hash(stableJson({ ...evidence, productId: id, sku: p.full_sku })) };
    });
    const stored = input.members.filter((m) => m.snapshot_id === snapshot.id);
    if (new Set(stored.map((m) => Number(m.product_id))).size !== stored.length) issue('DUPLICATE_CONTRADICTORY_MEMBERSHIP');
    for (const member of stored) {
      const p = byProduct.get(Number(member.product_id));
      if (!p || p.full_sku !== member.sku_at_capture || !ids.includes(Number(member.product_id))) {
        issue('MEMBERSHIP_IDENTITY_CONFLICT'); continue;
      }
      if (snapshot.full_product_lifecycle_version == null) {
        if (stableJson(memberShape(member)) !== stableJson(expected.find((m) => m.product_id === Number(member.product_id)))) {
          issue('ARTIFACT_HASH_OR_MEMBERSHIP_MISMATCH', { productId: Number(member.product_id) });
        }
      } else {
        const qualifying = artifacts.length > 0;
        const proof = membershipEvidence(snapshot, p, { revision: member.full_revision, deliveryVersion: member.delivery_version },
          artifacts.map((a) => ({ groupCode:a.group_code, profileVersion:a.profile_version, csvContent:a.csv_content })), qualifying);
        if (snapshot.full_product_lifecycle_version !== 1 || member.evidence_origin !== 'live_capture'
          || member.capture_kind !== proof.captureKind || member.evidence_hash !== hash(stableJson(proof))) {
          issue('ARTIFACT_HASH_OR_MEMBERSHIP_MISMATCH', { productId: Number(member.product_id) });
        }
      }
    }
    if (snapshot.full_product_lifecycle_version != null && stored.length !== ids.length) issue('LIVE_MEMBERSHIP_INCOMPLETE');
    diagnostics.push(...issues);
    existing.push(...stored);
    if (!issues.length && snapshot.full_product_lifecycle_version == null) {
      proposed.push(...expected.filter((m) => !stored.some((s) => Number(s.product_id) === m.product_id)));
    }
    snapshots.push({ snapshotId: snapshot.id, evidence, status: snapshot.status, memberIds: ids,
      beforeFingerprint: hash(stableJson({ snapshot: fileProof(snapshot), artifacts: artifacts.map(fileProof), members: stored })),
      issues: uniqueSorted(issues) });
  }
  for (const m of input.members) if (!input.snapshots.some((s) => s.id === m.snapshot_id)) diagnostics.push({ code:'ORPHAN_MEMBERSHIP' });
  return { version: 2, proposed, existing, snapshots, diagnostics: uniqueSorted(diagnostics) };
}

module.exports = { buildHistoricalIndex, memberShape };
