// Authoring metadata only. Never used to evaluate a product or authorize a source.
export function currentOptionLabel(evidence, id) {
  if (evidence?.current?.length !== 1) return null;
  const options = (evidence.current[0].options || []).filter((option) => String(option.value_id) === String(id));
  if (!options.length || options.some((option) => typeof option.label !== 'string' || !option.label.trim())) return null;
  const labels = new Set(options.map((option) => option.label));
  return labels.size === 1 ? options[0].label : null;
}

export function optionDisplayLabel(evidence, id) {
  return currentOptionLabel(evidence, id) ?? `Значення №${id} — назву не підтверджено`;
}

export function currentOptionIds(evidence) {
  return [...new Set((evidence?.current || []).flatMap((question) => (question.options || []).map((option) => String(option.value_id))))];
}

// Copy on an explicit operator action, preserving outputs without a current label.
// In particular, an unavailable label must never create an empty-string mapping.
export function copyCurrentOptionLabels(evidence, entries = {}) {
  return Object.fromEntries([
    ...Object.entries(entries),
    ...currentOptionIds(evidence).filter((id) => !['__proto__', 'constructor', 'prototype'].includes(id))
      .flatMap((id) => { const label = currentOptionLabel(evidence, id); return label === null ? [] : [[id, label]]; }),
  ]);
}
