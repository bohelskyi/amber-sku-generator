const c = require('./binding-contract');
const { createMagentoClient } = require('./client');
const { createInclusionCategory } = require('./category-create-client');
const { indexTrees } = require('./sync-preview-categories');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');

const { PARENT, PATH, SOURCE } = require('./category-create-target');
const fail = (code) => { throw c.error(422, code, 'Category operation requires review'); };

function context(revision, config, path) {
  if (path !== PATH) fail('MAGENTO_CATEGORY_PATH_UNSUPPORTED');
  if (revision.state !== 'draft' || revision.schema.storeCode !== 'all'
    || revision.originHash !== c.originHash(config.baseUrl)) fail('MAGENTO_CATEGORY_REVISION_INVALID');
  const route = revision.bindings.routes.find((r) => r.routeKey === 'KL:all');
  if (!route?.enabled || route.reviewState !== 'approved') fail('MAGENTO_CATEGORY_REVISION_INVALID');
  const a = revision.bindings.attributes.find((a) => a.routeKey === 'KL:all' && a.rowId === 'base' && a.target === 'categories');
  const policy = revision.bindings.policies.find((p) => p.bindingKey === a?.bindingKey && p.storeCode === 'all');
  const decision = a?.evidence.categories?.find((d) => d.normalizedPath === PATH);
  if (!decision || a.reviewState !== 'approved' || policy?.reviewState !== 'approved'
    || policy.policy !== 'authoritative_create_update') fail('MAGENTO_CATEGORY_OWNERSHIP_REQUIRED');
  const parent = a.evidence.categories.find((d) => d.normalizedPath === PARENT);
  if (parent?.reviewState !== 'approved' || !parent.categoryId) fail('MAGENTO_CATEGORY_PARENT_APPROVAL_REQUIRED');
  return { a, decision, parent };
}

async function livePaths(client) {
  const groups = await client.getStoreGroups();
  if (!Array.isArray(groups) || groups.length > 100) fail('MAGENTO_CATEGORY_TOPOLOGY_INVALID');
  const roots = [...new Set(groups.map((g) => g.root_category_id).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!roots.length) fail('MAGENTO_CATEGORY_TOPOLOGY_INVALID');
  const trees = [];
  for (const root of roots) {
    const tree = await client.getCategoryTree(root);
    if (Number(tree?.id) !== root) fail('MAGENTO_CATEGORY_TOPOLOGY_INVALID');
    trees.push(tree);
  }
  return indexTrees(trees);
}
function resolve(nodes, parentDecision) {
  const parents = nodes.filter((n) => n.comparable && n.normalizedPath === PARENT);
  if (parents.length !== 1 || parents[0].categoryId !== parentDecision.categoryId) fail('MAGENTO_CATEGORY_PARENT_NOT_EXACT');
  const children = nodes.filter((n) => n.comparable && n.normalizedPath === PATH);
  if (children.length > 1) fail('MAGENTO_CATEGORY_PATH_AMBIGUOUS');
  return { parentId: Number(parents[0].categoryId), existing: children[0] || null };
}

// Commit an immutable, globally keyed attempt BEFORE dispatch. The existing access
// lock serializes independent processes/revisions using this database. An uncertain
// attempt is never resent, including after process death or a failed local binding save.
async function reserveAttempt(revision, operation, options) {
  const mutationContext = createMutationContext(options.mutationContext);
  const key = c.hash({ originHash: revision.originHash, path: PATH });
  return runAccessAdminMutation({ databasePool: options.databasePool || require('../../db/pool'),
    actorUserId: mutationContext.actorUserId, requiredPermission: 'export_templates.publish', createError: c.error,
    operation: async (client) => {
      await assertActorStillAuthorized(client, mutationContext.actorUserId, 'export_templates.manage', c.error);
      const row = (await client.query('SELECT state, revision FROM magento_binding_revisions WHERE id=$1 FOR UPDATE', [revision.id])).rows[0];
      if (row?.state !== 'draft' || row.revision !== revision.revision) fail('MAGENTO_BINDING_CONFLICT');
      const prior = (await client.query(`SELECT id FROM audit_events
        WHERE event_key='magento_category.create_attempted' AND subject_id=$1 LIMIT 1`, [key])).rows[0];
      if (prior) fail('MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED');
      await writeAuditEvent(client, { mutationContext, eventKey: 'magento_category.create_attempted',
        subjectType: 'magento_category', subjectId: key, details: { revisionId: revision.id,
          revision: revision.revision, source: SOURCE, operation } });
      return key;
    } });
}

async function createCategory(config, input, options = {}) {
  const service = options.bindingService || require('./binding.service');
  const revision = await service.getRevision(input.id, options);
  const ctx = context(revision, config, input.path);
  const client = createMagentoClient(config, { fetchImpl: options.fetchImpl });
  let live = resolve(await livePaths(client), ctx.parent);
  const operation = { method: 'POST', path: '/rest/all/V1/categories',
    body: { category: { parent_id: live.parentId, name: 'З інклюзом', is_active: true, include_in_menu: false } } };
  const result = { path: PATH, source: SOURCE, parentPath: PARENT, parentId: live.parentId,
    categoryId: live.existing?.categoryId || null, operation: live.existing ? null : operation,
    status: live.existing ? 'existing' : 'would_create', applied: false, magentoWriteAttempted: false };
  if (input.apply !== true) return result;
  if (live.existing && ctx.decision.reviewState === 'approved' && ctx.decision.categoryId === live.existing.categoryId) return result;
  if (c.counter(input.expectedRevision) !== revision.revision) fail('MAGENTO_BINDING_CONFLICT');
  if (!live.existing) {
    await (options.reserveAttempt || reserveAttempt)(revision, operation, options);
    // A second full-hierarchy precheck narrows the race with external operators.
    live = resolve(await livePaths(client), ctx.parent);
    if (!live.existing) {
      result.magentoWriteAttempted = true;
      let returned;
      try { returned = await createInclusionCategory(config, operation.body, { apply: true, fetchImpl: options.fetchImpl }); }
      catch { /* Recovery is GET-only, including timeouts and HTTP errors. */ }
      live = resolve(await livePaths(client), ctx.parent);
      if (!live.existing) fail('MAGENTO_CATEGORY_CREATE_UNCERTAIN');
      if (returned && (String(returned.id) !== live.existing.categoryId || returned.name !== 'З інклюзом'
        || Number(returned.parent_id) !== live.parentId)) fail('MAGENTO_CATEGORY_VERIFICATION_FAILED');
    }
  }
  const bindings = structuredClone(revision.bindings);
  const decision = bindings.attributes.find((a) => a.bindingKey === ctx.a.bindingKey).evidence.categories
    .find((d) => d.normalizedPath === PATH);
  Object.assign(decision, { categoryId: live.existing.categoryId, reviewState: 'approved',
    candidates: [{ categoryId: live.existing.categoryId, path: live.existing.path }],
    note: `Explicit category action for ${SOURCE}; verified exact full hierarchy; no leaf matching.` });
  const saved = await service.updateDraft(revision.id, { expectedRevision: revision.revision, bindings }, options);
  return { ...result, applied: true, status: result.magentoWriteAttempted ? 'verified_after_create' : 'existing_bound',
    categoryId: live.existing.categoryId, bindingRevision: saved.revision };
}
module.exports = { createCategory, reserveAttempt, PATH, PARENT, SOURCE };
