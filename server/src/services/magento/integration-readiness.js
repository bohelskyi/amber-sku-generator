const c = require('./binding-contract');

// Request-scoped bounds. This wrapper cannot be reused by a writer.
function boundedGet(fetchImpl = globalThis.fetch, { maxRequests = 512, timeoutMs = 60000 } = {}) {
  let count = 0; const deadline = Date.now() + timeoutMs;
  return async (url, options = {}) => {
    if (options.method !== 'GET') throw c.error(422, 'MAGENTO_DISCOVERY_GET_ONLY', 'Only bounded GET discovery is allowed');
    if (++count > maxRequests || Date.now() >= deadline) throw c.error(422, 'MAGENTO_DISCOVERY_LIMIT', 'Discovery limit reached; no complete observation available');
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    return fetchImpl(url, { ...options, signal });
  };
}
function semanticReadiness(config, schemas, revision, definition = null) {
  const validation = definition && revision ? require('./binding-validation').validateBindings(revision.bindings, definition, revision.schema) : null;
  return Object.entries(config.categories).map(([code, category]) => {
    const routes = revision?.bindings.routes.filter((r) => r.routeKey.split(/[.:]/)[0] === code) || [];
    const values = (config.questions[code] || []).flatMap((q) => q.options.filter((v) => !v.archived).map((v) => {
      const decisions = revision?.bindings.options.filter((o) => o.sourceKind === 'semantic'
        && o.amberGroup === code && o.questionKey === q.id && o.valueId === String(v.id)) || [];
      const mappings = decisions.map((o) => {
        const a = revision.bindings.attributes.find((a) => a.bindingKey === o.bindingKey);
        const route = routes.find((r) => r.routeKey === a?.routeKey);
        const attribute = revision.schema.attributes.find((a2) => a2.attribute_code === a?.attributeCode);
        const set = revision.schema.attributeSets.find((s) => s.attribute_set_id === route?.setId);
        const remote = attribute?.options.find((opt) => opt.value === o.optionId);
        const state = o.reviewState === 'blocked' || a?.reviewState === 'blocked' || route?.reviewState === 'blocked'
          || (attribute && set && !set.attributeCodes.includes(attribute.attribute_code)) ? 'blocked'
          : !attribute || (o.optionId !== null && !remote) ? 'drifted'
            : o.reviewState === 'approved' && a?.reviewState === 'approved' && route?.enabled
              && route.reviewState === 'approved' && remote ? 'approved'
              : remote ? 'candidate' : 'missing';
        return { routeKey: a?.routeKey ?? null, attribute: a?.attributeCode ?? null, optionId: o.optionId,
          optionLabel: remote?.label ?? null, state };
      });
      const applicable = !definition || Object.values(definition.sources).some((s) => s.category === code && s.key === q.id && s.kind === 'semantic');
      const state = !applicable ? 'not_applicable' : !mappings.length ? 'missing' : mappings.every((m) => m.state === 'approved') ? 'approved'
        : mappings.some((m) => m.state === 'blocked') ? 'blocked' : mappings.some((m) => m.state === 'drifted') ? 'drifted'
          : mappings.some((m) => m.state === 'missing') ? 'missing' : 'candidate';
      return { questionKey: q.id, questionLabel: q.label, valueId: String(v.id), label: v.label, labelEn: v.label_en ?? null,
        skuCode: v.sku_code, state, optionId: mappings.length === 1 ? mappings[0].optionId : null, mappings };
    }));
    // This is structural evidence, never a claim of remote product sendability.
    const schema = schemas.find((s) => s.category_code === code) || null;
    const ready = !!schema && !!routes.length && routes.every((r) => r.enabled && r.reviewState === 'approved')
      && values.every((v) => ['approved', 'not_applicable'].includes(v.state))
      && (!validation || !validation.diagnostics.some((d) => !d.routeKey || routes.some((r) => r.routeKey === d.routeKey)));
    return { code, name: category.name, schema, routes, values, ready,
      diagnostics: validation?.diagnostics.filter((d) => !d.routeKey || routes.some((r) => r.routeKey === d.routeKey)) || [],
      message: ready ? 'Структурні відповідності підтверджено' : 'Категорія ще не готова до Magento' };
  });
}
function previewView(report) {
  return { mode: report.mode, observedAt: report.generatedAt, sendable: report.sendable,
    article: report.amberProduct.publicSku, group: report.amberProduct.group, routeKey: report.attributeSet.routeKey,
    attributeSet: report.attributeSet.selected, blockers: report.blockers.map((b) => require('./sync-problems').presentProblem(b)),
    names: { ua: report.candidatePayload.product.name ?? null,
      en: report.transport?.storeViews?.candidate?.name ?? null },
    attributes: report.attributes.map((a) => ({ target: a.target, diagnostics: a.diagnostics })),
    categories: report.categories, warnings: report.warnings };
}
module.exports = { semanticReadiness, boundedGet, previewView };
