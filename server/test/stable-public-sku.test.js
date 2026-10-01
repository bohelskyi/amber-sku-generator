const assert = require('node:assert/strict');
const test = require('node:test');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { resolveProductLookup } = require('../src/services/product/public-identity');
const { inspect: inspectActivation } = require('../src/services/public-sku-activation.service');
const { buildRecountEvidence } = require('../src/services/product/recount-evidence');
const { buildExposureIndex } = require('../src/services/export-exposure/evidence');
const { presentProductTimeline } = require('../src/presenters/product-timeline');
const { catalog, product } = require('./fixtures/magento-v1/contract');

test('published legacy full_sku semantics stay internal while evaluator v3 uses public_sku', () => {
  const input = { ...product('BR'), public_sku: 'AG-000123' };
  const legacy = evaluateProduct(compileDefinition(materializeMagentoV1(catalog())), input);
  const current = evaluateProduct(compileDefinition(materializeMagentoV1(catalog(), { publicSku: true })), input);
  assert.equal(legacy.base.sku, input.full_sku);
  assert.equal(current.base.sku, 'AG-000123');
  assert.equal(current.english.sku, 'AG-000123');
  assert.match(current.english.name, /Art: AG-000123/);
  const definition = materializeMagentoV1(catalog(), { publicSku: true });
  assert.equal(definition.sources.full_sku.field, 'full_sku');
  assert.equal(definition.sources.public_sku.field, 'public_sku');
  assert.equal(definition.sourceContractVersion, 'public-product-identity-v1');
});

test('public lookup selects the unique current revision without merging historical rows', async () => {
  const rows = [
    { id: 1, full_sku: 'NM-OLD', public_sku: 'NM-OLD', status: 'corrected',
      corrected_to_product_id: 2, public_match: false, internal_match: true },
    { id: 2, full_sku: 'NM-NEW', public_sku: 'NM-OLD', status: 'active',
      corrected_to_product_id: null, public_match: true, internal_match: false },
  ];
  const queryable = { query: async () => ({ rows }) };
  const result = await resolveProductLookup(queryable, 'nm-old');
  assert.equal(result.lookupKind, 'public');
  assert.equal(result.product.id, 2);
  assert.equal(result.product.full_sku, 'NM-NEW');
  assert.equal(result.product.public_sku, 'NM-OLD');
  assert.equal(Object.hasOwn(result.product, 'public_match'), false);
});

test('historical internal-SKU lookup preserves duplicate ambiguity evidence', async () => {
  const queryable = { query: async () => ({ rows: [
    { id: 7, full_sku: 'AR-HISTORY', public_sku: 'AR-A', public_match: false, internal_match: true },
    { id: 8, full_sku: 'AR-HISTORY', public_sku: 'AR-B', public_match: false, internal_match: true },
  ] }) };
  const result = await resolveProductLookup(queryable, 'AR-HISTORY');
  assert.equal(result.lookupKind, 'internal');
  assert.equal(result.internalMatchCount, 2);
  assert.equal(result.product.id, 7);
});

test('timeline API adds public identity without redefining internal sku fields', () => {
  const result = presentProductTimeline('AG-000123', {
    products: [{
      id: 1, full_sku: 'BR1001', public_sku: 'AG-000123', category: 'BR', status: 'active',
      created_at: '2026-09-01T00:00:00.000Z', corrected_from_product_id: null,
      corrected_to_product_id: null, sku_schema_version_id: null,
    }],
    corrections: [], requests: [], repricingItems: [], audits: [], schemaRows: [],
  });
  assert.equal(result.lineage.products[0].sku, 'BR1001');
  assert.equal(result.lineage.products[0].internalSku, 'BR1001');
  assert.equal(result.lineage.products[0].publicSku, 'AG-000123');
  assert.equal(result.events[0].sku, 'BR1001');
  assert.equal(result.events[0].publicSku, 'AG-000123');
});

