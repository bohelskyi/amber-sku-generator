// A refusal is not semantic identity proof. This narrow exception covers a
// dictionary entry outside the frozen contract and every authoritative catalog.
// Runtime option resolution still treats the stored decision as blocked.
async function unusedDictionaryRefusal(client, option, definition, plans, evidence) {
  if (option.sourceKind !== 'semantic' || option.reviewState !== 'blocked' || !option.evidence?.note?.trim()) return false;
  const requirement = plans.flatMap((p) => p.attributes).find((a) => a.bindingKey === option.bindingKey);
  if (!requirement || requirement.unsupportedSemanticOutput || !requirement.options.some((o) =>
    o.sourceKey === option.sourceKey && o.evaluatedOutput === option.evaluatedOutput && o.evaluatedOutput)) return false;
  const sources = Object.entries(definition.sources).filter(([, s]) => s.kind === 'semantic'
    && s.category === option.amberGroup && s.key === option.questionKey);
  if (!sources.length || !sources.every(([id, s]) => {
    const contracts = Object.values(definition.questionContracts).filter((q) => q.source === id);
    return s.aliases.length === 0 && contracts.length > 0
      && contracts.every((q) => !q.allowed.includes(option.valueId));
  })) return false;
  const current = evidence.questions.filter((q) => q.category_code === option.amberGroup && q.key === option.questionKey);
  const historical = evidence.schemas.filter((s) => s.category_code === option.amberGroup)
    .flatMap((s) => s.questions.filter((q) => q.key === option.questionKey));
  if (current.length > 1 || [...current, ...historical].some((q) => q.value_ids.includes(option.valueId))) return false;
  // Fresh transaction evidence, not an operator-supplied count. Numeric JSON 8.0
  // and 8 compare equally, just as the evaluator sees both as numeric eight.
  const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM products p
    WHERE p.category=$1 AND p.status='active' AND p.corrected_to_product_id IS NULL
      AND p.details->'answers'->$2::text IN (to_jsonb($3::text), to_jsonb($3::text::numeric))) AS used`,
  [option.amberGroup, option.questionKey, option.valueId]);
  return rows.length === 1 && rows[0].used === false;
}

module.exports = { unusedDictionaryRefusal };
