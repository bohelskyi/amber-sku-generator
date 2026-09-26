const crypto = require('node:crypto');
const { finalizeCsvValue } = require('../../utils/csv');
const { readStoredCsv } = require('./csv-reader');

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a, b) => Number(a.id) - Number(b.id);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const stableJson = (value) => JSON.stringify(canonical(value));
const uniqueSorted = (values) => [...new Map(values.map((value) => [stableJson(value), value])).entries()]
  .sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function classifyExposure({ exact = [], indicators = [], issues = [] }) {
  let classification;
  let primaryReason;
  if (issues.length) {
    classification = 'historical_ambiguous'; primaryReason = 'EVIDENCE_INTEGRITY_UNRESOLVED';
  } else if (exact.some((item) => item.status === 'confirmed')) {
    classification = 'confirmed_exact'; primaryReason = 'CONFIRMED_STORED_MEMBERSHIP';
  } else if (exact.some((item) => item.status === 'generated')) {
    classification = 'generated_exact'; primaryReason = 'GENERATED_STORED_MEMBERSHIP';
  } else if (indicators.length) {
    classification = 'historical_ambiguous'; primaryReason = 'INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP';
  } else {
    classification = 'reliably_unexposed'; primaryReason = 'NO_EXPOSURE_IN_RETAINED_EVIDENCE';
  }
  return { classification, evidenceScope: 'retained_database_evidence', primaryReason,
    exact: uniqueSorted(exact), indicators: uniqueSorted(indicators), issues: uniqueSorted(issues) };
}

