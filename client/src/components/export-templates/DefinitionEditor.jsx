import { useRef, useState, useEffect } from 'react';
import { questionField, editQuestionMapping } from '../../lib/export-template-attributes';
import { QuestionField, OptionLabel } from './QuestionField';
import { SourceDiagnostics } from './SourceDiagnostics';
import { AdvancedDefinitionEditor, Scalar } from './AdvancedDefinitionEditor';
import { fieldLabels, moveItem, protectedCells, renameSlot, removeSlot, slotNameError } from '../../lib/export-template-editor';
import { at, affectedFields, editField, editMapping, fieldSection, insertCharacteristic, mappingsForSource, resolveNode, sourceLabel, sourceOf, summary } from '../../lib/export-template-presentation';
import { OutputGrid } from './OutputGrid';
import { COLUMN_CONTRACT, requiredColumns, codeError, columnChange, availableSources, bindColumnSource, literalColumn } from '../../lib/export-template-columns';
import './export-template-editor.css';

const label = (key) => fieldLabels[key] || key;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const groupNames = { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' };

function Scope({ context, trail, table }) {
  if (context.readOnly) return null;
  const affected = affectedFields(context.definition, context.cellPath, trail, table);
  const readable = context.question ? affected.map((value) => {
    const [group, row, column] = value.split(' / ');
    return `${groupNames[group] || group} — ${column ? label(column) + (row === 'EN' ? ' (EN)' : '') : row}`;
  }) : affected;
  return <div className="et-scope">
    <label>Область зміни<select className="input" value={context.scope} onChange={(e) => context.setScope(e.target.value)}>
      <option value="local">Лише для цього поля</option><option value="shared">Для всіх полів, які використовують це правило</option>
    </select></label>
    {context.scope === 'shared' ? <p role="note">Зміна вплине на: {readable.join('; ')}.</p>
      : <p>Зміниться лише це поле{context.question ? ' та пов’язана перевірка його готовності' : ''}. Потрібні правила й відповідності копіюються під час редагування.</p>}
  </div>;
}

function CharacteristicPicker({ node, onInsert, context }) {
  const [source, setSource] = useState('');
  const [table, setTable] = useState('');
  const sources = Object.entries(context.definition.sources).filter(([, value]) => (value.kind === 'product' || value.category === context.group) && value.type !== 'boolean');
  const mappings = mappingsForSource(context.definition, source);
  return <div className="et-source-picker">
    <label>Характеристика<select className="input" value={source} onChange={(e) => { setSource(e.target.value); setTable(''); }}>
      <option value="">Оберіть характеристику</option>{sources.map(([id]) => <option key={id} value={id}>{sourceLabel(context.definition, id, context.registry)}</option>)}
    </select></label>
    <label>Як записувати у файлі<select className="input" value={table} onChange={(e) => setTable(e.target.value)}>
      <option value="">Збережене значення без заміни</option>{mappings.map((id) => <option key={id} value={id}>Відповідності: {Object.values(context.definition.tables[id]).slice(0, 3).join(' / ')} ({id})</option>)}
    </select></label>
    <button type="button" className="btn btn-primary px-3" disabled={!source || Object.keys(node.slots).length >= 16} onClick={() => onInsert(source, table)}>Вставити характеристику</button>
    {Object.keys(node.slots).length >= 16 && <p>Досягнуто межу: 16 характеристик.</p>}
  </div>;
}

function TextComposer({ node, trail, context }) {
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [renamed, setRenamed] = useState('');
  const input = useRef(null);
  const selection = useRef(null);
  const used = [...node.template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  const invalid = used.some((slot) => !Object.hasOwn(node.slots, slot)) || Object.keys(node.slots).some((slot) => !used.includes(slot)) || /[{}]/.test(node.template.replace(/\{[A-Za-z0-9_]+\}/g, ''));
  const update = (transform) => context.update(trail, transform);
  return <div className="et-composer">
    <Scope context={context} trail={trail} />
    <label>Текст у файлі<textarea ref={(element) => { input.current = element; element?.setCustomValidity(invalid ? 'Перевірте характеристики у фігурних дужках.' : ''); }} className="input et-text" rows={3} disabled={context.readOnly}
      value={node.template} aria-invalid={invalid} aria-describedby="et-text-help" onSelect={(e) => { selection.current = [e.target.selectionStart, e.target.selectionEnd]; }}
      onChange={(e) => update((value) => ({ ...value, template: e.target.value }))} /></label>
    <p id="et-text-help" className="et-muted">Текст і розділові знаки зберігаються точно. Характеристики у {'{дужках}'} сервер замінить значеннями товару.</p>
    {invalid && <p role="alert">Використайте всі додані характеристики, без невідомих назв чи незакритих дужок. Для вилучення скористайтеся кнопкою характеристики.</p>}
    <div className="et-tokens" aria-label="Характеристики в тексті">{Object.entries(node.slots).map(([slot, value]) => <button key={slot} type="button" className="et-token" aria-pressed={selected === slot} onClick={() => { setSelected(selected === slot ? '' : slot); setRenamed(slot); setAdding(false); }}>
      {fieldLabels[slot] || sourceLabel(context.definition, sourceOf(context.definition, value), context.registry) || slot}<span>{`{${slot}}`}</span>
    </button>)}
      {!context.readOnly && <button type="button" className="btn btn-outline px-3" onClick={() => { setAdding(!adding); setSelected(''); }}>+ Додати характеристику</button>}
    </div>
    {adding && <CharacteristicPicker node={node} context={context} onInsert={(source, table) => {
      update((value) => insertCharacteristic(value, source, table, selection.current)); setAdding(false); input.current?.focus();
    }} />}
    {selected && Object.hasOwn(node.slots, selected) && <section className="et-slot" aria-label="Налаштування характеристики">
      <div className="et-row"><h3>{label(selected)}</h3><button type="button" className="et-link" onClick={() => setSelected('')}>Закрити</button></div>
      <TaskValue node={node.slots[selected]} trail={[...trail, 'slots', selected]} context={context} />
      {!context.readOnly && <details className="et-secondary"><summary>Назва та вилучення характеристики</summary>
        <label>Назва підстановки<input className="input" value={renamed} onChange={(e) => setRenamed(e.target.value)} /></label>
        <button type="button" className="et-link" disabled={Boolean(slotNameError(renamed, node.slots, selected)) || renamed === selected} onClick={() => { update((value) => renameSlot(value, selected, renamed)); setSelected(renamed); }}>Перейменувати й оновити текст</button>
        <button type="button" className="et-link" onClick={() => { update((value) => removeSlot({ ...value, template: value.template.split(`{${selected}}`).join('') }, selected)); setSelected(''); }}>Вилучити характеристику та її позначки з тексту</button>
        {renamed && slotNameError(renamed, node.slots, selected) && <p role="alert">{slotNameError(renamed, node.slots, selected)}</p>}
      </details>}
    </section>}
  </div>;
}

function Mapping({ node, trail, context }) {
  const [newId, setNewId] = useState('');
  const sourceId = sourceOf(context.definition, node.input);
  const table = context.definition.tables[node.table];
  if (!table) return <p role="alert">Таблицю відповідностей не знайдено. Відкрийте розширені правила.</p>;
  const update = (transform) => context.question ? context.questionMapping(transform) : context.mapping(trail, transform);
  const ids = [...new Set([...Object.keys(table), ...(context.question?.contract.allowed || [])])];
  return <div className="et-mapping">
    <p><strong>Звідки брати значення:</strong> {sourceLabel(context.definition, sourceId, context.registry)}</p>
    <Scope context={context} trail={trail} table={node.table} />
    <h3>Як записувати у файлі</h3><p className="et-muted">ID — збережене значення характеристики. Текст праворуч потрапить у файл.</p>
    <div className="et-table-scroll"><table><thead><tr><th>Значення характеристики</th><th>Текст у файлі</th>{!context.readOnly && <th><span className="sr-only">Дії</span></th>}</tr></thead>
      <tbody>{ids.map((id) => <tr key={id}><th scope="row"><OptionLabel evidence={context.sourceEvidence} id={id} /></th><td>{Object.hasOwn(table, id) ? <>
        {context.question && typeof table[id] !== 'string' ? <p>Некоректний тип відповідності: <code>{JSON.stringify(table[id])}</code>. Збережено без перетворення; виправлення — у розширених правилах.</p>
          : <Scalar disabled={context.readOnly} fixedType value={table[id]} label={`Текст для ID ${id}`} onChange={(next) => update((entries) => ({ ...entries, [id]: next }))} />}
        {table[id] === '' && <span>Порожня клітинка</span>}{table[id] === null && <span>null — не порожній текст</span>}</> : <span>Відповідності немає</span>}</td>
        {!context.readOnly && <td>{Object.hasOwn(table, id) ? <button type="button" className="et-link" aria-label={`Вилучити відповідність ${id}`} onClick={() => update((entries) => Object.fromEntries(Object.entries(entries).filter(([key]) => key !== id)))}>Вилучити</button>
          : <button type="button" onClick={() => update((entries) => ({ ...entries, [id]: '' }))}>Додати текст для ID {id}</button>}</td>}</tr>)}</tbody></table></div>
    {!context.readOnly && <details><summary>Додати відповідність</summary><label>ID характеристики<input className="input" value={newId} onChange={(e) => setNewId(e.target.value)} /></label>
      <button type="button" className="btn btn-outline px-3" disabled={!newId || Object.hasOwn(table, newId) || ['__proto__', 'constructor', 'prototype'].includes(newId)} onClick={() => { update((entries) => ({ ...entries, [newId]: '' })); setNewId(''); }}>Додати відповідність</button></details>}
    {context.question ? <p>Немає відповідності: {node.otherwise?.op === 'literal' && node.otherwise.value === '' ? 'порожній текст; подальші перевірки готовності збережено.' : 'збережена діагностика шаблону; товар може бути не готовим.'}</p> : <>
      {node.otherwise && <details><summary>Якщо значення відсутнє або немає відповідності</summary><TaskValue node={node.otherwise} trail={[...trail, 'otherwise']} context={context} /></details>}
      <details className="et-secondary"><summary>Змінити характеристику</summary><TaskValue node={node.input} trail={[...trail, 'input']} context={context} /></details></>}
    <details className="et-secondary"><summary>Джерело та ID таблиці</summary><code>{sourceId} → {node.table}</code></details>
  </div>;
}

function TaskValue({ node: original, trail: originalTrail = [], context }) {
  const [branch, setBranch] = useState('');
  const resolved = resolveNode(context.definition, original, originalTrail);
  const { node, trail } = resolved;
  const update = (transform) => context.update(trail, transform);
  if (resolved.problem || !node || typeof node !== 'object') return <p>{resolved.problem || 'Власне значення. Доступне в розширених правилах.'}</p>;
  if ((node.op === 'interpolate' && (typeof node.template !== 'string' || !record(node.slots)))
    || (node.op === 'in' && !Array.isArray(node.values))
    || (node.op === 'numericBand' && (!Array.isArray(node.bands) || node.bands.some((band) => !record(band))))) return <p role="note">Непідтримувана структура «{node.op}». Визначення збережено без змін; відкрийте розширені правила.</p>;
  if (trail.some((step) => step.ref === 'sku')) return <p>Артикул береться зі збереженого товару. Ідентифікаційне правило захищено.</p>;
  if (node.op === 'literal' && Object.hasOwn(node, 'value')) return <><Scope context={context} trail={trail} /><Scalar disabled={context.readOnly} value={node.value} label="Значення" onChange={(value) => update((current) => ({ ...current, value }))} /></>;
  if (node.op === 'interpolate' && typeof node.template === 'string' && node.slots && !Array.isArray(node.slots)) return <TextComposer node={node} trail={trail} context={context} />;
  if (['when', 'require'].includes(node.op)) {
    const primary = node.op === 'when' ? 'then' : 'value';
    const selected = branch || primary;
    return <div><div className="et-branches" aria-label="Умовне значення">{[[primary, 'Основний текст'], ['if', 'Умова'], [node.op === 'when' ? 'else' : 'error', node.op === 'when' ? 'Інакше' : 'Якщо перевірку не пройдено']].map(([key, title]) =>
      <button type="button" key={key} aria-pressed={selected === key} onClick={() => setBranch(key)}>{title}</button>)}</div>
      <TaskValue key={selected} node={node[selected]} trail={[...trail, selected]} context={context} />
      <p className="et-muted et-guard">Умова та запасна гілка зберігаються під час редагування тексту.</p></div>;
  }
  if (node.op === 'lookup') return <Mapping node={node} trail={trail} context={context} />;
  if (node.op === 'source') return <><Scope context={context} trail={trail} /><label>Звідки брати значення<select className="input" disabled={context.readOnly} value={node.id} onChange={(e) => update((value) => ({ ...value, id: e.target.value }))}>
    <option value={node.id}>{sourceLabel(context.definition, node.id, context.registry)}</option>{Object.entries(context.definition.sources).filter(([id, source]) => id !== node.id && (source.kind === 'product' || source.category === context.group)).map(([id]) => <option key={id} value={id}>{sourceLabel(context.definition, id, context.registry)}</option>)}
  </select></label></>;
  if (['text', 'semanticKey', 'numberText', 'decimalText', 'present', 'not'].includes(node.op) && node.input) return <>
    {['present', 'not'].includes(node.op) && <p>{node.op === 'present' ? 'Значення має бути заповнене' : 'Зворотна умова'}</p>}
    <TaskValue node={node.input} trail={[...trail, 'input']} context={context} />
    <details className="et-secondary"><summary>Формат і обробка значення</summary><p>{node.format || node.policy || 'Збережений формат'}</p>
      {Object.hasOwn(node, 'trim') && <Scalar disabled={context.readOnly} value={node.trim} fixedType label="Прибирати крайні пробіли" onChange={(trim) => update((value) => ({ ...value, trim }))} />}
      {node.error && <TaskValue node={node.error} trail={[...trail, 'error']} context={context} />}</details></>;
  if (['firstPresent', 'join', 'all', 'any'].includes(node.op) && Array.isArray(node.items)) return <>
    <Scope context={context} trail={trail} /><p>{({ firstPresent: 'Використати перше заповнене значення, зверху вниз.', join: 'Об’єднати значення в цьому порядку.', all: 'Мають виконуватися всі умови.', any: 'Достатньо однієї умови.' })[node.op]}</p>
    {node.items.map((item, index) => <details key={index} className="et-sequence"><summary>{index + 1}. {summary(context.definition, item)}</summary>
      <TaskValue node={item} trail={[...trail, 'items', index]} context={context} />
      {!context.readOnly && <div className="et-actions"><button type="button" disabled={!index} onClick={() => update((value) => ({ ...value, items: moveItem(value.items, index, -1) }))}>Вище</button><button type="button" disabled={index === node.items.length - 1} onClick={() => update((value) => ({ ...value, items: moveItem(value.items, index, 1) }))}>Нижче</button></div>}
    </details>)}{node.op === 'join' && <Scalar disabled={context.readOnly} fixedType value={node.delimiter} label="Роздільник" onChange={(delimiter) => update((value) => ({ ...value, delimiter }))} />}</>;
  if (node.op === 'numericBand' && Array.isArray(node.bands)) return <><Scope context={context} trail={trail} /><TaskValue node={node.input} trail={[...trail, 'input']} context={context} />
    {node.bands.map((band, index) => <details key={index} className="et-sequence"><summary>Діапазон {index + 1}: {band.min ?? '−∞'} … {band.max ?? '+∞'}</summary>
      {Object.entries(band).map(([key, value]) => <Scalar disabled={context.readOnly} key={key} value={value} label={label(key)} onChange={(next) => context.update([...trail, 'bands', index], (current) => ({ ...current, [key]: next }))} />)}
    </details>)}{node.outside && <details><summary>Поза діапазонами</summary><TaskValue node={node.outside} trail={[...trail, 'outside']} context={context} /></details>}</>;
  if (node.op === 'eq') return <><p>Значення повинні збігатися</p><TaskValue node={node.left} trail={[...trail, 'left']} context={context} /><TaskValue node={node.right} trail={[...trail, 'right']} context={context} /></>;
  if (node.op === 'in') return <><TaskValue node={node.input} trail={[...trail, 'input']} context={context} />{node.values.map((value, index) => <Scalar disabled={context.readOnly} key={index} fixedType value={value} label={`Допустиме значення ${index + 1}`} onChange={(next) => update((current) => ({ ...current, values: current.values.map((entry, i) => i === index ? next : entry) }))} />)}</>;
  if (node.op === 'error') return <><p>Повідомлення, якщо товар не готовий:</p><TaskValue node={node.message} trail={[...trail, 'message']} context={context} /></>;
  return <div role="note">Власне правило «{node.op || 'невідоме'}» збережено без змін. Для перегляду всіх властивостей відкрийте «Розширені правила».</div>;
}

function FieldInspector({ definition, cellPath, onChange, registry, readOnly, loadSource, diagnostics, openSource }) {
  const [scope, setScope] = useState('local');
  const [error, setError] = useState('');
  const column = cellPath[5];
  const group = definition.groups[cellPath[1]];
  const row = group.rows[cellPath[3]];
  const lens = questionField(definition, cellPath);
  const apply = (action) => { if (readOnly) return; try { onChange(action()); setError(''); } catch (e) { setError(e.message); } };
  const context = { definition, cellPath, scope, setScope, registry, readOnly, group: group.route,
    update: (trail, transform) => apply(() => editField(definition, cellPath, trail, scope, transform)),
    mapping: (trail, transform) => apply(() => editMapping(definition, cellPath, trail, scope, transform)),
    questionMapping: (transform) => apply(() => editQuestionMapping(definition, cellPath, scope, transform)) };
  return <section className="et-inspector" aria-label="Редактор поля">
    <header className="et-inspector-heading"><div><p className="et-eyebrow">{fieldSection(column)}</p><h2>{label(column)}</h2><code>{column}</code></div>
      {!readOnly && <details><summary>Порядок у файлі</summary><div className="et-actions">
        <button type="button" disabled={group.columns.indexOf(column) <= 0} onClick={() => onChange({ ...definition, groups: definition.groups.map((item, i) => i === cellPath[1] ? { ...item, columns: moveItem(item.columns, item.columns.indexOf(column), -1) } : item) })}>Перемістити колонку вище</button>
        <button type="button" disabled={group.columns.indexOf(column) === group.columns.length - 1} onClick={() => onChange({ ...definition, groups: definition.groups.map((item, i) => i === cellPath[1] ? { ...item, columns: moveItem(item.columns, item.columns.indexOf(column), 1) } : item) })}>Перемістити колонку нижче</button>
      </div></details>}
    </header>{error && <p role="alert" className="danger-panel p-3">{error}</p>}
    {!lens && openSource && definition.sources[openSource] && <details open className="et-source-panel"><summary>Переглянути джерело</summary>
      <p>Характеристика товару: {sourceLabel(definition, openSource, registry)} · {openSource}. Значення читається зі збереженого товару.</p>
      <h3>Поточний каталог</h3><p>{registry?.references?.questions?.filter((q) => q.category_code === definition.sources[openSource].category && q.key === definition.sources[openSource].key).map((q) => `${q.label}: ID ${q.value_ids.join(', ')}`).join('; ') || 'Метадані поточного питання не надано.'}</p>
      <h3>Історичні SKU-схеми</h3><p>{registry?.references?.schemas?.filter((s) => s.category_code === definition.sources[openSource].category).flatMap((s) => s.questions.filter((q) => q.key === definition.sources[openSource].key).map((q) => `v${s.version}: ID ${q.value_ids.join(', ')}`)).join('; ') || 'Історичні метадані питання не надано.'}</p>
      <SourceDiagnostics diagnostics={diagnostics.filter((d) => d.sourceId === openSource)} definition={definition} registry={registry} />
      <details><summary>Зафіксоване джерело — лише читання</summary><pre>{JSON.stringify(definition.sources[openSource], null, 2)}</pre></details>
      <p>Відповідності тексту не є доказом значення джерела. Каталог і відповіді товарів тут не редагуються.</p>
    </details>}
    <div className="et-field-value">
      {protectedCells.has(column) ? <p>Захищене ідентифікаційне поле: {column}.</p> : lens ? <QuestionField lens={lens} context={context} mappingComponent={Mapping} loadSource={loadSource} diagnostics={diagnostics} openSource={openSource} /> : Object.hasOwn(row.cells, column) ? <TaskValue node={at(definition, cellPath)} context={context} /> : <>
        <p>Порожня комірка. Значення з основного рядка не підставляється.</p>{!readOnly && <button type="button" className="btn btn-outline px-3" onClick={() => context.update([], () => ({ op: 'literal', value: '' }))}>Додати текст у цю комірку</button>}</>}
    </div></section>;
}

function ColumnStructure({ definition, groupIndex, rowIndex, column, onChange, onSelect, readOnly }) {
  const group = definition.groups[groupIndex];
  const [code, setCode] = useState(column);
  const [newCode, setNewCode] = useState('');
  const [problem, setProblem] = useState('');
  const change = (action, value, target = column) => {
    try { const next = columnChange(definition, groupIndex, action, target, value); onChange(next); setProblem('');
      if (['add', 'duplicate', 'rename'].includes(action)) onSelect(value);
      if (action === 'remove') onSelect(next.groups[groupIndex].columns[0]);
    } catch (e) { setProblem(e.message); }
  };
  return <section className="et-column-actions" aria-label="Дії колонки">
    <h3>Налаштувати правило · {rowIndex === 1 ? 'EN' : 'Основний рядок'}</h3>
    {problem && <p role="alert">{problem}</p>}
    {definition.outputContract !== COLUMN_CONTRACT ? <p>Фіксований історичний контракт. Для додавання чи видалення колонок явно оновіть збережену чернетку.</p> : <>
      <label>Назва для редактора<input className="input" disabled={readOnly} maxLength={160} value={group.columnLabels?.[column] || ''} onChange={(e) => change('label', e.target.value)} /></label>
      <label>Код колонки CSV<input className="input" disabled={readOnly || requiredColumns.has(column)} value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <button type="button" disabled={readOnly || requiredColumns.has(column) || Boolean(codeError(code, group.columns, column))} onClick={() => change('rename', code)}>Змінити код колонки</button>
      <p className="et-muted">Це код атрибута Magento, окремий від джерела. Існування й прийнятність Magento не перевірено; атрибут тут не створюється.</p>
      <label>Код нової колонки<input className="input" disabled={readOnly} value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="custom_attribute" /></label>
      <div className="et-actions">
        <button type="button" disabled={readOnly || Boolean(codeError(newCode, group.columns))} onClick={() => change('add', newCode)}>Додати колонку ліворуч</button>
        <button type="button" disabled={readOnly || Boolean(codeError(newCode, group.columns))} onClick={() => change('add', newCode, group.columns[group.columns.indexOf(column) + 1] ?? null)}>Додати колонку праворуч</button>
        <button type="button" disabled={readOnly || Boolean(codeError(newCode, group.columns))} onClick={() => change('duplicate', newCode)}>Дублювати</button>
      </div>
      <label>Перемістити на позицію<select className="input" disabled={readOnly} value={group.columns.indexOf(column)} onChange={(e) => change('move', Number(e.target.value))}>{group.columns.map((c, i) => <option key={c} value={i}>{i + 1} · {c}</option>)}</select></label>
      <button type="button" disabled={readOnly || requiredColumns.has(column)} onClick={() => change('remove')}>Видалити колонку</button>
      {requiredColumns.has(column) && <p>Захищено сервером: ідентичність товару, base/EN або мінімальне значення full-product імпорту.</p>}
    </>}
  </section>;
}

function ColumnSource({ definition, registry, groupIndex, rowIndex, column, onChange, readOnly }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState('text');
  const choices = availableSources(registry, definition.groups[groupIndex].route);
  if (readOnly || protectedCells.has(column) || definition.outputContract !== COLUMN_CONTRACT) return null;
  return <details className="et-source-panel"><summary>Обрати джерело або літерал для цього рядка</summary>
    <p>Заміна правила лише цієї клітинки. Інша мова та спільні джерела не змінюються. Порожнє джерело дає порожню клітинку.</p>
    {error && <p role="alert">{error}</p>}
    <label>Джерело SKU Manager<select className="input" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Оберіть перевірене джерело</option>{choices.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
    <label>Правило значення<select className="input" value={mode} onChange={(e) => setMode(e.target.value)}><option value="text">Збережене значення</option><option value="lookup">Відповідності значень</option><option value="interpolate">Текст із характеристикою</option><option value="firstPresent">Перше заповнене / запасний текст</option><option value="when">Якщо джерело заповнене</option></select></label>
    <button type="button" disabled={!source} onClick={() => { try { onChange(bindColumnSource(definition, groupIndex, rowIndex, column, choices.find((s) => s.id === source), mode)); setError(''); } catch (e) { setError(e.message); } }}>Застосувати джерело</button>
    <button type="button" onClick={() => onChange(literalColumn(definition, groupIndex, rowIndex, column))}>Ввести літерал</button>
  </details>;
}

export function DefinitionEditor({ definition, onChange, registry, readOnly = false, loadSource, diagnostics = [], focusField, onFieldSelect }) {
  const [groupIndex, setGroupIndex] = useState(0);
  const [rowIndex, setRowIndex] = useState(0);
  const [column, setColumn] = useState('name');
  const [, setQuery] = useState('');
  const [inspector, setInspector] = useState(false);
  const drawer = useRef(null);
  const trigger = useRef(null);
  const closeInspector = () => { setInspector(false); trigger.current?.focus(); };
  useEffect(() => { if (inspector) drawer.current?.focus(); }, [inspector, column]);
  const [advanced, setAdvanced] = useState(false);
  const [seenFocus, setSeenFocus] = useState(null);
  if (focusField !== seenFocus) {
    setSeenFocus(focusField);
    if (focusField) {
    setGroupIndex(focusField.groupIndex); setRowIndex(focusField.rowIndex); setColumn(focusField.column); setQuery(''); setAdvanced(false); setInspector(true);
    }
  }
  useEffect(() => { onFieldSelect?.({ groupIndex, rowIndex, column }); }, [groupIndex, rowIndex, column, onFieldSelect]);
  const supported = definition?.formatVersion === 1 && definition.evaluatorVersion === 'magento-declarative-1' && ['magento-products-v1', COLUMN_CONTRACT].includes(definition.outputContract)
    && Array.isArray(definition.groups) && Array.isArray(definition.bindings) && definition.bindings.every((binding) => record(binding) && typeof binding.id === 'string' && record(binding.value))
    && record(definition.sources) && Object.values(definition.sources).every(record)
    && record(definition.tables) && Object.values(definition.tables).every(record)
    && definition.groups.every((item) => record(item) && Array.isArray(item.columns) && item.columns.every((key) => typeof key === 'string') && Array.isArray(item.rows) && item.rows.every((entry) => record(entry) && record(entry.cells)));
  const group = definition?.groups?.[groupIndex];
  const row = group?.rows?.[rowIndex];
  if (!supported || !Array.isArray(group?.columns) || !row?.cells) return <div role="note">Цей формат ще не підтримується формами. Визначення збережено без змін.<details><summary>Технічне визначення</summary><pre>{JSON.stringify(definition, null, 2)}</pre></details></div>;
  if (advanced) return <div className="et-advanced"><div className="et-row"><button type="button" className="et-link" onClick={() => setAdvanced(false)}>← Поля експорту</button><span>{groupNames[group.route] || group.name} / {label(column)} / Розширені правила</span></div>
    <AdvancedDefinitionEditor definition={definition} onChange={onChange} registry={registry} readOnly={readOnly} initialGroup={groupIndex} initialRow={rowIndex} initialColumn={column} /></div>;
  const selectedColumn = group.columns.includes(column) ? column : group.columns[0];
  return <form id="template-definition-form" className="et-fields" onSubmit={(e) => e.preventDefault()}>
    <div className="et-filters"><label>Категорія<select className="input" value={groupIndex} onChange={(e) => { setGroupIndex(Number(e.target.value)); setQuery(''); }}>{definition.groups.map((item, i) => <option key={item.route} value={i}>{groupNames[item.route] || item.name}</option>)}</select></label>
      <label>Мова<select className="input" value={rowIndex} onChange={(e) => setRowIndex(Number(e.target.value))}>{group.rows.map((item, i) => <option key={item.id} value={i}>{item.id === 'english' ? 'English' : 'Українська / основний рядок'}</option>)}</select></label>
      <p className="et-muted">Показано поля однієї категорії. Шаблон зберігає всі {definition.groups.length} категорій.</p></div>
    <div className="et-tabs" role="group" aria-label="Категорії файлів">{definition.groups.map((item, i) => <button type="button" key={item.route} aria-pressed={i === groupIndex} onClick={() => { setGroupIndex(i); setInspector(false); }}>{groupNames[item.route] || item.name}</button>)}</div>
    <div className={inspector ? 'et-design-layout et-design-with-panel' : 'et-design-layout'}>
      <OutputGrid columns={group.columns} labels={group.columnLabels}
        title={group.name + ' · структура CSV'}
        rules={Object.fromEntries(group.columns.map((key) => [key, summary(definition, row.cells[key])]))}
        rows={[{ label: 'Основний · макет', placeholder: true }, { label: 'EN · макет', placeholder: true }]}
        onColumn={(key) => { trigger.current = document.activeElement; setColumn(key); setInspector(true); }}>
        {!readOnly && <button type="button" className="btn btn-outline px-3" onClick={() => { trigger.current = document.activeElement; setColumn(selectedColumn); setInspector(true); }}>+ Колонка</button>}
      </OutputGrid>
      {inspector && <aside className="et-column-drawer" ref={drawer} tabIndex={-1} aria-label="Налаштування колонки" onKeyDown={(e) => { if (e.key === 'Escape') closeInspector(); }}>
        <button type="button" className="et-link" onClick={closeInspector}>Закрити налаштування</button>
        <ColumnStructure key={groupIndex + '/' + selectedColumn} definition={definition} groupIndex={groupIndex} rowIndex={rowIndex} column={selectedColumn} onChange={onChange} onSelect={setColumn} readOnly={readOnly} />
        <ColumnSource key={'source/' + groupIndex + '/' + rowIndex + '/' + selectedColumn} definition={definition} registry={registry} groupIndex={groupIndex} rowIndex={rowIndex} column={selectedColumn} onChange={onChange} readOnly={readOnly} />
        <FieldInspector key={groupIndex + '/' + rowIndex + '/' + selectedColumn} definition={definition} cellPath={['groups', groupIndex, 'rows', rowIndex, 'cells', selectedColumn]} onChange={onChange} registry={registry} readOnly={readOnly} loadSource={loadSource} diagnostics={diagnostics} openSource={focusField?.sourceId && focusField.groupIndex === groupIndex && focusField.column === selectedColumn ? focusField.sourceId : null} />
      </aside>}
    </div>
    <p className="et-muted">Макет без товарів. Правила — метадані редактора, не рядки CSV. Категорія змінює лише вигляд; експорт охоплює весь вибраний діапазон.</p>
    <footer className="et-editor-footer"><button type="button" className="et-link" onClick={() => setAdvanced(true)}>Розширені правила</button><span>Умови, спільні правила, джерела та технічне визначення</span></footer>
  </form>;
}
