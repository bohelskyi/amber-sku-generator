const pool = require('../../db/pool');
const c = require('./binding-contract');
const editor = require('./integration-editor.service');
const service = require('./binding.service');
const repository = require('./binding-repository');
const { requirements } = require('./binding-validation');
const { buildCandidates } = require('./binding-bootstrap');
const { carryReviewedBindings, collectLiveVerification } = require('./binding-carry-forward');
const { compileDefinition } = require('../export-templates/definition');
const { CONTRACT, upgradeColumns } = require('../export-templates/column-contract');
const { getAppConfig } = require('../catalog/catalog-read-model');
const { loadDraftPreviewProducts } = require('../export-templates/draft-inputs');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { boundedGet } = require('./integration-readiness');
const { createMutationContext } = require('../../audit/mutation-context');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

// Legacy fixed-column templates eagerly evaluate every cell. Those checks are
// readiness gates, not dependencies of every mapping in the group. Resolve their
// output ownership without rewriting the immutable definition. Unclassifiable
// checks remain global, as in the explicit editable-column conversion.
function relevantChecks(definition, group, target) {
  const bindings = new Map(definition.bindings.map(b => [b.id, b.value]));
  function fields(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return [];
    if (node.op === 'ref') return seen.has(node.id) ? [] : fields(bindings.get(node.id), new Set([...seen, node.id]));
    return [...(node.op === 'error' ? [node.field] : []), ...Object.values(node).flatMap(v => fields(v, seen))];
  }
  return [...(group.evaluate || []).filter(rule => {
    const errors = fields(rule);
    if (errors.some(field => !group.columns?.includes(field))) return true;
    const owners = new Set([...errors, ...group.rows.flatMap(row => Object.entries(row.cells)
      .filter(([, cell]) => c.hash(cell) === c.hash(rule)).map(([field]) => field))]);
    return !owners.size || owners.has(target);
  }), ...(group.outputChecks || []).filter(check => check.columns.includes(target)).map(check => check.rule)];
}

