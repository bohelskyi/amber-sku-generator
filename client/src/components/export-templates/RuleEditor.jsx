import { useId, useLayoutEffect, useRef, useState } from 'react';
import { questionField, editQuestionMapping } from '../../lib/export-template-attributes';
import { QuestionField } from './QuestionField';
import { SourceDiagnostics } from './SourceDiagnostics';
import { Scalar } from './AdvancedDefinitionEditor';
import { fieldLabels, moveItem, protectedCells, renameSlot, removeSlot, slotNameError } from '../../lib/export-template-editor';
import { at, affectedFields, editField, editMapping, insertCharacteristic, mappingsForSource, resolveNode, sourceLabel, sourceOf, summary } from '../../lib/export-template-presentation';
import { availableSources } from '../../lib/export-template-columns';
import { SourcePicker } from './SourcePicker';
import { MappingTableEditor } from './MappingTableEditor';
import { SourceSupportStatus, SourceSupportEvidence } from './SourceSupportStatus';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence';
import { OptionNamesCopy, frozenNamesHelp } from './OptionNamesCopy';
import { copyCurrentOptionLabels } from '../../lib/export-template-option-labels';
import { ConditionComposer, AdvancedRule } from './ConditionComposer';
import { computedPresence, exactExpression } from '../../lib/export-template-conditions';
import { expressionIntent } from '../../lib/export-template-intent';
import './export-template-editor.css';

