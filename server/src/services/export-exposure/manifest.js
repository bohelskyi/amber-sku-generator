const { buildExposureIndex, classifyExposure, canonical, stableJson, hash,
  uniqueSorted, compare, byId } = require('./evidence');
const productId = (value) => value == null ? null : Number(value);

function storedDiff(before, after, path = '') {
  if (stableJson(before) === stableJson(after)) return [];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compare).flatMap((key) =>
      storedDiff(before[key], after[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [{ path: path || '/', beforePresent: before !== undefined, afterPresent: after !== undefined,
    ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }];
}

function buildLineageGraph(products, corrections) {
  const byProduct = new Map(products.map((p) => [Number(p.id), p]));
  const parents = new Map(); const children = new Map(); const localIssues = new Map();
  const touch = (id) => {
    if (!parents.has(id)) { parents.set(id, new Set()); children.set(id, new Set()); localIssues.set(id, []); }
  };
  const issue = (id, code, evidence = {}) => { touch(id); localIssues.get(id).push({ code, productId: id, ...evidence }); };
  const edge = (from, to) => {
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to <= 0) return;
    touch(from); touch(to); parents.get(to).add(from); children.get(from).add(to);
  };
  for (const product of products) {
    const id = Number(product.id); touch(id);
    if (product.corrected_from_product_id != null) edge(Number(product.corrected_from_product_id), id);
    if (product.corrected_to_product_id != null) edge(id, Number(product.corrected_to_product_id));
  }
  const correctionEdges = new Map();
  for (const correction of corrections) {
    const from = productId(correction.source_product_id); const to = productId(correction.corrected_product_id);
    edge(from, to);
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to <= 0) {
      for (const id of [from, to]) issue(id, 'LINEAGE_ENDPOINT_INVALID', { correctionId: correction.id,
        sourceProductId: from, successorProductId: to });
    }
    const key = `${from}:${to}`;
    if (!correctionEdges.has(key)) correctionEdges.set(key, []);
    correctionEdges.get(key).push(correction.id);
    for (const [id, sku, other, field] of [
      [from, correction.source_sku, to, 'corrected_to_product_id'],
      [to, correction.corrected_sku, from, 'corrected_from_product_id'],
    ]) {
      const product = byProduct.get(id);
      if (!product) issue(id, 'LINEAGE_PRODUCT_MISSING', { correctionId: correction.id });
      else {
        if (product.full_sku !== sku) issue(id, 'CORRECTION_SKU_MISMATCH', { correctionId: correction.id, storedSku: sku });
        if (Number(product[field]) !== other) issue(id, 'LINEAGE_LINK_MISMATCH', { correctionId: correction.id, field });
      }
    }
  }
  for (const [id, next] of children) {
    if (!byProduct.has(id)) issue(id, 'LINEAGE_PRODUCT_MISSING');
    if (next.size > 1 || parents.get(id).size > 1) issue(id, 'LINEAGE_BRANCH');
    for (const target of next) {
      const matching = correctionEdges.get(`${id}:${target}`) || [];
      if (matching.length !== 1) issue(id, matching.length ? 'DUPLICATE_CORRECTION_EDGE' : 'CORRECTION_EDGE_MISSING', {
        successorId: target, correctionIds: [...matching].sort((a, b) => Number(a) - Number(b)),
      });
    }
  }
  const components = new Map();
  for (const start of [...parents.keys()].sort((a, b) => a - b)) {
    if (components.has(start)) continue;
    const visited = new Set(); const pending = [start];
    while (pending.length) {
      const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
      pending.push(...parents.get(id), ...children.get(id));
    }
    const ids = [...visited].sort((a, b) => a - b);
    const issues = ids.flatMap((id) => localIssues.get(id));
    const degrees = new Map(ids.map((id) => [id, parents.get(id).size]));
    const roots = ids.filter((id) => degrees.get(id) === 0); let processed = 0;
    while (roots.length) {
      const id = roots.pop(); processed += 1;
      for (const child of children.get(id)) {
        degrees.set(child, degrees.get(child) - 1); if (degrees.get(child) === 0) roots.push(child);
      }
    }
    if (processed !== ids.length) issues.push({ code: 'LINEAGE_CYCLE', productIds: ids });
    const component = { productIds: ids, issues: uniqueSorted(issues) };
    for (const id of ids) components.set(id, component);
  }
  function reachable(start, links) {
    const result = []; const visited = new Set([start]);
    const pending = [...(links.get(start) || [])].sort((a, b) => a - b);
    while (pending.length) {
      const id = pending.shift(); if (visited.has(id)) continue;
      visited.add(id); result.push(id); pending.push(...[...(links.get(id) || [])].sort((a, b) => a - b));
    }
    return result;
  }
  return { components,
    ancestors: (id) => reachable(id, parents).reverse(),
    terminals: (id) => [id, ...reachable(id, children)].filter((item) => !children.get(item)?.size).sort((a, b) => a - b),
  };
}

function summarize(pairs) {
  const confirmed = (evidence) => evidence?.exact.some((item) => item.status === 'confirmed') || false;
  return {
    total: pairs.length,
    sourceConfirmed: pairs.filter((p) => confirmed(p.source.exposure)).length,
    successorConfirmed: pairs.filter((p) => confirmed(p.successor.exposure)).length,
    neitherImmediateRowConfirmed: pairs.filter((p) => !confirmed(p.source.exposure) && !confirmed(p.successor.exposure)).length,
    eitherImmediateRowGenerated: pairs.filter((p) => [...p.source.exposure.exact, ...p.successor.exposure.exact]
      .some((item) => item.status === 'generated')).length,
    successorAboveCursor: pairs.filter((p) => p.successor.cursorRelationship === 'above').length,
    successorAtOrBelowCursor: pairs.filter((p) => p.successor.cursorRelationship === 'at_or_below').length,
    confirmedAncestor: pairs.filter((p) => confirmed(p.ancestorExposure)).length,
    generatedAncestor: pairs.filter((p) => p.ancestorExposure.exact.some((e) => e.status === 'generated')).length,
    classifications: Object.fromEntries(['reliably_unexposed', 'generated_exact', 'confirmed_exact', 'historical_ambiguous']
      .map((name) => [name, pairs.filter((p) => p.lineageExposure.classification === name).length])),
  };
}

