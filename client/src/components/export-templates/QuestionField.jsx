import { useEffect, useState } from 'react';
import { sourceLabel } from '../../lib/export-template-presentation';
import { SourceDiagnostics } from './SourceDiagnostics';
import { getApiError } from '../../lib/http-error';
import { SourceSupportStatus, SourceSupportEvidence } from './SourceSupportStatus';

function ruleText(rule, definition, registry) {
  return Object.entries(rule || {}).map(([key, value]) => key === '$and' || key === '$or'
    ? Array.isArray(value) ? '(' + value.map((r) => ruleText(r, definition, registry)).join(key === '$and' ? ' та ' : ' або ') + ')' : 'Некоректна умова — розширені правила'
    : `${sourceLabel(definition, key, registry)}: ${JSON.stringify(value)}`).join(' та ') || 'Завжди';
}
function expressionText(node, definition, registry) {
  if (!node) return 'збережене правило';
  if (node.op === 'literal') return node.value === '' ? 'порожня клітинка' : JSON.stringify(node.value);
  if (node.op === 'source') return sourceLabel(definition, node.id, registry);
  if (node.op === 'semanticKey') return expressionText(node.input, definition, registry);
  if (node.op === 'present') return `${expressionText(node.input, definition, registry)} має збережене значення`;
  if (node.op === 'in' && Array.isArray(node.values)) return `${expressionText(node.input, definition, registry)} входить до ID ${node.values.join(', ')}`;
  if (node.op === 'error') return 'помилка готовності';
  return 'зафіксоване правило (подробиці у джерелі)';
}
export function QuestionField({ lens, context, mappingComponent, loadSource, diagnostics }) {
  const Mapping = mappingComponent;
  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState(null);
  const source = context.definition.sources[lens.sourceId];
  useEffect(() => {
    if (!loadSource) return;
    const controller = new AbortController(); let active = true;
    Promise.resolve(loadSource({ category: source.category, key: source.key }, controller.signal))
      .then((r) => { if (active) setEvidence(r.data); })
      .catch((e) => { if (active) setError(e); });
    return () => { active = false; controller.abort(); };
  }, [loadSource, source.category, source.key]);
  const ownDiagnostics = diagnostics.filter((d) => d.sourceId === lens.sourceId);
  const frozen = lens.contract;
  return <section aria-label="Відповідності характеристики" className="et-question">
    <p><strong>Характеристика товару:</strong> {sourceLabel(context.definition, lens.sourceId, context.registry)}</p>
    {!frozen.exists && <p>У шаблоні зафіксовано відсутність питання: застосовується збережена діагностика.</p>}
    <Mapping node={lens.lookup} trail={lens.trail} context={{ ...context, question: lens, sourceEvidence: evidence }} />
    <SourceSupportStatus definition={context.definition} sourceId={lens.sourceId} diagnostics={diagnostics} showDetails={false} />
    <details className="et-source-panel"><summary>Подробиці джерела</summary>
      <SourceSupportEvidence policy={context.definition.sourceSupport?.sources?.[`${source.category}.${source.key}`]} />
      <p>{Object.keys(frozen.rule || {}).length ? 'Заповнення залежить від інших характеристик товару.' : 'Заповнюється зі збереженої відповіді товару.'} Приховане питання дає порожню клітинку.</p>
      <p>{frozen.required ? 'Відсутня відповідь: помилка готовності.' : 'Відсутня відповідь: порожня клітинка.'} Нуль — окреме збережене значення, не відсутня відповідь.</p>
      {lens.guards.length > 0 && <p>Застосовуються додаткові перевірки готовності товару. Редагування тексту їх не скасовує.</p>}
      <p>Коли заповнюється: {ruleText(frozen.rule, context.definition, context.registry)}.</p>
      {lens.guards.map((guard, i) => <p key={i}>Додаткова умова: {expressionText(guard.if, context.definition, context.registry)}. Інакше: {expressionText(guard.else || guard.error, context.definition, context.registry)}.</p>)}
      <p>Перевірки допустимих ID і готовності залишаються чинними. Порожній текст може бути відхилений додатковою перевіркою готовності.</p>
      <SourceDiagnostics diagnostics={ownDiagnostics} definition={context.definition} registry={context.registry} />
      <p>Збережена характеристика: <code>details.answers.{source.key}</code>. Відповіді товарів тут не редагуються.</p>
      {error ? <p role="alert">Не вдалося прочитати джерело: {getApiError(error)}</p> : !evidence ? <p>Метадані джерела ще не завантажено.</p> : <>
        <h3>Поточний каталог</h3>
        {!evidence.current.length && <p>Поточного питання немає.</p>}
        {evidence.current.map((q, i) => <p key={i}>{q.label} · {Number(q.include_in_sku) ? 'SKU-питання; поточні опції не є історичним доказом' : 'Інформаційне питання'}. ID: {q.options.map((o) => o.value_id).join(', ') || 'немає'}.</p>)}
        <h3>Історичні SKU-схеми</h3>
        {!evidence.historical.length && <p>У доступному історичному свідченні питання відсутнє.</p>}
        {evidence.historical.map((q, i) => <p key={i}>Версія {q.version} · {q.status} · {q.label}. ID: {q.options.map((o) => o.value_id).join(', ') || 'немає'}.</p>)}
        {evidence.truncated && <p>Показано обмежений набір метаданих. Відсутність ID у цьому поданні не доводить відсутності історичного свідчення.</p>}
        <pre>{JSON.stringify(evidence, null, 2)}</pre>
      </>}
      <h3>Зафіксовані правила шаблону</h3>
      <p>Допустимі ID: {frozen.allowed.join(', ') || 'немає'}. Ці правила не оновлюються з каталогу автоматично.</p>
      <details><summary>Контракт, умови й діагностики — лише читання</summary><pre>{JSON.stringify({ contract: frozen, guards: lens.guards, missingQuestion: lens.question.missingQuestion, missingAnswer: lens.question.missingAnswer, unmapped: lens.lookup.otherwise }, null, 2)}</pre></details>
      <p>Текст у файлі нижче — окремі відповідності шаблону. Вони не підтверджують історичне значення ID.</p>
    </details>
  </section>;
}