test('activation preflight blocks unfinished manual Magento sync jobs', async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ name: 'amber_test' }] };
    if (sql.includes('schema_migrations')) return { rows: [{ applied: true }] };
    if (sql.includes('FROM public_sku_activation')) return { rows: [{ enabled: false }] };
    if (sql.includes('FROM magento_auto_sync_activation')) {
      return { rows: [{ enabled: false, legacy_product_csv_enabled: true }] };
    }
    if (sql.includes('missing_identity')) return { rows: [{ products: 0, missing_identity: 0, invalid_public_sku: 0 }] };
    if (sql.includes('GROUP BY public_product_identity_id')) return { rows: [{ count: 0 }] };
    if (sql.includes('pending_normal')) return { rows: [{ pending_normal: 0, pending_replacement: 0 }] };
    if (sql.includes('generatedUnconfirmed') || sql.includes('status<>')) return { rows: [{ count: 0 }] };
    if (sql.includes('current_attempt_id')) return { rows: [{ count: 0 }] };
    if (sql.includes('magento_product_sync_requests')) return { rows: [{ requests: 0, jobs: 1 }] };
    throw new Error(`Unexpected activation preflight query: ${sql}`);
  } };
  const report = await inspectActivation(client, { expectedDatabase: 'amber_test' });
  assert.ok(report.blockers.some((blocker) => blocker.code === 'PUBLIC_SKU_AUTOMATIC_WORK_UNRESOLVED'));
  const jobQuery = statements.find((sql) => sql.includes('magento_sync_jobs'));
  assert.match(jobQuery, /state NOT IN \('succeeded','superseded'\)/);
  assert.doesNotMatch(jobQuery, /automatic_generation IS NOT NULL/);
});

test('recount evidence signature binds whether stable public SKU allocation is active', async () => {
  const evidenceFor = async (enabled) => buildRecountEvidence({
    query: async (sql) => {
      if (sql.includes('SELECT enabled FROM public_sku_activation')) return { rows: [{ enabled }] };
      if (sql.includes('SELECT') && sql.includes('product_export_revisions')) {
        return { rows: [{ products: [], corrections: [], snapshots: [], artifacts: [], revisions: [],
          events: [], state: [], lifecycle: [], members: [] }] };
      }
      if (sql.includes('FROM product_full_export_state')) {
        return { rows: [{ product_id: 7, revision: '1', confirmed_revision: '0', delivery_version: '1',
          route: 'normal', hold_reason: null, source_correction_id: null, evidence: { origin: 'ordinary_save' },
          business_exclusion_state: 'none', recount_compatibility_excluded: false }] };
      }
      if (sql.includes('FROM sku_schema_versions')) return { rows: [] };
      if (sql.includes('FROM questions')) return { rows: [] };
      throw new Error(`Unexpected recount evidence query: ${sql}`);
    },
  }, { id: 7, full_sku: 'ZZ-OLD', category: 'ZZ', status: 'active', exclude_from_export: 0 },
  { skuSchemaVersionId: null, categoryCode: 'ZZ', answers: {} }, {}, { lock: true });

  const before = await evidenceFor(false);
  const after = await evidenceFor(true);
  assert.equal(before.binding.version, 5);
  assert.equal(before.binding.publicSkuActivation, false);
  assert.equal(after.binding.publicSkuActivation, true);
  assert.notEqual(before.signature, after.signature);
});

test('exposure evidence resolves future public-SKU Magento artifacts and keeps internal snapshot meaning', () => {
  const input = {
    products: [{ id: 1, full_sku: 'BR-CONFIG-1', public_sku: 'AG-000001', category: 'BR' }],
    corrections: [], revisions: [], events: [], state: [{ exported_to_product_id: 0 }],
    snapshots: [{ id: 'snap-1', status: 'generated', exported_to_product_id: 1, row_count: 1,
      csv_content: 'sku\nBR-CONFIG-1\n', reexport_revisions: [], from_sku: null, to_sku: null }],
    artifacts: [{ snapshot_id: 'snap-1', group_code: 'BR', profile_version: 1, file_name: 'products.csv',
      product_count: 1, row_count: 2,
      csv_content: 'sku,store_view_code\nAG-000001,\nAG-000001,en\n' }],
  };
  const index = buildExposureIndex(input);
  assert.deepEqual(index.diagnostics.filter((item) => item.code === 'CSV_SKU_UNRESOLVED'), []);
  assert.equal(index.productEvidence.get(1).exact.some((item) => item.kind === 'artifact'
    && item.sku === 'AG-000001'), true);
  assert.equal(index.productEvidence.get(1).exact.some((item) => item.kind === 'internal'
    && item.sku === 'BR-CONFIG-1'), true);
});