// Compare a decision's expression, scope and transitive source contract. Never
// use the whole definition hash (option domain hashes still belong to the new
// immutable template). Remote identities are checked separately by reviewed carry.
function ruleProof(definition, groupCode, rowId, target) {
  const group = definition.groups.find((g) => g.route === groupCode);
  const row = group?.rows.find((r) => r.id === rowId);
  if (!row || !Object.hasOwn(row.cells, target)) return null;
  const proof = { expression: row.cells[target], evaluate: relevantChecks(definition, group, target),
    scope: { group: groupCode, row: rowId, store: row.cells.store_view_code || null,
      productType: group.rows.find(r => r.id === 'base')?.cells.product_type || null },
    evaluatorVersion: definition.evaluatorVersion || null, formatVersion: definition.formatVersion || null,
    outputContract: definition.outputContract || null,
    sources: {}, tables: {}, bindings: {}, contracts: {}, support: {},
    sourceContractVersion: definition.sourceContractVersion || null };
  if (target === 'name' && definition.nameReadiness) proof.nameReadiness = definition.nameReadiness;
  const visited = new Set();
  function visitRule(rule) {
    for (const [key, value] of Object.entries(rule || {})) {
      if (key === '$and' || key === '$or') value.forEach(visitRule);
      else visitSource(key);
    }
  }
  function visitContract(key) {
    if (Object.hasOwn(proof.contracts, key)) return;
    const contract = definition.questionContracts[key]; proof.contracts[key] = contract || null;
    if (contract) { visitSource(contract.source); visitRule(contract.rule); }
  }
  function visitSource(id) {
    if (Object.hasOwn(proof.sources, id)) return;
    const source = definition.sources[id]; proof.sources[id] = source || null;
    if (source?.category) {
      const location = `${source.category}.${source.key}`;
      const support = definition.sourceSupport?.sources[location];
      if (support) proof.support[location] = { version: definition.sourceSupport.version, ...support };
      for (const [key, contract] of Object.entries(definition.questionContracts)) {
        if (contract.source === id) visitContract(key);
      }
    }
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.op === 'ref' && !visited.has(value.id)) {
      visited.add(value.id);
      const binding = definition.bindings.find((b) => b.id === value.id);
      proof.bindings[value.id] = binding || null; visit(binding?.value);
    }
    if (value.op === 'source') visitSource(value.id);
    if (value.op === 'questionValue' || value.op === 'catalogRule') visitContract(value.question);
    if (typeof value.table === 'string') proof.tables[value.table] = definition.tables[value.table] || null;
    for (const child of Object.values(value)) if (typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(proof.expression); visit(proof.scope); proof.evaluate.forEach(visit);
  return c.hash(proof);
}

function storeProof(schema, rowId) {
  if (!schema) return null;
  const code = rowId === 'base' ? schema.storeCode : 'en';
  const topology = schema.storeTopology;
  if (code === 'all') return { code, topology };
  const view = topology.storeViews.find(s => s.code === code);
  return { code, view: view || null, group: topology.storeGroups.find(g => g.id === view?.store_group_id) || null,
    website: topology.websites.find(w => w.id === view?.website_id) || null };
}

// Only the official fixed-to-editable conversion may change contract identity
// without losing review. Prove every existing position, not just the decisions
// present in the published binding. Additions cannot reorder or rewrite history.
function equivalentColumnUpgrade(oldDefinition, nextDefinition) {
  if (oldDefinition.outputContract !== 'magento-products-v1' || nextDefinition.outputContract !== CONTRACT) return null;
  try {
    const before = upgradeColumns(oldDefinition);
    const after = compileDefinition(nextDefinition).definition;
    const equal = (a, b) => c.hash(a ?? null) === c.hash(b ?? null);
    // Ownership is a set, while checks themselves retain execution order. JSONB
    // canonicalization may change traversal order inside an expression before
    // the official upgrade gathers the same diagnostic owners.
    const checks = rows => rows.map(check => ({ ...check, columns: [...check.columns].sort() }));
    for (const key of ['formatVersion', 'evaluatorVersion', 'sourceContractVersion', 'sourceSupport', 'nameReadiness']) {
      if (!equal(before[key], after[key])) return null;
    }
    for (const key of ['sources', 'tables', 'questionContracts']) {
      for (const [id, value] of Object.entries(before[key])) if (!equal(value, after[key][id])) return null;
    }
    const oldIds = new Set(before.bindings.map(b => b.id));
    if (!equal(before.bindings, after.bindings.filter(b => oldIds.has(b.id)))) return null;
    if (before.groups.length !== after.groups.length) return null;
    for (let i = 0; i < before.groups.length; i++) {
      const oldGroup = before.groups[i], nextGroup = after.groups[i];
      if (oldGroup.route !== nextGroup.route || !equal(oldGroup.name, nextGroup.name)
        || !equal(oldGroup.columns, nextGroup.columns.slice(0, oldGroup.columns.length))
        || !equal(oldGroup.evaluate, nextGroup.evaluate)
        || !equal(checks(oldGroup.outputChecks), checks((nextGroup.outputChecks || []).filter(check => check.columns.some(column => oldGroup.columns.includes(column)))))
        || !equal(oldGroup.rows.map(row => [row.id, row.default]), nextGroup.rows.map(row => [row.id, row.default]))) return null;
      for (const row of oldGroup.rows) for (const target of oldGroup.columns) {
        if (ruleProof(before, oldGroup.route, row.id, target) !== ruleProof(after, oldGroup.route, row.id, target)) return null;
      }
    }
    return before;
  } catch {
    // Invalid/unprovable conversion retains the original strict comparison.
    return null;
  }
}
// Only this exact official policy conversion may retag unchanged decisions.
// Keep the old name guard and policy in the comparison: names still need review.
function equivalentNameUpgrade(oldDefinition, nextDefinition) {
  const { POLICY, upgradeNameReadiness } = require('../export-templates/effective-product-names');
  if (oldDefinition.nameReadiness === POLICY || nextDefinition.nameReadiness !== POLICY) return null;
  try {
    const expected = compileDefinition(upgradeNameReadiness(oldDefinition)).definition;
    const after = compileDefinition(nextDefinition).definition;
    // JSONB/canonical object traversal can reorder diagnostic owners. Ownership
    // is a set; execution order, expressions and every other definition fact stay strict.
    const ownership = definition => ({ ...definition, groups: definition.groups.map(group => ({ ...group,
      outputChecks: (group.outputChecks || []).map(check => ({ ...check, columns: [...check.columns].sort() })),
    })) });
    if (c.hash(ownership(expected)) !== c.hash(ownership(after))) return null;
    const before = upgradeColumns(oldDefinition);
    before.evaluatorVersion = expected.evaluatorVersion;
    before.sourceContractVersion = expected.sourceContractVersion;
    return before;
  } catch { return null; }
}

function stableReviewedSource(source, oldDefinition, nextDefinition, nextSchema = source.schema) {
  oldDefinition = equivalentNameUpgrade(oldDefinition, nextDefinition) || equivalentColumnUpgrade(oldDefinition, nextDefinition) || oldDefinition;
  const result = structuredClone(source); const changed = new Set();
  for (const a of result.bindings.attributes) {
    const group = a.routeKey.split(/[.:]/)[0];
    const route = source.bindings.routes.find((r) => r.routeKey === a.routeKey);
    const routeChanged = ruleProof(oldDefinition, group, 'base', 'attribute_set_code') !== ruleProof(nextDefinition, group, 'base', 'attribute_set_code');
    const oldSet = source.schema?.attributeSets.find(s => s.attribute_set_id === route?.setId);
    const nextSet = nextSchema?.attributeSets.find(s => s.attribute_set_id === route?.setId);
    const setChanged = c.hash(oldSet?.attribute_set_name || null) !== c.hash(nextSet?.attribute_set_name || null);
    const membershipLost = a.attributeCode && nextSchema && route?.setId && !nextSchema.attributeSets.find((s) => s.attribute_set_id === route.setId)?.attributeCodes.includes(a.attributeCode);
    const before = ruleProof(oldDefinition, group, a.rowId, a.target);
    const metadata = (schema) => {
      const attr = schema?.attributes.find((v) => v.attribute_code === a.attributeCode);
      if (!attr) return null;
      const { options: ignored, ...identity } = attr; void ignored; return identity;
    };
    if (routeChanged || setChanged || membershipLost || !before || before !== ruleProof(nextDefinition, group, a.rowId, a.target)
      || c.hash(storeProof(source.schema, a.rowId)) !== c.hash(storeProof(nextSchema, a.rowId))
      || c.hash(metadata(source.schema)) !== c.hash(metadata(nextSchema))) {
      changed.add(a.bindingKey); a.reviewState = 'review_required';
      for (const category of a.evidence?.categories || []) category.reviewState = 'review_required';
    }
  }
  for (const kind of ['options', 'policies']) for (const decision of result.bindings[kind]) {
    if (changed.has(decision.bindingKey)) decision.reviewState = 'review_required';
  }
  for (const r of result.bindings.routes) {
    const group = r.routeKey.split(/[.:]/)[0];
    if (ruleProof(oldDefinition, group, 'base', 'attribute_set_code') !== ruleProof(nextDefinition, group, 'base', 'attribute_set_code')) r.reviewState = 'review_required';
  }
  return result;
}
function command(input, apply = false) {
  c.command(input, ['sourceId','expectedSourceRevision','templateVersionId'], ['productIds', ...(apply ? ['previewToken'] : [])]);
  c.identity(input.sourceId); c.identity(input.templateVersionId); c.counter(input.expectedSourceRevision);
  if (input.productIds && (!Array.isArray(input.productIds) || input.productIds.length > 100
    || input.productIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(input.productIds).size !== input.productIds.length)) c.invalid();
}
async function local(client, config, input) {
  const source = await editor.selected(client, config, input.sourceId);
  const currentRow = await repository.current(client, source.installationKey);
  if (source.state !== 'published' || source.revision !== c.counter(input.expectedSourceRevision) || currentRow?.id !== source.id) {
    throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Current publication changed');
  }
  const version = (await client.query('SELECT * FROM export_template_versions WHERE id=$1', [input.templateVersionId])).rows[0];
  if (!version) throw c.error(404, 'TEMPLATE_VERSION_NOT_FOUND', 'Published template required');
  const compiled = compileDefinition(version.definition);
  if (compiled.hash !== version.definition_hash) throw c.error(409, 'TEMPLATE_VERSION_INTEGRITY', 'Template identity differs');
  const old = await editor.compiledRevision(client, source);
  const catalog = await getAppConfig(client);
  const ids = input.productIds || (await client.query("SELECT id FROM products WHERE status='active' AND exclude_from_export=0 ORDER BY category,id LIMIT 100")).rows.map((r) => Number(r.id));
  const loaded = await loadDraftPreviewProducts(client, ids);
  if (loaded.missingProductIds.length) throw c.error(409, 'MAGENTO_PRODUCT_NOT_FOUND', 'Selected product changed');
  const support = await loadSupportInputs(client, compiled.definition, loaded.products);
  const currentQuestions = Object.entries(catalog.questions).flatMap(([category, questions]) => questions.map((q) => ({ ...q,
    key: q.id, category_code: category, options: q.options.filter((o) => !o.archived).map((o) => ({ ...o, value_id: o.id })) })));
  const schemas = (await client.query("SELECT id,category_code,config_hash,status FROM sku_schema_versions ORDER BY id")).rows;
  return { source, oldDefinition: old.compiled.definition, compiled, products: support.products, current: currentQuestions,
    localHash: c.hash({ sourceId: source.id, revision: source.revision, templateHash: compiled.hash, catalog, schemas, products: support.products }) };
}
async function prepare(config, input, options = {}) {
  command(input);
  const amber = await editor.read(options, (client) => local(client, config, input));
  const fetchImpl = boundedGet(options.fetchImpl);
  const observation = await (options.discover || editor.discovery)(config, { fetchImpl });
  const candidates = buildCandidates(amber, observation.schema, observation.categories, { includeStaticCategories: true });
  const target = { id: null, originHash: amber.source.originHash, schema: observation.schema, bindings: candidates };
  const source = stableReviewedSource(amber.source, amber.oldDefinition, amber.compiled.definition, observation.schema);
  const live = await collectLiveVerification(source, target, amber.compiled.definition, config, { ...options, fetchImpl });
  const carry = carryReviewedBindings(source, target, amber.compiled.definition, live);
  const previewToken = c.hash({ localHash: amber.localHash, schema: observation.schema, categories: observation.categories,
    bindings: carry.bindings, blockers: carry.blockers });
  return { previewToken, sourceId: source.id, templateVersionId: input.templateVersionId, carried: carry.summary,
    skipped: carry.skipped, blockers: carry.blockers, productIds: amber.products.map((p) => p.id),
    observation, bindings: carry.bindings, localHash: amber.localHash };
}
async function apply(config, input, options = {}) {
  command(input, true);
  const { previewToken, ...request } = input;
  if (typeof previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(previewToken)) c.invalid();
  const fresh = await prepare(config, request, options);
  if (fresh.previewToken !== previewToken || fresh.blockers.some((b) => b.code === 'RESULT_BINDING_INVALID')) throw c.error(409, 'MAGENTO_SUCCESSOR_PREVIEW_STALE', 'Repeat successor preparation', { blockers: fresh.blockers });
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.manage', createError: c.error, operation: async (client) => {
      // All remote reads finished. Lock short-lived local evidence before its final check.
      for (const table of ['categories','questions','options','sku_schema_versions']) await client.query(`SELECT * FROM ${table} ORDER BY 1 FOR SHARE`);
      await client.query('SELECT id FROM products WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE', [fresh.productIds]);
      const amber = await local(client, config, request);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${amber.source.installationKey}`]);
      const current = await repository.current(client, amber.source.installationKey);
      if (current?.id !== input.sourceId || amber.localHash !== fresh.localHash) throw c.error(409, 'MAGENTO_SUCCESSOR_PREVIEW_STALE', 'Local evidence changed');
      const seed = structuredClone(fresh.bindings);
      for (const decision of Object.values(seed).flat()) {
        if (decision.reviewState === 'approved') decision.reviewState = 'review_required';
        for (const category of decision.evidence?.categories || []) if (category.reviewState === 'approved') category.reviewState = 'review_required';
      }
      const draft = await service.createDraftOnClient(client, context, { installationKey: amber.source.installationKey,
        origin: config.baseUrl, templateVersionId: input.templateVersionId, observedAt: fresh.observation.observedAt,
        schema: fresh.observation.schema, bindings: seed });
      await repository.replaceBindings(client, draft.id, fresh.bindings, requirements(amber.compiled.definition, fresh.observation.schema));
      await writeAuditEvent(client, { mutationContext: context, eventKey: 'magento_binding.successor_prepared', subjectType: 'magento_binding',
        subjectId: draft.id, details: { sourceId: input.sourceId, previewToken, carried: fresh.carried, bindingsHash: c.hash(fresh.bindings) } });
      return service.readRevisionOnClient(client, draft.id);
    } });
}
module.exports = { ruleProof, equivalentColumnUpgrade, equivalentNameUpgrade, stableReviewedSource, prepare, apply };
