const { nullableNumber } = require('./historical-normalization');

function addGraphEdge(edgeMap, sourceId, correctedId, evidence, correctionId = null) {
  if (!sourceId || !correctedId) return;
  const key = `${sourceId}:${correctedId}`;
  if (!edgeMap.has(key)) {
    edgeMap.set(key, {
      sourceId: Number(sourceId),
      correctedId: Number(correctedId),
      correctionId: correctionId === null ? null : Number(correctionId),
      evidence: new Set(),
    });
  }
  const edge = edgeMap.get(key);
  edge.evidence.add(evidence);
  if (edge.correctionId === null && correctionId !== null) edge.correctionId = Number(correctionId);
}

function analyzeLineage(products, corrections) {
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const productsBySku = new Map();
  for (const product of products) {
    if (!productsBySku.has(product.full_sku)) productsBySku.set(product.full_sku, []);
    productsBySku.get(product.full_sku).push(product);
  }
  const uniqueProductIdForSku = (sku) => {
    const matches = productsBySku.get(sku) || [];
    return matches.length === 1 ? Number(matches[0].id) : null;
  };
  const edgeMap = new Map();
  const warnings = [];
  for (const correction of corrections) {
    const sourceId = nullableNumber(correction.source_product_id)
      || uniqueProductIdForSku(correction.source_sku);
    const correctedId = nullableNumber(correction.corrected_product_id)
      || uniqueProductIdForSku(correction.corrected_sku);
    addGraphEdge(edgeMap, sourceId, correctedId, 'product_corrections', correction.id);
    const source = productById.get(sourceId);
    const corrected = productById.get(correctedId);
    if (source && correction.source_sku && source.full_sku !== correction.source_sku) {
      warnings.push({ code: 'CORRECTION_SOURCE_SKU_MISMATCH', message: 'SKU джерела у виправленні не збігається з товаром.' });
    }
    if (corrected && correction.corrected_sku && corrected.full_sku !== correction.corrected_sku) {
      warnings.push({ code: 'CORRECTION_TARGET_SKU_MISMATCH', message: 'Новий SKU у виправленні не збігається з товаром.' });
    }
  }
  for (const product of products) {
    addGraphEdge(edgeMap, product.id, product.corrected_to_product_id, 'products_links');
    addGraphEdge(edgeMap, product.corrected_from_product_id, product.id, 'products_links');
  }

  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of edgeMap.values()) {
    if (!productById.has(edge.sourceId) || !productById.has(edge.correctedId)) continue;
    if (!incoming.has(edge.correctedId)) incoming.set(edge.correctedId, []);
    if (!outgoing.has(edge.sourceId)) outgoing.set(edge.sourceId, []);
    incoming.get(edge.correctedId).push(edge);
    outgoing.get(edge.sourceId).push(edge);
    if (!edge.evidence.has('product_corrections')) {
      warnings.push({ code: 'MISSING_CORRECTION_HISTORY', message: 'Посилання між товарами не має відповідного запису історії виправлення.' });
    }
    if (!edge.evidence.has('products_links')) {
      warnings.push({ code: 'MISSING_PRODUCT_LINK', message: 'Запис історії виправлення має неповні посилання між товарами.' });
    }
  }
  if ([...incoming.values()].some((edges) => edges.length > 1)) {
    warnings.push({ code: 'MULTIPLE_PREDECESSORS', message: 'Збережений ланцюжок має кілька попередників одного товару.' });
  }
  if ([...outgoing.values()].some((edges) => edges.length > 1)) {
    warnings.push({ code: 'MULTIPLE_SUCCESSORS', message: 'Збережений ланцюжок має кілька наступників одного товару.' });
  }

  const roots = products.filter((product) => !(incoming.get(Number(product.id)) || []).length);
  const endpoints = products.filter((product) => !(outgoing.get(Number(product.id)) || []).length);
  if (roots.length !== 1) warnings.push({ code: 'NON_LINEAR_ROOTS', message: 'Збережений ланцюжок не має одного однозначного початку.' });
  if (endpoints.length !== 1) warnings.push({ code: 'NON_LINEAR_ENDPOINTS', message: 'Збережений ланцюжок не має одного однозначного кінцевого товару.' });

  const uniqueWarnings = [...new Map(warnings.map((warning) => [warning.code, warning])).values()];
  let ordered = [];
  if (uniqueWarnings.length === 0 && roots.length === 1) {
    const visited = new Set();
    let current = roots[0];
    while (current && !visited.has(Number(current.id))) {
      ordered.push(current);
      visited.add(Number(current.id));
      const nextEdge = (outgoing.get(Number(current.id)) || [])[0];
      current = nextEdge ? productById.get(nextEdge.correctedId) : null;
    }
    if (ordered.length !== products.length) {
      uniqueWarnings.push({ code: 'LINEAGE_CYCLE', message: 'Збережений ланцюжок містить цикл або відокремлені свідчення.' });
    }
  }
  if (ordered.length !== products.length) {
    ordered = [...products].sort((first, second) => (
      new Date(first.created_at || 0).getTime() - new Date(second.created_at || 0).getTime()
      || Number(first.id) - Number(second.id)
    ));
  }

  return {
    edgeMap,
    ordered,
    roots,
    endpoints,
    warnings: uniqueWarnings,
  };
}

module.exports = {
  analyzeLineage,
};
