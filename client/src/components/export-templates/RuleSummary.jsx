import { resolveNode, sourceLabel, sourceOf } from '../../lib/export-template-presentation';
import { computedPresence, conditionChain, conditionPredicate } from '../../lib/export-template-conditions';
import { optionDisplayLabel } from '../../lib/export-template-option-labels';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence';

function resultText(definition, expression, registry, depth = 0) {
  if (depth > 20) return 'Складне правило';
  const { node } = resolveNode(definition, expression);
  if (!node) return 'Порожня клітинка; інший рядок не підставляється.';
  if (node.op === 'literal') return node.value === '' ? 'Порожній текст' : node.value === null ? 'Відсутнє значення (null)' : String(node.value);
  if (node.op === 'interpolate' && typeof node.template === 'string') return node.template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, id) => {
    const source = sourceOf(definition, node.slots?.[id]); return `{${source ? sourceLabel(definition, source, registry) : 'Характеристика'}}`;
  });
  if (['require', 'questionValue'].includes(node.op)) return resultText(definition, node.value, registry, depth + 1);
  if (node.op === 'when') return 'Залежить від умов';
  const id = sourceOf(definition, node.op === 'lookup' ? node.input : node);
  if (id) return `${sourceLabel(definition, id, registry)}${node.op === 'lookup' ? ' → значення, збережені в шаблоні' : ' → значення товару'}`;
  if (node.op === 'firstPresent') return 'Перше заповнене значення за вказаним порядком';
  return 'Збережене складне правило';
}

function ConditionSummary({ definition, row, registry, loadSource }) {
  const predicate = conditionPredicate(definition, row.node.if);
  const source = definition.sources[predicate?.source];
  const evidence = useSourceEvidence(source, loadSource);
  const value = (v) => source?.kind === 'semantic' ? optionDisplayLabel(evidence, v) : v === null ? 'null' : String(v);
  const operators = { eq: 'дорівнює', in: 'є одним із', present: 'заповнено', absent: 'не заповнено' };
  return <li>{predicate ? `${sourceLabel(definition, predicate.source, registry)} ${operators[predicate.operator]} ${predicate.operator === 'eq' ? value(predicate.value) : predicate.operator === 'in' ? predicate.values.map(value).join(', ') : ''}` : 'Складна перевірка'} → {resultText(definition, row.node.then, registry)}</li>;
}

export function RuleSummary({ definition, expression, registry, loadSource, value }) {
  let { node } = resolveNode(definition, expression);
  if (node?.op === 'when' && computedPresence(definition, node.if)) node = resolveNode(definition, node.then).node;
  const chain = conditionChain(definition, node);
  return <section className="et-rule-summary" aria-label="Короткий підсумок"><h3>Короткий підсумок</h3>
    {value ? <p>{value.mode === 'literal' ? value.text === '' ? 'Порожній текст' : value.text : `${sourceLabel(definition, value.source, registry)} → ${value.output === 'mapping' ? 'значення, збережені в шаблоні' : value.output === 'raw' ? 'збережене значення товару' : 'оберіть спосіб запису'}`}</p>
      : chain ? <ul>{chain.rows.map((row, i) => <ConditionSummary key={i} definition={definition} row={row} registry={registry} loadSource={loadSource} />)}<li>Інакше → {resultText(definition, chain.fallback, registry)}</li></ul>
        : <p>{resultText(definition, expression, registry)}</p>}
  </section>;
}
