import { useId, useLayoutEffect, useRef, useState } from 'react';
import { assembleConditions, buildConditionPredicate, conditionChain, conditionPredicate } from '../../lib/export-template-conditions';
import { availableSources } from '../../lib/export-template-columns';
import { currentOptionIds, optionDisplayLabel } from '../../lib/export-template-option-labels';
import { SourcePicker } from './SourcePicker';
import { Scalar } from './AdvancedDefinitionEditor';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence';
import { SourceSupportStatus, SourceSupportEvidence } from './SourceSupportStatus';

export function AdvancedRule({ context, children }) {
  return <div className="et-custom-rule"><p>{children || 'Це правило має складні налаштування. Їх збережено без змін.'}</p>
    <button type="button" className="et-link" onClick={context.onAdvanced}>Розширені правила</button></div>;
}

function PredicateEditor({ node, context, onChange, creating, children, showSource }) {
  const initial = conditionPredicate(context.definition, node);
  const [pending, setPending] = useState(null);
  const form = pending || initial || { source: '', operator: 'eq', value: undefined, values: [] };
  const approved = availableSources(context.registry, context.group);
  const choices = Object.entries(context.definition.sources).filter(([, source]) => approved.some((entry) => ['kind', 'category', 'key', 'field'].every((key) => entry.descriptor[key] === source[key]))).map(([id, descriptor]) => ({ id, descriptor }));
  const source = context.definition.sources[form.source];
  const evidence = useSourceEvidence(source, context.loadSource);
  const semantic = source?.kind === 'semantic';
  const ids = [...new Set([...currentOptionIds(evidence), ...(context.registry?.references?.schemas || []).filter((s) => s.category_code === source?.category).flatMap((s) => s.questions.filter((q) => q.key === source?.key).flatMap((q) => q.value_ids || [])).map(String),
    ...(form.values || []), ...(typeof form.value === 'string' ? [form.value] : [])])];
  const update = (patch) => {
    const next = { ...form, ...patch };
    if (!next.source || (next.operator === 'eq' && next.value === undefined) || (next.operator === 'in' && !next.values?.length)) setPending(next);
    else { onChange(buildConditionPredicate(next)); setPending(null); }
  };
  if (!initial && !creating && !pending) return <><AdvancedRule context={context}>Умова використовує складну перевірку. Результат нижче можна редагувати окремо.</AdvancedRule>{children}</>;
  return <div className="et-condition-predicate">
    <SourcePicker registry={context.registry} group={context.group} choices={choices} value={form.source} required disabled={context.readOnly} showDetails={false} onChange={(id) => {
      const semantic = context.definition.sources[id]?.kind === 'semantic';
      const input = { op: 'source', id };
      update({ source: id, input: semantic ? { op: 'semanticKey', input } : input, semantic, value: undefined, values: [] });
    }} />
    <label>Перевірка значення<select className="input" disabled={context.readOnly} value={form.operator} onChange={(e) => update({ operator: e.target.value,
      input: semantic && !form.semantic && ['eq', 'in'].includes(e.target.value) ? { op: 'semanticKey', input: form.input } : form.input,
      semantic: semantic || form.semantic, value: form.value, values: form.values || (form.value !== undefined ? [form.value] : []) })}>
      <option value="eq">дорівнює</option><option value="in">є одним із</option><option value="present">заповнено</option><option value="absent">не заповнено</option>
    </select></label>
    {['eq', 'in'].includes(form.operator) && (semantic ? <label>{form.operator === 'in' ? 'Значення характеристики (можна кілька)' : 'Значення характеристики'}
      <select className="input" required disabled={context.readOnly} multiple={form.operator === 'in'} value={form.operator === 'in' ? (form.values || []).map((value) => JSON.stringify(value)) : form.value === undefined ? '' : JSON.stringify(form.value)} onChange={(e) => update(form.operator === 'in' ? { values: [...e.target.selectedOptions].map((option) => JSON.parse(option.value)) } : { value: JSON.parse(e.target.value) })}>
        {form.operator === 'eq' && <option value="" disabled>Оберіть значення</option>}
        {ids.map((id) => <option key={id} value={JSON.stringify(id)}>{optionDisplayLabel(evidence, id)}</option>)}
      </select></label> : form.operator === 'eq' ? <Scalar value={form.value === undefined ? '' : form.value} label="Значення для порівняння" disabled={context.readOnly} validationError={form.value === undefined ? 'Вкажіть значення для умови.' : ''} onChange={(value) => update({ value })} /> : <div>
      {(form.values || []).map((value, index) => <div key={index}><Scalar value={value} label={`Значення для порівняння ${index + 1}`} disabled={context.readOnly} onChange={(value) => update({ values: form.values.map((old, i) => i === index ? value : old) })} />
        {!context.readOnly && <button type="button" className="et-link" onClick={() => update({ values: form.values.filter((_, i) => i !== index) })}>Вилучити значення {index + 1}</button>}</div>)}
      {!form.values?.length && <input className="input" aria-label="Перше значення для порівняння" required value="" disabled={context.readOnly} onChange={(e) => update({ values: [e.target.value] })} />}
      {!context.readOnly && <button type="button" className="et-link" onClick={() => update({ values: [...form.values || [], ''] })}>Додати значення</button>}
    </div>)}
    {children}
    {showSource && context.openSource !== form.source && <>
      <SourceSupportStatus definition={context.definition} sourceId={form.source} diagnostics={context.diagnostics} showDetails={false} compact={context.focused} exceptionalOnly={context.focused} onDetails={context.onTechnical} />
      {!context.focused && <details><summary>Подробиці джерела</summary><SourceSupportEvidence policy={context.definition.sourceSupport?.sources?.[`${source?.category}.${source?.key}`]} /><pre>{JSON.stringify({ source, evidence }, null, 2)}</pre></details>}
    </>}
    {!context.focused && <details><summary>Технічні подробиці умови</summary><pre>{JSON.stringify(node, null, 2)}</pre><p>Рівність і перелік порівнюють точний тип значення. Перевірка заповнення не вважає нуль порожнім. Перевірки підтримки джерела залишаються чинними.</p></details>}
  </div>;
}

