const c = require('./binding-contract');
const { requirements } = require('./binding-validation');
const { compileDefinition } = require('../export-templates/definition');
const { CONTRACT, REQUIRED } = require('../export-templates/column-contract');

// Explicit authoring only: no persistence, publication, reads or Magento calls.
// Preserve routing and all other cells. The set is checked against its exact
// observed identity; category or SKU alone cannot establish a field's route.
function scopeBaseFieldToProductRoute(definition, schema, input) {
  c.command(input, ['category', 'routeKey', 'setId', 'target', 'publicSku']);
  const fail = () => { throw c.error(422, 'MAGENTO_FIELD_SCOPE_INVALID', 'Exact product, route and observed attribute set required'); };
  const compiled = compileDefinition(definition).definition;
  if (compiled.outputContract !== CONTRACT || REQUIRED.includes(input.target)
    || !Number.isSafeInteger(input.setId) || input.setId <= 0
    || typeof input.publicSku !== 'string' || !input.publicSku.trim() || input.publicSku.trim() !== input.publicSku
    || input.publicSku.length > 256 || /[\u0000-\u001f\u007f]/.test(input.publicSku)) fail();
  const route = requirements(compiled, schema).find(r => r.routeKey === input.routeKey && r.amberGroup === input.category);
  const sets = schema.attributeSets.filter(s => s.attribute_set_name === route?.evaluatorSetName);
  if (!route || sets.length !== 1 || sets[0].attribute_set_id !== input.setId) fail();
  const next = structuredClone(compiled), group = next.groups.find(g => g.route === input.category);
  const base = group?.rows.find(row => row.id === 'base'), english = group?.rows.find(row => row.id === 'english');
  if (!group?.columns.includes(input.target) || !Object.hasOwn(base.cells, input.target)
    || english.cells[input.target]?.op !== 'literal' || english.cells[input.target].value !== '') fail();
  const skuSources = Object.entries(next.sources).filter(([, source]) => source.kind === 'product' && source.field === 'public_sku');
  if (skuSources.length !== 1) fail();
  const literal = value => ({ op: 'literal', value });
  const conditions = [{ op: 'eq', left: { op: 'source', id: skuSources[0][0] }, right: literal(input.publicSku) }];
  for (const predicate of route.predicates) {
    const sources = Object.entries(next.sources).filter(([, source]) => source.kind === 'semantic'
      && source.category === input.category && source.key === predicate.questionKey && !source.aliases.length);
    if (sources.length !== 1) fail();
    const comparison = { op: 'eq', left: { op: 'semanticKey', input: { op: 'source', id: sources[0][0] } },
      right: literal(predicate.valueId) };
    conditions.push(predicate.equal ? comparison : { op: 'not', input: comparison });
  }
  base.cells[input.target] = { op: 'when', if: { op: 'all', items: conditions }, then: base.cells[input.target], else: literal('') };
  return compileDefinition(next).definition;
}

module.exports = { scopeBaseFieldToProductRoute };