function buildCorrectionExposureManifest(input) {
  for (const key of ['products', 'corrections', 'snapshots', 'artifacts', 'revisions', 'events', 'state']) {
    if (!Array.isArray(input[key])) throw new Error(`Missing evidence collection: ${key}`);
  }
  const index = buildExposureIndex(input);
  const graph = buildLineageGraph(input.products, input.corrections);
  const aggregate = (ids, issues = []) => classifyExposure({
    exact: ids.flatMap((id) => index.productEvidence.get(id)?.exact || []),
    indicators: ids.flatMap((id) => (index.productEvidence.get(id)?.indicators || []).map((item) => ({ productId: id, ...item }))),
    issues: [...issues, ...ids.flatMap((id) => index.productEvidence.get(id)?.issues || [])],
  });
  const describe = (id) => {
    const product = index.byProduct.get(id);
    if (!product) return { id, missing: true, exposure: classifyExposure({ issues: [{ code: 'LINEAGE_PRODUCT_MISSING', productId: id }] }) };
    return { ...product, id,
      cursorRelationship: index.cursor === null ? 'unknown' : id > index.cursor ? 'above' : 'at_or_below',
      exposure: aggregate([id], graph.components.get(id)?.issues || []) };
  };
  const pairs = [...input.corrections].sort(byId).map((correction) => {
    const sourceId = productId(correction.source_product_id); const successorId = productId(correction.corrected_product_id);
    const ancestorIds = [...graph.ancestors(sourceId), sourceId];
    const issues = uniqueSorted([...(graph.components.get(sourceId)?.issues || []), ...(graph.components.get(successorId)?.issues || [])]);
    const terminalIds = graph.terminals(successorId);
    return {
      correctionId: Number(correction.id), category: index.byProduct.get(successorId)?.category ?? null,
      source: describe(sourceId), successor: describe(successorId),
      terminalDescendant: terminalIds.length === 1 ? describe(terminalIds[0]) : null,
      terminalCandidates: terminalIds,
      ancestorChain: ancestorIds.map((id) => ({ productId: id, sku: index.byProduct.get(id)?.full_sku ?? null })),
      ancestorExposure: aggregate(ancestorIds, issues),
      lineageExposure: aggregate([...new Set([...ancestorIds, successorId])], issues),
      lineageIssues: issues,
      storedCorrection: correction,
      storedPayloadDiff: storedDiff(correction.old_payload, correction.new_payload),
    };
  });
  const active = pairs.filter((p) => p.successor.status === 'active' && Number(p.successor.exclude_from_export) === 1);
  const successorIds = new Set(pairs.map((pair) => pair.successor.id));
  const terminalMap = new Map();
  for (const product of [...input.products].sort(byId)) {
    const target = describe(Number(product.id));
    const ancestorIds = graph.ancestors(target.id);
    if (target.status !== 'active' || (!ancestorIds.length && !successorIds.has(target.id))
        || !graph.terminals(target.id).includes(target.id)) continue;
    terminalMap.set(target.id, { product: target,
      correctionIds: pairs.filter((pair) => pair.terminalCandidates.includes(target.id)).map((pair) => pair.correctionId),
      ancestorChain: ancestorIds.map((id) => ({
        productId: id, sku: index.byProduct.get(id)?.full_sku ?? null,
      })), lineageExposure: aggregate([...ancestorIds, target.id], graph.components.get(target.id)?.issues || []) });
  }
  const payload = canonical({
    format: 'amber-correction-exposure-manifest-v1', evidenceScope: 'retained_database_evidence',
    limitations: ['Confirmation is not a Magento import receipt.',
      'No assertion about unrecorded external imports or deleted historical evidence.',
      'Raw payload differences are not semantic equivalence or repair authorization.'],
    database: input.database ?? null, cursor: index.cursor,
    exportState: uniqueSorted(input.state), legacyExportEvents: [...input.events].sort(byId),
    summary: { allPairs: summarize(pairs), activeExcludedSuccessors: summarize(active),
      byCategory: [...new Set(pairs.map((p) => p.category))].sort(compare).map((category) => ({ category,
        allPairs: summarize(pairs.filter((p) => p.category === category)),
        activeExcludedSuccessors: summarize(active.filter((p) => p.category === category)) })) },
    snapshotEvidence: index.snapshotEvidence, diagnostics: index.diagnostics,
    lineageDiagnostics: uniqueSorted([...graph.components.values()].flatMap((component) => component.issues)),
    products: [...input.products].sort(byId).map((p) => describe(Number(p.id))),
    correctionPairs: pairs,
    terminalActiveSuccessors: [...terminalMap.values()].sort((a, b) => a.product.id - b.product.id),
  });
  return { ...payload, contentSha256: hash(stableJson(payload)) };
}

function serializeManifest(manifest) { return `${JSON.stringify(canonical(manifest), null, 2)}\n`; }

module.exports = { buildCorrectionExposureManifest, serializeManifest, storedDiff };