function buildExposureIndex(input) {
  const products = [...input.products].sort(byId);
  const byProduct = new Map(products.map((p) => [Number(p.id), p]));
  const skuProducts = new Map();
  for (const product of products) {
    // Match the serializer's exact spelling, never strip an arbitrary apostrophe.
    for (const key of new Set([product.full_sku, finalizeCsvValue(product.full_sku)])) {
      if (!skuProducts.has(key)) skuProducts.set(key, []);
      skuProducts.get(key).push(product);
    }
  }
  const productEvidence = new Map(products.map((p) => [Number(p.id), { exact: [], indicators: [], issues: [] }]));
  const diagnostics = [];
  const snapshotEvidence = [];
  const cursor = input.state.length === 1 ? Number(input.state[0].exported_to_product_id) : null;
  const globalIssue = (code) => {
    diagnostics.push({ code });
    for (const evidence of productEvidence.values()) evidence.issues.push({ code });
  };
  if (!Number.isSafeInteger(cursor) || cursor < 0) globalIssue('EXPORT_STATE_INVALID');
  for (const product of products) {
    const evidence = productEvidence.get(Number(product.id));
    if (!product.full_sku || (skuProducts.get(product.full_sku) || []).length !== 1) {
      evidence.issues.push({ code: 'PRODUCT_SKU_AMBIGUOUS', productId: Number(product.id) });
    }
    if (cursor !== null && Number(product.id) <= cursor) {
      evidence.indicators.push({ code: 'AT_OR_BELOW_CURSOR', cursor });
    }
  }
  for (const revision of input.revisions) {
    if (revision.has_product_snapshot === true) productEvidence.get(Number(revision.product_id))?.indicators.push({
      code: 'HAS_PRODUCT_SNAPSHOT_FLAG', productId: Number(revision.product_id),
      revision: String(revision.revision), confirmedRevision: String(revision.confirmed_revision),
    });
  }
  function addRange(row, code, key) {
    const from = skuProducts.get(row.from_sku);
    const to = row.to_sku ? skuProducts.get(row.to_sku) : null;
    const upper = Number(row.exported_to_product_id);
    const start = from?.length === 1 ? Number(from[0].id) : null;
    const end = to?.length === 1 ? Number(to[0].id) : upper;
    const complete = start !== null && Number.isSafeInteger(end) && end >= 0;
    for (const product of products) {
      const id = Number(product.id);
      if ((complete && id >= Math.min(start, end) && id <= Math.max(start, end))
          || (!complete && (!Number.isSafeInteger(upper) || upper <= 0 || id <= upper))) {
        productEvidence.get(id).indicators.push({ code, [key]: row.id,
          startId: start, endId: Number.isSafeInteger(end) ? end : null,
          rangeResolved: complete });
      }
    }
  }
  for (const event of [...input.events].sort(byId)) addRange(event, 'LEGACY_EXPORT_EVENT_RANGE', 'eventId');
  const artifactsBySnapshot = new Map();
  for (const artifact of input.artifacts) {
    if (!artifactsBySnapshot.has(artifact.snapshot_id)) artifactsBySnapshot.set(artifact.snapshot_id, []);
    artifactsBySnapshot.get(artifact.snapshot_id).push(artifact);
  }
  for (const snapshot of [...input.snapshots].sort((a, b) => compare(a.id, b.id))) {
    addRange(snapshot, 'SNAPSHOT_RANGE_INFERENCE', 'snapshotId');
    const issues = [];
    const members = [];
    const files = [];
    if (!['generated', 'confirmed'].includes(snapshot.status)) issues.push({ code: 'SNAPSHOT_STATUS_INVALID' });
    function inspectFile(file, kind) {
      const identity = kind === 'internal' ? { kind } : {
        kind, groupCode: file.group_code, profileVersion: file.profile_version,
      };
      const fileEvidence = { ...identity, fileName: file.file_name ?? null,
        csvSha256: typeof file.csv_content === 'string' ? hash(file.csv_content) : null,
        expectedRowCount: file.row_count, members: [] };
      files.push(fileEvidence);
      let rows;
      try { rows = readStoredCsv(file.csv_content); } catch (error) {
        issues.push({ code: 'STORED_CSV_INVALID', ...identity, detail: error.message }); return [];
      }
      const headers = rows.shift() || [];
      const skuIndex = headers.indexOf('sku');
      if (skuIndex < 0 || headers.lastIndexOf('sku') !== skuIndex) {
        issues.push({ code: 'SKU_HEADER_INVALID', ...identity }); return [];
      }
      if (rows.length !== Number(file.row_count)) issues.push({ code: 'CSV_ROW_COUNT_MISMATCH', ...identity });
      const storeIndex = headers.indexOf('store_view_code');
      if (kind === 'artifact' && (storeIndex < 0 || headers.lastIndexOf('store_view_code') !== storeIndex)) {
        issues.push({ code: 'STORE_VIEW_HEADER_INVALID', ...identity });
      }
      const grouped = new Map();
      rows.forEach((row, index) => {
        if (row.length !== headers.length) issues.push({ code: 'CSV_COLUMN_COUNT_MISMATCH', ...identity, csvRecord: index + 2 });
        const sku = row[skuIndex];
        const matches = skuProducts.get(sku) || [];
        if (matches.length !== 1) {
          issues.push({ code: 'CSV_SKU_UNRESOLVED', ...identity, sku, csvRecord: index + 2 }); return;
        }
        const product = matches[0];
        const member = { productId: Number(product.id), sku: product.full_sku,
          snapshotId: snapshot.id, status: snapshot.status, ...identity, csvRecord: index + 2 };
        members.push(member); fileEvidence.members.push(member);
        if (!grouped.has(member.productId)) grouped.set(member.productId, []);
        grouped.get(member.productId).push(row[storeIndex]);
        if (kind === 'artifact' && product.category !== file.group_code) {
          issues.push({ code: 'ARTIFACT_CATEGORY_MISMATCH', ...identity, productId: member.productId });
        }
      });
      for (const [productId, stores] of grouped) {
        if ((kind === 'internal' && stores.length !== 1)
            || (kind === 'artifact' && (stores.length !== 2 || stores.filter((s) => s === '').length !== 1
              || stores.filter((s) => typeof s === 'string' && s !== '').length !== 1))) {
          issues.push({ code: 'CSV_PRODUCT_ROWS_INVALID', ...identity, productId });
        }
      }
      if (kind === 'artifact' && grouped.size !== Number(file.product_count)) {
        issues.push({ code: 'ARTIFACT_PRODUCT_COUNT_MISMATCH', ...identity });
      }
      return [...grouped.keys()].sort((a, b) => a - b);
    }
    const internalIds = inspectFile(snapshot, 'internal');
    const artifacts = (artifactsBySnapshot.get(snapshot.id) || []).sort((a, b) =>
      compare(`${a.group_code}:${a.profile_version}`, `${b.group_code}:${b.profile_version}`));
    const artifactIds = artifacts.flatMap((artifact) => inspectFile(artifact, 'artifact')).sort((a, b) => a - b);
    if (artifacts.length && stableJson(internalIds) !== stableJson(artifactIds)) {
      issues.push({ code: 'ARTIFACT_MEMBERSHIP_MISMATCH' });
    }
    const revisionReferences = [];
    if (!Array.isArray(snapshot.reexport_revisions)) issues.push({ code: 'REVISION_EVIDENCE_INVALID' });
    else for (const reference of snapshot.reexport_revisions) {
      const id = Number(reference?.productId);
      if (!positiveId(id) || !byProduct.has(id) || !/^\d+$/.test(String(reference?.revision))
          || BigInt(reference.revision) <= 0n) {
        issues.push({ code: 'REVISION_REFERENCE_INVALID' }); continue;
      }
      revisionReferences.push({ productId: id, revision: String(reference.revision) });
      if (!internalIds.includes(id)) issues.push({ code: 'REVISION_MEMBERSHIP_CONFLICT', productId: id });
    }
    const upper = Number(snapshot.exported_to_product_id);
    const trustedUpper = Number.isSafeInteger(upper) && upper >= 0
      && members.every((member) => member.productId <= upper)
      && revisionReferences.every((reference) => reference.productId <= upper);
    if (!trustedUpper) {
      issues.push({ code: 'SNAPSHOT_UPPER_BOUND_INVALID' });
    }
    for (const member of members) productEvidence.get(member.productId).exact.push(member);
    const scopedIssues = issues.map((issue) => ({ snapshotId: snapshot.id, ...issue }));
    diagnostics.push(...scopedIssues);
    // Broken evidence can hide rows. A valid immutable upper bound limits the
    // uncertainty, but is never used to assert exact membership or confirmation.
    for (const product of products) {
      if (!trustedUpper || upper === 0 || Number(product.id) <= upper
          || members.some((member) => member.productId === Number(product.id))
          || revisionReferences.some((ref) => ref.productId === Number(product.id))) {
        productEvidence.get(Number(product.id)).issues.push(...scopedIssues);
      }
    }
    snapshotEvidence.push({ snapshotId: snapshot.id, status: snapshot.status,
      generatedAt: snapshot.generated_at, confirmedAt: snapshot.confirmed_at,
      fromSku: snapshot.from_sku, toSku: snapshot.to_sku,
      exportedToProductId: snapshot.exported_to_product_id,
      files, revisionReferences: uniqueSorted(revisionReferences), issues: uniqueSorted(scopedIssues) });
  }
  const snapshotIds = new Set(input.snapshots.map((s) => s.id));
  if (input.artifacts.some((a) => !snapshotIds.has(a.snapshot_id))) globalIssue('ORPHAN_ARTIFACT');
  return { cursor, byProduct, productEvidence, snapshotEvidence, diagnostics: uniqueSorted(diagnostics) };
}

module.exports = { buildExposureIndex, classifyExposure, canonical, stableJson, hash,
  uniqueSorted, compare, byId };
