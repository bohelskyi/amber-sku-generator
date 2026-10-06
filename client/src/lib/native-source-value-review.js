import { mappingsForSource } from './export-template-presentation.js';
import { fieldsForSource } from './export-template-attributes.js';
import { consumers } from './export-template-editor.js';

export function nativeDeferredReview(definition, sourceId, evidence) {
  const source = definition.sources?.[sourceId];
  const key = source && `${source.category}.${source.key}`;
  const policy = definition.sourceSupport?.sources?.[key];
  if (definition.evaluatorVersion !== 'magento-declarative-5'
    || definition.sourceContractVersion !== 'public-product-characteristics-v1'
    || source?.kind !== 'semantic' || key !== 'AR.size' || !policy?.deferredValues?.length) return null;
  const question = evidence?.current?.length === 1 && !evidence.truncated ? evidence.current[0] : null;
  const live = question?.archived === false && question.input_type === 'options';
  const sourceIds = Object.entries(definition.sources).filter(([, s]) => s.kind === 'semantic'
    && `${s.category}.${s.key}` === key).map(([id]) => id);
  const tableIds = [...new Set(sourceIds.flatMap((id) => mappingsForSource(definition, id)))];
  const fields = [...new Map(sourceIds.flatMap((id) => fieldsForSource(definition, id, true))
    .map((field) => [`${field.groupIndex}:${field.rowIndex}:${field.column}`, field])).values()];
  return { key, sourceId, sourceIds, tableIds, fields,
    uses: [...new Set(tableIds.flatMap((id) => consumers(definition, 'table', id)))],
    values: policy.deferredValues.map((valueId) => {
      const options = live ? (question.options || []).filter((o) => String(o.value_id) === valueId && o.archived === false) : [];
      const labels = new Set(options.map((o) => o.label));
      const contracts = Object.values(definition.questionContracts || {}).filter((q) => sourceIds.includes(q.source));
      const valid = options.length === 1 && labels.size === 1 && typeof options[0].label === 'string'
        && options[0].label.trim() && sourceIds.every((id) => contracts.some((q) => q.source === id))
        && contracts.every((q) => q.exists === true && q.allowed.includes(valueId));
      return { valueId, label: valid ? options[0].label : `Значення №${valueId}`, available: Boolean(valid) };
    }) };
}

export function promoteNativeDeferredValue(definition, sourceId, valueId, evidence, outputs, acknowledgements) {
  const review = nativeDeferredReview(definition, sourceId, evidence);
  const value = review?.values.find((v) => v.valueId === valueId && v.available);
  if (!value || !review.tableIds.length || acknowledgements?.exactSemanticValue !== true
    || acknowledgements?.allUsesReviewed !== true) throw new Error('Перевірте точне значення та всі його використання.');
  if (!outputs || Object.keys(outputs).length !== review.tableIds.length
    || Object.keys(outputs).some((id) => !review.tableIds.includes(id))) throw new Error('Потрібні всі відповідності цього значення.');
  for (const id of review.tableIds) {
    const text = outputs[id];
    if (typeof text !== 'string' || !text.trim() || text !== text.trim() || text.length > 4096
      || [...text].some((c) => c.charCodeAt(0) < 32)) throw new Error('Вкажіть непорожній текст для кожної відповідності без крайніх пробілів.');
  }
  const next = structuredClone(definition);
  const policy = next.sourceSupport.sources[review.key];
  policy.deferredValues = policy.deferredValues.filter((id) => id !== valueId);
  if (!policy.semanticValues.includes(valueId)) policy.semanticValues.push(valueId);
  for (const id of review.tableIds) next.tables[id][valueId] = outputs[id];
  return next;
}
