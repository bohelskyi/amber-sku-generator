const { getCompiledSourceDependencies } = require('./definition');
const { validateSourceReferences } = require('./source-references');

const sourceRequirements = new Set(['category', 'unique_current_question', 'current_non_sku_question',
  'historical_sku_or_current_non_sku_question', 'historical_sku_or_current_non_sku_value_ids',
  'captured_question', 'alias_ownership', 'alias_lineage']);

// Only the read-only draft sample service calls this. All other callers keep
// validateSourceReferences' complete strict result; there is no relaxation flag.
function validateDraftSampleSources(compiled, evidence, products) {
  const groups = [...new Set(products.map((product) => product.category))];
  const sources = new Set(getCompiledSourceDependencies(compiled, groups));
  const definition = compiled.definition;
  const diagnostics = [];
  const globalSourceDiagnostics = [];
  for (const diagnostic of validateSourceReferences(definition, evidence)) {
    let required = true; // Unclassifiable evidence must block, never disappear.
    if (diagnostic.requirement === 'category' && diagnostic.category === diagnostic.sourceId
      && definition.groups.some((group) => group.route === diagnostic.sourceId)) {
      required = groups.includes(diagnostic.sourceId) || sources.has(diagnostic.sourceId);
    } else if (sourceRequirements.has(diagnostic.requirement) && Object.hasOwn(definition.sources, diagnostic.sourceId)) {
      required = sources.has(diagnostic.sourceId);
    }
    (required ? diagnostics : globalSourceDiagnostics).push(diagnostic);
  }
  return { diagnostics, globalSourceDiagnostics };
}

module.exports = { validateDraftSampleSources };
