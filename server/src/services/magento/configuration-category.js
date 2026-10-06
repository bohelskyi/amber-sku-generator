const c = require('./binding-contract');
const actions = require('./configuration-actions');
const { boundedGet } = require('./integration-readiness');
const { createMagentoClient, readJson } = require('./client');
const { indexTrees, normalizePath } = require('./sync-preview-categories');
const { signCategoryCreateRequest } = require('./oauth');
const { validateBaseUrl } = require('../../config/magento');
const fail = (code) => { throw c.error(409, code, 'Потрібна повторна перевірка категорії Magento.'); };
function plannedTarget(nodes, input) {
  if (!c.positive(input.parentId) || typeof input.name !== 'string' || !input.name || input.name.length > 255
    || input.name !== input.name.trim() || input.name !== input.name.normalize('NFC') || /[/,\u0000-\u001f\u007f]/.test(input.name)) {
    throw c.error(422, 'MAGENTO_CATEGORY_NAME_INVALID', 'Вкажіть назву до 255 символів без /, коми, керівних символів і крайніх пробілів.');
  }
  const parent = nodes.find((node) => node.comparable && Number(node.categoryId) === input.parentId);
  if (!parent || nodes.filter((node) => node.comparable && node.normalizedPath === parent.normalizedPath).length !== 1) fail('MAGENTO_CATEGORY_PARENT_NOT_EXACT');
  const path = `${parent.normalizedPath}/${input.name}`;
  if (path.length > 4096 || path.split('/').length > 30 || /[,\u0000-\u001f\u007f]/.test(path)
    || normalizePath(path) !== path) fail('MAGENTO_CATEGORY_REQUIREMENT_UNRESOLVED');
  const existing = nodes.filter((node) => node.comparable && node.normalizedPath === path);
  if (existing.length > 1) fail('MAGENTO_CATEGORY_PATH_AMBIGUOUS');
  return { path, parentPath: parent.normalizedPath, parentId: input.parentId, name: input.name,
    categoryId: existing[0]?.categoryId || null, status: existing.length ? 'existing' : 'would_create',
    body: { category: { parent_id: input.parentId, name: input.name, is_active: true, include_in_menu: false } } };
}
// General authoring preview. It allocates no category, draft, action or SKU;
// dispatch remains limited to an exact requirement in a reviewed binding draft.
async function plan(config, input, options = {}) {
  c.command(input, ['categoryCode', 'parentId', 'name']);
  if (typeof input.categoryCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(input.categoryCode)) c.invalid();
  plannedTarget([{ categoryId: String(input.parentId), normalizedPath: 'Default', comparable: true }], input);
  const category = await require('./integration-editor.service').read(options, async (client) => {
    const local = (await client.query('SELECT code,name FROM categories WHERE code=$1', [input.categoryCode])).rows[0];
    if (!local) throw c.error(404, 'MAGENTO_CATEGORY_NOT_FOUND', 'Спочатку створіть тип товару з цим кодом у каталозі Manager.');
    const count = (await client.query("SELECT count(*)::int AS count FROM products WHERE category=$1 AND status='active' AND corrected_to_product_id IS NULL", [input.categoryCode])).rows[0].count;
    return { ...local, activeProductUpperBound: count };
  });
  const { nodes } = await live(config, options);
  const target = plannedTarget(nodes, input);
  return { ...target, categoryCode: category.code, categoryName: category.name, observedAt: new Date().toISOString(),
    observationHash: c.hash(nodes), impact: { categoryCreates: target.categoryId ? 0 : 1, productWrites: 0,
      bindingPublished: false, menuVisible: false, activeProductUpperBound: category.activeProductUpperBound,
      publicationReviewRequired: true }, magentoWriteAttempted: false };
}
function categoryTarget(revision, input, nodes) {
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) fail('MAGENTO_BINDING_CONFLICT');
  const a = revision.bindings.attributes.find((a) => a.bindingKey === input.bindingKey && a.target === 'categories');
  const d = a?.evidence.categories?.find((d) => d.normalizedPath === input.path);
  if (!d || typeof input.path !== 'string' || input.path.length > 4096 || /[,\u0000-\u001f]/.test(input.path)
    || normalizePath(input.path) !== input.path) fail('MAGENTO_CATEGORY_REQUIREMENT_UNRESOLVED');
  const parts = input.path.split('/'); const name = parts.pop(); const parentPath = parts.join('/');
  if (!name || !parentPath || parts.length > 29 || name.length > 255) fail('MAGENTO_CATEGORY_REQUIREMENT_UNRESOLVED');
  const parents = nodes.filter((n) => n.comparable && n.normalizedPath === parentPath);
  if (parents.length !== 1 || !Number.isSafeInteger(input.parentId) || Number(parents[0].categoryId) !== input.parentId) fail('MAGENTO_CATEGORY_PARENT_NOT_EXACT');
  const existing = nodes.filter((n) => n.comparable && n.normalizedPath === input.path);
  if (existing.length) fail(existing.length === 1 ? 'MAGENTO_CATEGORY_ALREADY_EXISTS' : 'MAGENTO_CATEGORY_PATH_AMBIGUOUS');
  const target = plannedTarget(nodes, { parentId: input.parentId, name });
  if (target.path !== input.path) fail('MAGENTO_CATEGORY_PARENT_NOT_EXACT');
  return { path: target.path, parentPath, parentId: input.parentId, body: target.body };
}
function verifyCategory(target, id, remote, nodes) {
  const matches = nodes.filter((n) => n.comparable && n.normalizedPath === target.path);
  if (!id || String(remote?.id) !== id || matches.length !== 1 || matches[0].categoryId !== id
    || remote.name !== target.body.category.name || Number(remote.parent_id) !== target.parentId
    || remote.is_active !== true || remote.include_in_menu !== false) fail('MAGENTO_CATEGORY_VERIFICATION_FAILED');
  return true;
}
async function live(config, options) {
  const client = createMagentoClient(config, { fetchImpl: boundedGet(options.fetchImpl) });
  const groups = await client.getStoreGroups();
  if (!Array.isArray(groups) || groups.length > 100) c.invalid();
  const roots = [...new Set(groups.map((g) => g.root_category_id).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!roots.length) c.invalid();
  const trees = [];
  for (const root of roots) { const tree = await client.getCategoryTree(root); if (Number(tree?.id) !== root) c.invalid(); trees.push(tree); }
  return { client, nodes: indexTrees(trees) };
}
async function preview(config, input, options = {}) {
  c.command(input, ['bindingRevisionId','expectedRevision','bindingKey','path','parentId']);
  const revision = await require('./binding.service').getRevision(c.identity(input.bindingRevisionId), options);
  if (revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') c.invalid();
  const { nodes } = await live(config, options); const target = categoryTarget(revision, input, nodes);
  const result = { kind: 'category', bindingRevisionId: revision.id, expectedRevision: revision.revision,
    resource: { path: target.path }, ...target, observationHash: c.hash(nodes),
    bindingKey: input.bindingKey, impact: { categoryCreates: 1, productWrites: 0, bindingPublished: false,
      menuVisible: false, publicationReviewRequired: true,
      requiredBindingCount: revision.bindings.attributes.filter((a) => a.target === 'categories'
        && a.evidence.categories?.some((d) => d.normalizedPath === target.path)).length } };
  return { ...result, previewToken: c.hash(result) };
}
async function reconcile(config, input, options = {}) {
  c.command(input, ['actionId']);
  const row = await actions.get(config, input.actionId, options);
  if (row.kind !== 'category') c.invalid();
  if (row.state === 'verified') return actions.receipt(row);
  // Lost response/process death without an exact returned ID is not label-based proof.
  if (row.state !== 'returned') fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
  const { client, nodes } = await live(config, options);
  const remote = await client.getCategory(Number(row.remote_id));
  verifyCategory(row.intent, row.remote_id, remote, nodes);
  return actions.receipt(await actions.transition(row.id, 'returned', 'verified', {
    remoteId: row.remote_id, path: row.intent.path, parentId: row.intent.parentId,
    flags: { isActive: true, includeInMenu: false }, observationHash: c.hash(nodes) }, options));
}
async function apply(config, input, options = {}) {
  c.command(input, ['bindingRevisionId','expectedRevision','bindingKey','path','parentId','previewToken']);
  const { previewToken, ...command } = input;
  const reviewed = await preview(config, command, options);
  if (reviewed.previewToken !== previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE');
  const row = await actions.seal(config, reviewed, options);
  // Repeat exact preconditions outside locks immediately before the dispatch marker.
  const fresh = await preview(config, command, options);
  if (fresh.previewToken !== previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE');
  await actions.transition(row.id, 'sealed', 'dispatched', {}, options);
  const url = `${validateBaseUrl(config.baseUrl)}/rest/all/V1/categories`;
  let response;
  try {
    response = await (options.fetchImpl || globalThis.fetch)(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: signCategoryCreateRequest(url, config) },
      body: JSON.stringify(reviewed.body) });
    if (!response.ok) fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
    const returned = await readJson(response);
    if (!Number.isSafeInteger(returned?.id) || returned.id <= 0) fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
    await actions.transition(row.id, 'dispatched', 'returned', { remoteId: String(returned.id) }, options);
  } catch {
    throw c.error(409, 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED', 'Amber надіслав зміну, але результат не підтверджено. Повторне надсилання недоступне.', { actionId: row.id });
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  try { return await reconcile(config, { actionId: row.id }, options); }
  catch { throw c.error(409, 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED', 'Створення потребує GET-перевірки.', { actionId: row.id }); }
}
module.exports = { plannedTarget, plan, categoryTarget, verifyCategory, preview, apply, reconcile, live };
