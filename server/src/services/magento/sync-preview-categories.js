const { error } = require('./binding-contract');
const invalid = () => { throw error(422, 'MAGENTO_PREVIEW_CATEGORIES_INVALID', 'Invalid Magento category evidence'); };
const categoryId = (v) => /^(?:[1-9][0-9]*)$/.test(String(v)) && Number.isSafeInteger(Number(v));
const normalizePath = (path) => path.split('/').map((part) => part.trim().normalize('NFC')).join('/');

function indexTrees(trees) {
  const nodes = []; const ids = new Set();
  function visit(node, parents, parentId, depth) {
    if (depth > 30 || nodes.length >= 10000 || !node || !categoryId(node.id) || ids.has(String(node.id))
      || typeof node.name !== 'string' || !node.name.trim() || node.name.length > 4096
      || (parentId !== null && Number(node.parent_id) !== parentId) || !Array.isArray(node.children_data)) invalid();
    ids.add(String(node.id));
    const parts = [...parents, node.name];
    nodes.push({ categoryId: String(node.id), path: parts.join('/'), normalizedPath: normalizePath(parts.join('/')),
      // A slash inside a category name cannot be identified by this CSV path syntax.
      comparable: parts.every((p) => !p.includes('/')) });
    for (const child of node.children_data) visit(child, parts, Number(node.id), depth + 1);
  }
  for (const tree of trees) visit(tree, [], null, 0);
  return nodes;
}

function currentAssignments(raw) {
  if (!raw) return { known: true, source: 'new_product', links: [] };
  const links = raw.extension_attributes?.category_links;
  const custom = (raw.custom_attributes || []).filter((a) => a.attribute_code === 'category_ids');
  if (custom.length > 1) invalid();
  const ids = custom[0]?.value;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some((v) => !categoryId(v)))) invalid();
  if (links !== undefined) {
    // Magento CategoryLinkInterface::getPosition is int|null. Ordering positions
    // may be negative; they are not category identities. Preserve signed values,
    // and retain unknown positions as null so the native payload stays blocked.
    if (!Array.isArray(links) || links.length > 1000 || links.some((l) => !categoryId(l?.category_id)
      || (l.position != null && !Number.isSafeInteger(l.position)))) invalid();
    const unique = new Set(links.map((l) => String(l.category_id)));
    if (unique.size !== links.length || (ids && (ids.length !== unique.size || ids.some((id) => !unique.has(String(id)))))) invalid();
    return { known: true, source: 'extension_attributes.category_links',
      links: links.map((l) => ({ category_id: String(l.category_id), position: l.position ?? null })) };
  }
  return { known: ids !== undefined, source: ids ? 'custom_attributes.category_ids' : 'unavailable',
    links: (ids || []).map((id) => ({ category_id: String(id), position: null })) };
}

function resolveCategories(value, nodes, assignments, { ownershipApproved = false, decisions = [] } = {}) {
  if (typeof value !== 'string' || value.length > 16384) invalid();
  const paths = value ? [...new Set(value.split(',').map((p) => p.trim()))] : [];
  if (paths.length > 100) invalid();
  const requested = paths.map((requestedPath) => {
    const normalizedPath = normalizePath(requestedPath);
    const candidates = nodes.filter((n) => n.comparable && n.normalizedPath === normalizedPath);
    // A leaf is never a path, even when currently unique.
    const fullPath = normalizedPath.split('/').length > 1 && normalizedPath.split('/').every(Boolean);
    const matches = fullPath ? candidates : [];
    const decision = decisions.find((d) => d.normalizedPath === normalizedPath) || null;
    const approved = decision?.reviewState === 'approved' && matches.length === 1 && decision.categoryId === matches[0].categoryId;
    return { requestedPath, normalizedPath, exactCandidates: matches.map(({ categoryId, path }) => ({ categoryId, path })),
      categoryId: matches.length === 1 ? matches[0].categoryId : null,
      status: decision?.reviewState === 'blocked' ? 'blocked' : approved ? 'resolved_authoritative'
        : matches.length === 1 ? 'candidate_only' : matches.length > 1 ? 'ambiguous' : 'missing',
      authority: decision?.reviewState === 'blocked' ? 'blocked' : approved ? 'authoritative' : matches.length === 1 ? 'candidate_only' : 'unresolved',
      persistedDecision: decision, drifted: decision?.reviewState === 'approved' && !approved };
  });
  const current = assignments.links.map((l) => ({ categoryId: l.category_id,
    path: nodes.find((n) => n.categoryId === l.category_id)?.path ?? null, position: l.position }));
  const desired = new Set(requested.flatMap((r) => r.categoryId ? [r.categoryId] : []));
  const existing = new Set(current.map((c) => c.categoryId));
  const extras = current.filter((c) => !desired.has(c.categoryId));
  const wouldAdd = requested.filter((r) => r.categoryId && !existing.has(r.categoryId));
  const preservedMagentoOnly = ownershipApproved ? [] : extras.map((c) => ({ ...c, action: 'preserve_by_safe_preview' }));
  // Without known assignments/positions, omit the domain entirely; never reconstruct destructive state.
  const candidateLinks = assignments.known && assignments.links.every((l) => l.position !== null)
    ? [...assignments.links.filter((l) => !ownershipApproved || desired.has(l.category_id)),
      ...wouldAdd.map((r) => ({ category_id: r.categoryId, position: 0 }))] : null;
  return { requested, current, currentEvidence: assignments.source, currentKnown: assignments.known,
    intersection: current.filter((c) => desired.has(c.categoryId)), wouldAdd,
    wouldRemoveIfAuthoritative: extras, preservedMagentoOnly, candidateLinks };
}
module.exports = { normalizePath, indexTrees, currentAssignments, resolveCategories };