const label = (key) => fieldLabels[key] || key;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const groupNames = { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' };

function Scope({ context, trail, table }) {
  if (context.readOnly || context.suppressScope || context.focused) return null;
  if (context.localOnly) return <p className="et-muted">Редагування тексту відокремить відповідності лише для цієї колонки. Інші споживачі залишаться без змін.</p>;
  const affected = affectedFields(context.definition, context.cellPath, trail, table);
  const readable = context.question ? affected.map((value) => {
    const [group, row, column] = value.split(' / ');
    return `${groupNames[group] || group} — ${column ? label(column) + (row === 'EN' ? ' (EN)' : '') : row}`;
  }) : affected;
  return <div className="et-scope"><p>Де застосувати зміни: {context.scope === 'local' ? 'Лише ця колонка' : 'Усі колонки зі спільним правилом'}</p><details><summary>Змінити також інші колонки</summary>
    <label>Де застосувати зміни<select className="input" value={context.scope} onChange={(e) => context.setScope(e.target.value)}>
      <option value="local">Лише для цього поля</option><option value="shared">Для всіх полів, які використовують це правило</option>
    </select></label>
    {context.scope === 'shared' ? <p role="note">Зміна вплине на: {readable.join('; ')}.</p>
      : <p>Зміниться лише це поле{context.question ? ' та пов’язана перевірка його готовності' : ''}. Потрібні правила й відповідності копіюються під час редагування.</p>}
  </details></div>;
}

function CharacteristicPicker({ node, onInsert, context }) {
  const [source, setSource] = useState('');
  const [table, setTable] = useState(null);
  const approved = availableSources(context.registry, context.group);
  const sources = Object.entries(context.definition.sources).filter(([, value]) => value.type !== 'boolean' && approved.some((entry) => entry.descriptor.kind === value.kind && entry.descriptor.category === value.category && entry.descriptor.key === value.key && entry.descriptor.field === value.field)).map(([id, descriptor]) => ({ id, descriptor }));
  const mappings = mappingsForSource(context.definition, source);
  const semantic = context.definition.sources[source]?.kind === 'semantic';
  return <div className="et-source-picker">
    <SourcePicker registry={context.registry} group={context.group} choices={sources} value={source} showDetails={!context.focused} onChange={(id) => { setSource(id); setTable(context.definition.sources[id]?.kind === 'semantic' ? null : ''); }} />
    <label>Як записувати значення<select className="input" value={table ?? '__choose'} onChange={(e) => setTable(e.target.value === '__choose' ? null : e.target.value)}>
      <option value="__choose">Оберіть значення для файлу</option>{!semantic && <option value="">Використати значення як є</option>}{mappings.map((id) => <option key={id} value={id}>Значення шаблону: {Object.values(context.definition.tables[id]).slice(0, 3).join(' / ')}</option>)}
    </select></label>
    {semantic && <><p>Після вставлення натисніть характеристику в тексті, щоб змінити її значення або скопіювати поточні назви.</p>
      {!context.focused && <details><summary>Технічні налаштування</summary><p>Спеціальний режим для інтеграцій. Для звичайних полів Magento зазвичай використовуються назви або власні відповідності.</p>
        <button type="button" className="btn btn-outline px-3" aria-pressed={table === ''} onClick={() => setTable('')}>Внутрішній ID варіанта</button>
      </details>}{table === '' && <p>Налаштовано технічний вивід внутрішнього ID.</p>}</>}
    <button type="button" className="btn btn-primary px-3" disabled={!source || table === null || Object.keys(node.slots).length >= 16} onClick={() => onInsert(source, table)}>Вставити характеристику</button>
    {Object.keys(node.slots).length >= 16 && <p>Досягнуто межу: 16 характеристик.</p>}
  </div>;
}

function TextComposer({ node: original, trail, context }) {
  const literal = original.op === 'literal';
  const node = literal ? { op: 'interpolate', template: original.value, slots: {} } : original;
  const helpId = useId();
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [renamed, setRenamed] = useState('');
  const input = useRef(null);
  const selection = useRef(null);
  const names = {};
  for (const [slot, value] of Object.entries(node.slots)) {
    const source = sourceOf(context.definition, value);
    const sourceName = source && sourceLabel(context.definition, source, context.registry);
    const base = (sourceName && sourceName !== context.definition.sources[source]?.key ? sourceName : fieldLabels[slot] || sourceName || 'Характеристика').replaceAll('{', '(').replaceAll('}', ')');
    let name = base; let index = 2;
    while (Object.values(names).includes(name)) name = base + ' ' + index++;
    names[slot] = name;
  }
  const display = (text) => text.replace(/\{([A-Za-z0-9_]+)\}/g, (token, slot) => names[slot] ? `{${names[slot]}}` : token);
  const stored = (text) => text.replace(/\{([^{}]+)\}/g, (token, name) => { const slot = Object.keys(names).find((key) => names[key] === name); return slot ? `{${slot}}` : token; });
  const used = [...node.template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  const invalid = !literal && (used.some((slot) => !Object.hasOwn(node.slots, slot)) || Object.keys(node.slots).some((slot) => !used.includes(slot)) || /[{}]/.test(node.template.replace(/\{[A-Za-z0-9_]+\}/g, '')));
  const update = (transform) => context.update(trail, (value) => {
    const next = transform(value.op === 'literal' ? { op: 'interpolate', template: value.value, slots: {} } : value);
    return value.op === 'literal' && !Object.keys(next.slots).length ? { ...value, value: next.template } : next;
  });
  return <div className="et-composer">
    <Scope context={context} trail={trail} />
    <label>Текст у файлі<textarea ref={(element) => { input.current = element; element?.setCustomValidity(invalid ? 'Перевірте характеристики у фігурних дужках.' : ''); }} className="input et-text" rows={3} disabled={context.readOnly}
      value={display(node.template)} aria-invalid={invalid} aria-describedby={helpId} onSelect={(e) => { selection.current = [stored(e.target.value.slice(0, e.target.selectionStart)).length, stored(e.target.value.slice(0, e.target.selectionEnd)).length]; }}
      onChange={(e) => update((value) => ({ ...value, template: stored(e.target.value) }))} /></label>
    <p id={helpId} className="et-muted">Текст і розділові знаки зберігаються точно. Додавайте характеристики кнопкою нижче; їхні позначки у {'{дужках}'} буде замінено значеннями товару.</p>
    {invalid && <p role="alert">Використайте всі додані характеристики, без невідомих назв чи незакритих дужок. Для вилучення скористайтеся кнопкою характеристики.</p>}
    <div className="et-tokens" aria-label="Характеристики в тексті">{Object.keys(node.slots).map((slot) => <button key={slot} type="button" className="et-token" aria-pressed={selected === slot} onClick={() => { setSelected(selected === slot ? '' : slot); setRenamed(slot); setAdding(false); }}>
      {names[slot]}<span>{`{${names[slot]}}`}</span>
    </button>)}
      {!context.readOnly && <button type="button" className="btn btn-outline px-3" onClick={() => { setAdding(!adding); setSelected(''); }}>+ Додати характеристику</button>}
    </div>
    {adding && <CharacteristicPicker node={node} context={context} onInsert={(source, table) => {
      update((value) => insertCharacteristic(value, source, table, selection.current)); setAdding(false); input.current?.focus();
    }} />}
    {selected && Object.hasOwn(node.slots, selected) && <section className="et-slot" aria-label="Налаштування характеристики">
      <div className="et-row"><h3>{context.focused ? names[selected] : label(selected)}</h3><button type="button" className="et-link" onClick={() => setSelected('')}>Закрити</button></div>
      <TaskValue node={node.slots[selected]} trail={[...trail, 'slots', selected]} context={{ ...context, suppressScope: false }} />
      {context.focused && !context.readOnly && <button type="button" className="et-link" onClick={() => { update((value) => removeSlot({ ...value, template: value.template.split(`{${selected}}`).join('') }, selected)); setSelected(''); }}>Вилучити характеристику та її позначки з тексту</button>}
      {!context.focused && !context.readOnly && <details className="et-secondary"><summary>Назва та вилучення характеристики</summary>
        <label>Назва підстановки<input className="input" value={renamed} onChange={(e) => setRenamed(e.target.value)} /></label>
        <button type="button" className="et-link" disabled={Boolean(slotNameError(renamed, node.slots, selected)) || renamed === selected} onClick={() => { update((value) => renameSlot(value, selected, renamed)); setSelected(renamed); }}>Перейменувати й оновити текст</button>
        <button type="button" className="et-link" onClick={() => { update((value) => removeSlot({ ...value, template: value.template.split(`{${selected}}`).join('') }, selected)); setSelected(''); }}>Вилучити характеристику та її позначки з тексту</button>
        {renamed && slotNameError(renamed, node.slots, selected) && <p role="alert">{slotNameError(renamed, node.slots, selected)}</p>}
      </details>}
    </section>}
  </div>;
}

function Mapping({ node, trail, context }) {
  const [namesCopied, setNamesCopied] = useState(false);
  const sourceId = sourceOf(context.definition, node.input);
  const evidence = useSourceEvidence(context.definition.sources[sourceId], context.question && !context.focused ? null : context.loadSource);
  const table = context.definition.tables[node.table];
  if (!table) return <p role="alert">Таблицю відповідностей не знайдено. Відкрийте розширені правила.</p>;
  const update = (transform) => context.question ? context.questionMapping(transform) : context.mapping(trail, transform);
  const ids = [...new Set([...Object.keys(table), ...(context.question?.contract.allowed || [])])];
  return <div className="et-mapping">
    <p><strong>Звідки брати значення:</strong> {sourceLabel(context.definition, sourceId, context.registry)}</p>
    <Scope context={{ ...context, suppressScope: false }} trail={trail} table={node.table} />
    {context.focused && context.definition.sources[sourceId]?.kind === 'semantic' ? <><label>Як записувати значення<select className="input" value={namesCopied ? 'labels' : 'mapping'} disabled={context.readOnly} onChange={(e) => {
      if (e.target.value === 'labels') { if (update(() => copyCurrentOptionLabels(evidence, table)) === false) return; setNamesCopied(true); }
      else setNamesCopied(false);
    }}><option value="labels" disabled={!Object.keys(copyCurrentOptionLabels(evidence)).length}>Як названо в характеристиці</option><option value="mapping">Задати свої значення</option></select></label><p className="et-muted">{frozenNamesHelp}</p></> : <><h3>Значення у CSV</h3>
      {context.definition.sources[sourceId]?.kind === 'semantic' && <OptionNamesCopy evidence={context.sourceEvidence || evidence} entries={table} readOnly={context.readOnly} onChange={(entries) => update(() => entries)} />}</>}
    <MappingTableEditor entries={table} ids={ids} evidence={context.sourceEvidence || evidence} support={context.definition.sourceSupport?.sources?.[`${context.definition.sources[sourceId]?.category}.${context.definition.sources[sourceId]?.key}`]} strictText={Boolean(context.question)} readOnly={context.readOnly} showEvidence={!context.question && !context.focused} technical={!context.focused} onChange={(entries) => { update(() => entries); setNamesCopied(false); }} />
    {!context.question && !context.focused && <SourceSupportStatus definition={context.definition} sourceId={sourceId} diagnostics={context.diagnostics} showDetails={false} />}
    {context.question || context.localOnly || context.focused ? <p className="et-muted">Немає відповідності: {node.otherwise?.op === 'literal' && node.otherwise.value === '' ? 'порожній текст; подальші перевірки готовності збережено.' : 'збережене запасне правило.'}</p> : <>
      {node.otherwise && <details><summary>Якщо значення відсутнє або немає відповідності</summary><TaskValue node={node.otherwise} trail={[...trail, 'otherwise']} context={context} /></details>}
      <details className="et-secondary"><summary>Змінити характеристику</summary><TaskValue node={node.input} trail={[...trail, 'input']} context={context} /></details></>}
    {!context.focused && <details className="et-secondary"><summary>Джерело та ID таблиці</summary><code>{sourceId} → {node.table}</code></details>}
  </div>;
}

function ComputedGuard({ node, trail, context, guard }) {
  const [showFallback, setShowFallback] = useState(false);
  return <>
    <p className="et-muted">Заповнюється, коли для характеристики «{sourceLabel(context.definition, guard.source, context.registry)}» є текст у шаблоні.</p>
    <TaskValue node={node.then} trail={[...trail, 'then']} context={context} output />
    <details className="et-secondary" onToggle={(e) => setShowFallback(e.currentTarget.open)}><summary>Якщо текст для характеристики відсутній</summary>{showFallback && <TaskValue node={node.else} trail={[...trail, 'else']} context={context} output />}</details>
    {!context.focused && <details><summary>Технічні подробиці перевірки</summary><pre>{JSON.stringify(node.if, null, 2)}</pre><AdvancedRule context={context}>Перевірка наявності тексту збережена окремо від умов нижче.</AdvancedRule></details>}
  </>;
}

function FallbackComposer({ node, trail, context }) {
  const [adding, setAdding] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const root = useRef(null);
  const updateItems = (transform) => {
    if (![...root.current.querySelectorAll('input,textarea,select')].every((control) => control.reportValidity())) return;
    if (context.update(trail, (value) => ({ ...value, items: transform(value.items) })) !== false) setEpoch((n) => n + 1);
  };
  return <section ref={root} className="et-fallback" aria-label="Перше доступне значення">
    <p>Використати перше заповнене значення, зверху вниз.</p>
    <ol>{node.items.map((item, index) => <li key={`${epoch}/${index}`}>
      <h4>{index + 1}. {summary(context.definition, item)}</h4>
      <TaskValue node={item} trail={[...trail, 'items', index]} context={context} />
      {!context.readOnly && <div className="et-actions">
        <button type="button" className="et-link" disabled={!index} onClick={() => updateItems((items) => moveItem(items, index, -1))}>Вище</button>
        <button type="button" className="et-link" disabled={index === node.items.length - 1} onClick={() => updateItems((items) => moveItem(items, index, 1))}>Нижче</button>
        <button type="button" className="et-link" disabled={node.items.length === 1} onClick={() => updateItems((items) => items.filter((_, i) => i !== index))}>Вилучити значення {index + 1}</button>
      </div>}
    </li>)}</ol>
    {!context.readOnly && <div className="et-actions">
      <button type="button" className="btn btn-outline px-3" onClick={() => updateItems((items) => [...items, { op: 'literal', value: '' }])}>Додати постійне значення</button>
      <button type="button" className="btn btn-outline px-3" onClick={() => setAdding(!adding)}>Додати характеристику</button>
    </div>}
    {adding && <CharacteristicPicker node={{ slots: {} }} context={context} onInsert={(source, table) => {
      const slot = Object.values(insertCharacteristic({ template: '', slots: {} }, source, table).slots)[0];
      updateItems((items) => [...items, slot]); setAdding(false);
    }} />}
    <button type="button" className="et-link" onClick={context.onTechnical}>Додаткові налаштування</button>
  </section>;
}

function TaskValue({ node: original, trail: originalTrail = [], context, output = false }) {
  const resolved = resolveNode(context.definition, original, originalTrail);
  const { node, trail } = resolved;
  const update = (transform) => context.update(trail, transform);
  if (context.focused && expressionIntent(context.definition, original) === 'complex') return <AdvancedRule context={context}>Власне правило збережено без змін. Його повна структура доступна в розширеному редакторі.</AdvancedRule>;
  if (resolved.problem || !node || typeof node !== 'object') return <p>{resolved.problem || 'Власне значення. Доступне в розширених правилах.'}</p>;
  if ((node.op === 'interpolate' && (typeof node.template !== 'string' || !record(node.slots)))
    || (node.op === 'in' && !Array.isArray(node.values))
    || (node.op === 'numericBand' && (!Array.isArray(node.bands) || node.bands.some((band) => !record(band))))) return <p role="note">Непідтримувана структура «{node.op}». Визначення збережено без змін; відкрийте розширені правила.</p>;
  if (trail.some((step) => step.ref === 'sku')) return <p>Артикул береться зі збереженого товару. Ідентифікаційне правило захищено.</p>;
  if (node.op === 'literal' && Object.hasOwn(node, 'value')) return output && typeof node.value === 'string' && exactExpression(node, ['op', 'value']) ? <TextComposer node={node} trail={trail} context={context} /> : <><Scope context={context} trail={trail} /><Scalar disabled={context.readOnly} value={node.value} label="Значення" onChange={(value) => update((current) => ({ ...current, value }))} /></>;
  if (node.op === 'interpolate' && typeof node.template === 'string' && node.slots && !Array.isArray(node.slots)) return <TextComposer node={node} trail={trail} context={context} />;
  if (node.op === 'when') {
    const guard = exactExpression(node, ['op', 'if', 'then', 'else']) && computedPresence(context.definition, node.if);
    const childContext = { ...context, suppressScope: true };
    return <><Scope context={context} trail={trail} />{guard ? <ComputedGuard node={node} trail={trail} context={childContext} guard={guard} />
      : <ConditionComposer node={node} trail={trail} context={context} renderValue={(value, path) => <TaskValue node={value} trail={path} context={childContext} output />} />}</>;
  }
  if (node.op === 'require') return <><p className="et-muted">До цього значення застосовується перевірка готовності товару.</p><TaskValue node={node.value} trail={[...trail, 'value']} context={context} output={output} />
    {!context.focused && <details><summary>Перевірка готовності</summary><pre>{JSON.stringify({ if: node.if, error: node.error }, null, 2)}</pre><AdvancedRule context={context} /></details>}</>;
  if (node.op === 'lookup') return <Mapping node={node} trail={trail} context={context} />;
  if (node.op === 'source') {
    const approved = availableSources(context.registry, context.group);
    if (context.focused && context.definition.sources[node.id]?.kind === 'semantic') return <p>Характеристика: <strong>{sourceLabel(context.definition, node.id, context.registry)}</strong>. Збережений спосіб запису доступний у технічних подробицях.</p>;
    const choices = Object.entries(context.definition.sources).filter(([, source]) => (!context.focused || source.kind !== 'semantic') && approved.some((entry) => entry.descriptor.kind === source.kind && entry.descriptor.category === source.category && entry.descriptor.key === source.key && entry.descriptor.field === source.field)).map(([id, descriptor]) => ({ id, descriptor }));
    return <><Scope context={context} trail={trail} /><SourcePicker registry={context.registry} group={context.group} choices={choices} disabled={context.readOnly} showDetails={!context.focused} value={node.id} onChange={(id) => update((value) => ({ ...value, id }))} /></>;
  }
  if (['text', 'semanticKey', 'numberText', 'decimalText', 'present', 'not'].includes(node.op) && node.input) return <>
    {['present', 'not'].includes(node.op) && <p>{node.op === 'present' ? 'Значення має бути заповнене' : 'Зворотна умова'}</p>}
    <TaskValue node={node.input} trail={[...trail, 'input']} context={context} />
    {context.focused ? <p className="et-muted">{node.op === 'text' ? 'Використати значення як є' : 'Число у збереженому форматі шаблону'}</p> : <details className="et-secondary"><summary>Формат і обробка значення</summary><p>{node.format || node.policy || 'Збережений формат'}</p>
      {Object.hasOwn(node, 'trim') && <Scalar disabled={context.readOnly} value={node.trim} fixedType label="Прибирати крайні пробіли" onChange={(trim) => update((value) => ({ ...value, trim }))} />}
      {node.error && <TaskValue node={node.error} trail={[...trail, 'error']} context={context} />}</details>}</>;
  if (context.focused && node.op === 'firstPresent') return <FallbackComposer node={node} trail={trail} context={context} />;
  if (['firstPresent', 'join', 'all', 'any'].includes(node.op) && Array.isArray(node.items)) return <>
    <Scope context={context} trail={trail} /><p>{({ firstPresent: 'Використати перше заповнене значення, зверху вниз.', join: 'Об’єднати значення в цьому порядку.', all: 'Мають виконуватися всі умови.', any: 'Достатньо однієї умови.' })[node.op]}</p>
    {node.items.map((item, index) => <details key={index} className="et-sequence"><summary>{index + 1}. {summary(context.definition, item)}</summary>
      <TaskValue node={item} trail={[...trail, 'items', index]} context={context} output={output} />
      {!context.readOnly && <div className="et-actions"><button type="button" disabled={!index} onClick={() => update((value) => ({ ...value, items: moveItem(value.items, index, -1) }))}>Вище</button><button type="button" disabled={index === node.items.length - 1} onClick={() => update((value) => ({ ...value, items: moveItem(value.items, index, 1) }))}>Нижче</button></div>}
    </details>)}{node.op === 'join' && <Scalar disabled={context.readOnly} fixedType value={node.delimiter} label="Роздільник" onChange={(delimiter) => update((value) => ({ ...value, delimiter }))} />}</>;
  if (node.op === 'numericBand' && Array.isArray(node.bands)) return <><Scope context={context} trail={trail} /><TaskValue node={node.input} trail={[...trail, 'input']} context={context} />
    <div className="et-table-scroll"><table aria-label="Числові діапазони"><thead><tr><th>Мінімум</th><th>Максимум</th><th>Значення у CSV</th></tr></thead><tbody>{node.bands.map((band, index) => <tr key={index}>
      {['min', 'max', 'value'].map((key) => <td key={key}><Scalar disabled={context.readOnly} value={band[key]} label={`${label(key)} ${index + 1}`} onChange={(next) => context.update([...trail, 'bands', index], (current) => ({ ...current, [key]: next }))} />
        {key !== 'value' && <label><input type="checkbox" disabled={context.readOnly} checked={band[key + 'Inclusive']} onChange={(e) => context.update([...trail, 'bands', index], (current) => ({ ...current, [key + 'Inclusive']: e.target.checked }))} /> {band[key + 'Inclusive'] ? 'Межа включно' : 'Межа виключно'}</label>}</td>)}
    </tr>)}</tbody></table></div>{node.outside && <details><summary>Поза діапазонами</summary><TaskValue node={node.outside} trail={[...trail, 'outside']} context={context} /></details>}</>;
  if (node.op === 'eq') return <><p>Значення повинні збігатися</p><TaskValue node={node.left} trail={[...trail, 'left']} context={context} /><TaskValue node={node.right} trail={[...trail, 'right']} context={context} /></>;
  if (node.op === 'in') return <><TaskValue node={node.input} trail={[...trail, 'input']} context={context} />{node.values.map((value, index) => <Scalar disabled={context.readOnly} key={index} fixedType value={value} label={`Допустиме значення ${index + 1}`} onChange={(next) => update((current) => ({ ...current, values: current.values.map((entry, i) => i === index ? next : entry) }))} />)}</>;
  if (node.op === 'error') return <><p>Повідомлення, якщо товар не готовий:</p><TaskValue node={node.message} trail={[...trail, 'message']} context={context} /></>;
  return <AdvancedRule context={context}>Власне правило збережено без змін. Його повна структура доступна в розширеному редакторі.</AdvancedRule>;
}

export function FieldInspector({ definition, cellPath, onChange, registry, readOnly, loadSource, diagnostics = [], openSource, onAdvanced, focused = false, onTechnical }) {
  const [scope, setScope] = useState('local');
  const [error, setError] = useState('');
  const column = cellPath[5];
  const group = definition.groups[cellPath[1]];
  const row = group.rows[cellPath[3]];
  const lens = questionField(definition, cellPath);
  const live = useRef(null);
  useLayoutEffect(() => { live.current = definition; return () => { live.current = null; }; }, [definition]);
  const apply = (action) => { if (readOnly || live.current !== definition) return false; try { onChange(action()); setError(''); return true; } catch (e) { setError(e.message); return false; } };
  const context = { definition, cellPath, scope, setScope, registry, readOnly, loadSource, diagnostics, onAdvanced, onTechnical, focused, openSource, group: group.route,
    update: (trail, transform) => apply(() => editField(definition, cellPath, trail, scope, transform)),
    mapping: (trail, transform) => apply(() => editMapping(definition, cellPath, trail, scope, transform)),
    questionMapping: (transform) => apply(() => editQuestionMapping(definition, cellPath, scope, transform)) };
  return <section className="et-inspector" aria-label="Редактор поля">
    {error && <p role="alert" className="danger-panel p-3">{error}</p>}
    <div className="et-field-value">
      {protectedCells.has(column) ? <p>Захищене ідентифікаційне поле: {column}.</p> : lens ? focused ? <Mapping node={lens.lookup} trail={lens.trail} context={{ ...context, question: lens }} /> : <QuestionField lens={lens} context={context} mappingComponent={Mapping} loadSource={loadSource} diagnostics={diagnostics} openSource={openSource} /> : Object.hasOwn(row.cells, column) ? <TaskValue node={at(definition, cellPath)} context={context} /> : <>
        <p>Порожня комірка. Значення з основного рядка не підставляється.</p>{!readOnly && <button type="button" className="btn btn-outline px-3" onClick={() => context.update([], () => ({ op: 'literal', value: '' }))}>Додати текст у цю комірку</button>}</>}
    </div>
    {!focused && !lens && openSource && <><p>Джерело: {sourceLabel(definition, openSource, registry)}</p><SourceSupportStatus definition={definition} sourceId={openSource} diagnostics={diagnostics} showDetails={false} /></>}
    {!focused && !lens && openSource && definition.sources[openSource] && <details className="et-source-panel"><summary>Подробиці джерела</summary>
      <SourceSupportEvidence policy={definition.sourceSupport?.sources?.[`${definition.sources[openSource].category}.${definition.sources[openSource].key}`]} />
      <p>Характеристика товару: {sourceLabel(definition, openSource, registry)} · {openSource}. Значення читається зі збереженого товару.</p>
      <h3>Поточний каталог</h3><p>{registry?.references?.questions?.filter((q) => q.category_code === definition.sources[openSource].category && q.key === definition.sources[openSource].key).map((q) => `${q.label}: ID ${q.value_ids.join(', ')}`).join('; ') || 'Метадані поточного питання не надано.'}</p>
      <h3>Історичні SKU-схеми</h3><p>{registry?.references?.schemas?.filter((s) => s.category_code === definition.sources[openSource].category).flatMap((s) => s.questions.filter((q) => q.key === definition.sources[openSource].key).map((q) => `v${s.version}: ID ${q.value_ids.join(', ')}`)).join('; ') || 'Історичні метадані питання не надано.'}</p>
      <SourceDiagnostics diagnostics={diagnostics.filter((d) => d.sourceId === openSource)} definition={definition} registry={registry} />
      <details><summary>Зафіксоване джерело — лише читання</summary><pre>{JSON.stringify(definition.sources[openSource], null, 2)}</pre></details>
      <p>Відповідності тексту не є доказом значення джерела. Каталог і відповіді товарів тут не редагуються.</p>
    </details>}
    </section>;
}