export function ConditionComposer({ node, trail, context, renderValue }) {
  const chain = conditionChain(context.definition, node, trail);
  const [creating, setCreating] = useState(null);
  const [epoch, setEpoch] = useState(0);
  const root = useRef(null);
  const focusAfterEdit = useRef(null);
  const id = useId();
  useLayoutEffect(() => {
    if (focusAfterEdit.current) root.current?.querySelector(focusAfterEdit.current)?.focus();
    focusAfterEdit.current = null;
  }, [epoch]);
  if (!chain) return <AdvancedRule context={context} />;
  const valid = () => [...root.current.querySelectorAll('input,select,textarea')].every((control) => control.reportValidity());
  const structural = (rows, selector, fallback = chain.fallback) => {
    if (!valid()) return false;
    if (context.update(trail, () => assembleConditions(rows, fallback)) === false) return false;
    focusAfterEdit.current = selector; setEpoch((n) => n + 1); return true;
  };
  const sourceIds = chain.rows.map((row) => conditionPredicate(context.definition, row.node.if)?.source);
  return <section ref={root} className="et-conditions" aria-labelledby={id}>
    <h3 id={id}>Коли виконуються умови</h3><p className="et-muted">Зверху вниз: використовується перша відповідна умова. Якщо жодна не підходить — результат «Інакше».</p>
    {chain.rows.map((row, index) => <section key={`${epoch}/${index}`} className="et-condition-row" data-condition={index} aria-label={`Умова ${index + 1}`}>
      <h4>Коли · {index + 1}</h4>
      <PredicateEditor node={row.node.if} context={context} creating={creating === index} showSource={!sourceIds.slice(0, index).includes(sourceIds[index])} onChange={(predicate) => { context.update([...row.trail, 'if'], () => predicate); setCreating(null); }}>
        <div className="et-condition-result"><h4>→ Результат</h4>{renderValue(row.node.then, [...row.trail, 'then'])}</div>
      </PredicateEditor>
      {!context.readOnly && <div className="et-actions">
        <button type="button" className="et-link" disabled={index === 0 || creating !== null} onClick={() => { const rows = [...chain.rows]; [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; structural(rows, `[data-condition="${index - 1}"] select`); }}>Вище</button>
        <button type="button" className="et-link" disabled={index === chain.rows.length - 1 || creating !== null} onClick={() => { const rows = [...chain.rows]; [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]]; structural(rows, `[data-condition="${index + 1}"] select`); }}>Нижче</button>
        <button type="button" className="et-link" disabled={creating !== null && creating !== index} onClick={() => {
          if (creating === index) { context.update(trail, () => assembleConditions(chain.rows.filter((_, i) => i !== index), chain.fallback)); setCreating(null); focusAfterEdit.current = '[data-add-condition]'; setEpoch((n) => n + 1); }
          else structural(chain.rows.filter((_, i) => i !== index), '[data-add-condition]');
        }}>Вилучити умову</button>
      </div>}
    </section>)}
    {!context.readOnly && <button type="button" data-add-condition className="btn btn-outline px-3" disabled={creating !== null} onClick={() => {
      // Start with the explicit fallback, preserving its result type and guards.
      if (structural([...chain.rows, { node: { op: 'when', if: { op: 'literal', value: false }, then: structuredClone(chain.fallback) } }], `[data-condition="${chain.rows.length}"] select`)) setCreating(chain.rows.length);
    }}>Додати умову</button>}
    <section className="et-condition-default" aria-label="Інакше"><h4>Інакше → результат за замовчуванням</h4>{renderValue(chain.fallback, chain.fallbackTrail)}</section>
  </section>;
}
