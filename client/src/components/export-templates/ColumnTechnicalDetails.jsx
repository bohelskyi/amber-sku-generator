import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence';
import { sourceLabel } from '../../lib/export-template-presentation';
import { ruleSources } from '../../lib/export-template-intent';
import { SourceSupportEvidence } from './SourceSupportStatus';

function SourceDetails({ definition, id, registry, loadSource, diagnostics }) {
  const source = definition.sources[id];
  const evidence = useSourceEvidence(source, loadSource);
  if (!source) return null;
  const contracts = Object.fromEntries(Object.entries(definition.questionContracts || {}).filter(([, contract]) => contract.source === id));
  return <section className="et-technical-source">
    <h3>{sourceLabel(definition, id, registry)} · {id}</h3>
    <SourceSupportEvidence policy={definition.sourceSupport?.sources?.[`${source.category}.${source.key}`]} />
    <pre>{JSON.stringify({ source, contracts, evidence, registry: {
      current: registry?.references?.questions?.filter((q) => q.category_code === source.category && q.key === source.key),
      historical: registry?.references?.schemas?.filter((s) => s.category_code === source.category).map((s) => ({ ...s, questions: s.questions.filter((q) => q.key === source.key) })),
    }, diagnostics: diagnostics.filter((d) => d.sourceId === id) }, null, 2)}</pre>
  </section>;
}

export function ColumnTechnicalDetails({ definition, expression, registry, loadSource, diagnostics = [], sourceId }) {
  const sources = [...new Set([...ruleSources(definition, expression), ...sourceId ? [sourceId] : []])];
  return <section aria-label="Технічні дані колонки">
    <h3>Збережене правило</h3><pre>{JSON.stringify(expression, null, 2)}</pre>
    {sources.map((id) => <SourceDetails key={id} definition={definition} id={id} registry={registry} loadSource={loadSource} diagnostics={diagnostics} />)}
  </section>;
}
