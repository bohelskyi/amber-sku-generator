import { useEffect, useId, useRef, useState } from 'react';
import { consumers, copyDefinition, fieldLabels, moveItem, operationLabels, protectedCells, replaceAt, slotNameError, renameSlot, removeSlot } from '../../lib/export-template-editor';

const labelFor = (key) => fieldLabels[key] || key;
const fixedFields = new Set(['op', 'format', 'policy', 'onAbsent', 'onInvalid', 'field', 'code', 'question']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function Scalar({ value, label, onChange, fixedType = false, validationError = '', disabled = false, labelHidden = false }) {
  const type = value === null ? 'null' : typeof value;
  const [invalid, setInvalid] = useState('');
  const control = useRef(null);
  const messageId = useId();
  useEffect(() => { control.current?.setCustomValidity(invalid ? 'Введіть скінченне число' : validationError); }, [invalid, validationError, type]);
  return <fieldset disabled={disabled} className="space-y-1">
    <label className="block text-sm"><span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
      {type === 'boolean' ? <select className="input" value={String(value)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Так</option><option value="false">Ні</option>
      </select> : type === 'null' ? <span className="block text-slate-500">null — відсутнє значення</span>
        : <textarea ref={control} className="input min-h-10" rows={String(value).length > 100 ? 3 : 1}
          value={invalid || String(value)} aria-invalid={Boolean(invalid || validationError)} aria-describedby={invalid || validationError ? messageId : undefined} onChange={(e) => {
            const raw = e.target.value;
            if (type === 'number' && (!raw.trim() || !Number.isFinite(Number(raw)))) { e.target.setCustomValidity('Введіть скінченне число'); setInvalid(raw || ' '); return; }
            e.target.setCustomValidity('');
            setInvalid(''); onChange(type === 'number' ? Number(raw) : raw);
          }} />}
    </label>
    {!fixedType && <label className="block text-xs text-slate-500">Тип: {label}
      <select className="ml-2 rounded border" value={type} onChange={(e) => {
        setInvalid(''); onChange(({ string: '', number: 0, boolean: false, null: null })[e.target.value]);
      }}><option value="string">Текст</option><option value="number">Число</option><option value="boolean">Так/ні</option><option value="null">null</option></select>
    </label>}
    {(invalid || validationError) && <p id={messageId} role="alert" className="text-sm text-red-700">{invalid ? `${label}: введіть скінченне число. Незавершене значення ще не внесено до визначення.` : validationError}</p>}
  </fieldset>;
}

function SourceSelect({ value, onChange, sources, registry, group, label }) {
  const entries = Object.entries(sources).filter(([, s]) => s.kind === 'product' || s.category === group);
  return <label className="block text-sm">{label}<select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
    {!entries.some(([id]) => id === value) && <option value={value}>{value} — невідоме джерело</option>}
    {entries.map(([id, s]) => {
      const q = registry?.references?.questions?.find((item) => item.category_code === s.category && item.key === s.key);
      return <option key={id} value={id}>{q?.label || labelFor(s.field || s.key)} · {s.kind} · {s.category || 'товар'} · {s.key || s.field} · {registry?.units?.[s.field] || 'збережене значення'} ({id})</option>;
    })}
  </select></label>;
}

function RuleForm({ value, onChange, context }) {
  const [source, setSource] = useState('');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return <p>Невідома структура видимості збережена без змін: {JSON.stringify(value)}</p>;
  const remove = (key) => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)));
  return <fieldset className="space-y-3 rounded border p-3"><legend>Зафіксована видимість</legend>
    {!Object.keys(value).length && <p className="text-sm">Без обмежень видимості</p>}
    {Object.entries(value).map(([key, item]) => <div key={key} className="space-y-2">
      {['$and', '$or'].includes(key) && Array.isArray(item) ? <div className="space-y-2"><p>{key === '$and' ? 'Усі гілки' : 'Будь-яка гілка'}</p>
        {item.map((branch, i) => <div key={i}><RuleForm value={branch} context={context} onChange={(next) => onChange({ ...value, [key]: item.map((b, j) => j === i ? next : b) })} />
          <button type="button" className="underline text-xs" onClick={() => onChange({ ...value, [key]: item.filter((_, j) => j !== i) })}>Вилучити гілку {i + 1}</button></div>)}
        <button type="button" className="underline" onClick={() => onChange({ ...value, [key]: [...item, {}] })}>Додати гілку</button>
      </div> : <ValueForm value={item} label={`Видимість: ${key}`} context={context} path="values" onChange={(next) => onChange({ ...value, [key]: next })} />}
      <button type="button" className="underline text-xs" onClick={() => remove(key)}>Вилучити умову {key}</button>
    </div>)}
    <label className="block">Джерело нової умови<select className="input" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Оберіть джерело</option>
      {Object.entries(context.definition.sources).filter(([, s]) => s.category === context.group).map(([id, s]) => <option value={id} key={id}>{s.key} · {s.kind} ({id})</option>)}
    </select></label>
    <button type="button" className="btn btn-outline px-2" disabled={!source || Object.hasOwn(value, source)} onClick={() => { onChange({ ...value, [source]: null }); setSource(''); }}>Додати умову видимості</button>
    <div className="flex gap-2">{['$and', '$or'].filter((key) => !Object.hasOwn(value, key)).map((key) => <button type="button" className="underline text-sm" key={key} onClick={() => onChange({ ...value, [key]: [{}] })}>{key === '$and' ? 'Додати «усі гілки»' : 'Додати «будь-яка гілка»'}</button>)}</div>
  </fieldset>;
}

function TableEntries({ table, onChange }) {
  const [key, setKey] = useState('');
  return <div className="space-y-3">{Object.entries(table).map(([id, value]) => <div key={id}>
    <Scalar value={value} label={`ID ${id}`} fixedType onChange={(next) => onChange({ ...table, [id]: next })} />
    <button type="button" className="text-xs underline" onClick={() => onChange(Object.fromEntries(Object.entries(table).filter(([k]) => k !== id)))}>Вилучити відповідність {id}</button>
  </div>)}
    <label className="block">Новий семантичний ID<input className="input" value={key} onChange={(e) => setKey(e.target.value)} /></label>
    <button type="button" className="btn btn-outline px-2" disabled={!key || Object.hasOwn(table, key) || ['__proto__', 'constructor', 'prototype'].includes(key)} onClick={() => { onChange({ ...table, [key]: '' }); setKey(''); }}>Додати відповідність</button>
  </div>;
}

function SlotControls({ node, onChange, context }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('literal');
  const [source, setSource] = useState('');
  const [table, setTable] = useState('');
  const [renames, setRenames] = useState({});
  const error = name ? slotNameError(name, node.slots) : '';
  const sources = Object.entries(context.definition.sources).filter(([, s]) => (s.kind === 'product' || s.category === context.group) && s.type !== 'boolean');
  const tables = Object.entries(context.definition.tables).filter(([, entries]) => Object.values(entries).every((v) => typeof v === 'string'));
  const add = () => {
    const input = { op: 'source', id: source };
    const value = kind === 'literal' ? { op: 'literal', value: '' } : kind === 'lookup'
      ? { op: 'lookup', input: { op: 'semanticKey', input }, table, otherwise: { op: 'literal', value: '' } }
      : { op: 'text', input, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
    onChange({ ...node, slots: { ...node.slots, [name]: value } }); setName('');
  };
  return <div className="space-y-3 rounded border p-3">
    <p className="text-sm">Локальні підстановки цього виразу. Додайте підстановку, а потім явно вставте її в текст. Спільні таблиці залишаються спільними.</p>
    {Object.keys(node.slots).map((slot) => <div key={slot} className="space-y-1">
      <label className="block">Нова назва підстановки {slot}<input className="input" value={renames[slot] ?? slot} onChange={(e) => setRenames({ ...renames, [slot]: e.target.value })} /></label>
      {renames[slot] && slotNameError(renames[slot], node.slots, slot) && <p role="alert">{slotNameError(renames[slot], node.slots, slot)}</p>}
      <button type="button" className="underline text-sm" disabled={!renames[slot] || renames[slot] === slot || Boolean(slotNameError(renames[slot], node.slots, slot))}
        onClick={() => onChange(renameSlot(node, slot, renames[slot]))}>Перейменувати {slot} та оновити посилання в тексті</button>
      <button type="button" className="block underline text-sm" disabled={node.template.includes(`{${slot}}`)} onClick={() => onChange(removeSlot(node, slot))}>Вилучити підстановку {slot}</button>
      {node.template.includes(`{${slot}}`) && <p className="text-xs">Перед вилученням явно приберіть {`{${slot}}`} з тексту.</p>}
    </div>)}
    <label className="block">Назва нової підстановки<input className="input" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <label className="block">Вираз нової підстановки<select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
      <option value="literal">Текст</option><option value="source">Текст зі збереженого джерела</option><option value="lookup">Джерело через таблицю відповідностей</option>
    </select></label>
    {kind !== 'literal' && <label className="block">Джерело нової підстановки<select className="input" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Оберіть джерело</option>
      {sources.map(([id, s]) => <option key={id} value={id}>{labelFor(s.key || s.field)} ({id})</option>)}
    </select></label>}
    {kind === 'lookup' && <label className="block">Таблиця нової підстановки<select className="input" value={table} onChange={(e) => setTable(e.target.value)}><option value="">Оберіть таблицю</option>
      {tables.map(([id]) => <option key={id}>{id}</option>)}
    </select></label>}
    <button type="button" className="btn btn-outline px-3" disabled={!name || Boolean(error) || Object.keys(node.slots).length >= 16 || (kind !== 'literal' && !sources.some(([id]) => id === source)) || (kind === 'lookup' && !tables.some(([id]) => id === table))} onClick={add}>Додати підстановку</button>
    {Object.keys(node.slots).length >= 16 && <p>Досягнуто серверну межу: 16 підстановок.</p>}
  </div>;
}

function ValueForm({ value, onChange, label, context, path = '', fixedType = false, newItem }) {
  if (value === null || typeof value !== 'object') return <Scalar value={value} label={label} onChange={onChange} fixedType={fixedType} />;
  if (Array.isArray(value)) return <fieldset className="space-y-2 rounded border p-2"><legend>{label}</legend>
    {value.map((item, index) => <div className="space-y-1 border-l-2 pl-2" key={index}>
      <ValueForm value={item} label={`${label} ${index + 1}`} context={context} path={`${path}.${index}`}
        onChange={(next) => onChange(value.map((v, i) => i === index ? next : v))} fixedType={fixedType} />
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" disabled={!index} onClick={() => onChange(moveItem(value, index, -1))}>Вище: {label} {index + 1}</button>
        <button type="button" disabled={index === value.length - 1} onClick={() => onChange(moveItem(value, index, 1))}>Нижче: {label} {index + 1}</button>
        <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))}>Вилучити: {label} {index + 1}</button>
      </div>
    </div>)}
    <button type="button" className="btn btn-outline px-2" disabled={!value.length && newItem === undefined && !['values', 'allowed'].includes(path.split('.').at(-1))}
      onClick={() => onChange([...value, value.length ? copyDefinition(value.at(-1)) : newItem !== undefined ? copyDefinition(newItem) : ''])}>Додати: {label}</button>
  </fieldset>;
  if (value.op && (!operationLabels[value.op]
    || (value.op === 'interpolate' && (typeof value.template !== 'string' || !record(value.slots)))
    || (value.op === 'literal' && !Object.hasOwn(value, 'value')))) return <div className="rounded border p-2" role="note">
    Непідтримувана операція «{value.op}»: лише читання, буде збережена без змін.
    <pre className="overflow-auto text-xs">{JSON.stringify(value, null, 2)}</pre>
  </div>;
  const update = (key, next) => onChange({ ...value, [key]: next });
  if (value.op === 'ref') {
    const binding = context.definition.bindings?.find((b) => b.id === value.id);
    return <div className="rounded border bg-amber-50 p-3 space-y-2"><p>{label}: спільне правило <code>{value.id}</code></p>
      <button type="button" className="underline" onClick={() => context.openBinding(value.id)}>Відкрити спільне правило {value.id}</button>
      {binding && value.id !== 'sku' && <button type="button" className="block underline" onClick={() => onChange(copyDefinition(binding.value))}>
        Створити локальну копію правила {value.id}
      </button>}
      <p className="text-xs">Локальна копія змінює лише це посилання; вкладені посилання й таблиці залишаються спільними.</p>
    </div>;
  }
  return <fieldset className="min-w-0 space-y-3 rounded border border-slate-200 p-3">
    <legend className="max-w-full break-words text-sm font-semibold">{label}{value.op ? ` · ${operationLabels[value.op]}` : ''}</legend>
    {Object.entries(value).filter(([key]) => key !== 'op').map(([key, item]) => {
      const fieldLabel = labelFor(key);
      if (value.op === 'source' && key === 'id') return <SourceSelect key={key} label="Джерело" value={item} onChange={(next) => update(key, next)} {...context} sources={context.definition.sources} />;
      if (value.op === 'lookup' && key === 'table') return <div key={key}><label className="block text-sm">Таблиця відповідностей<select className="input" value={item} onChange={(e) => update(key, e.target.value)}>
        {Object.keys(context.definition.tables || {}).map((name) => <option key={name}>{name}</option>)}
      </select></label><button type="button" className="underline text-sm" onClick={() => context.openTable(item)}>Редагувати спільну таблицю {item}</button></div>;
      if (value.op === 'interpolate' && key === 'template') {
        const declared = Object.keys(value.slots);
        const used = [...item.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
        const missing = declared.filter((slot) => !used.includes(slot));
        const unknown = used.filter((slot) => !declared.includes(slot));
        const validationError = missing.length || unknown.length || /[{}]/.test(item.replace(/\{[A-Za-z0-9_]+\}/g, ''))
          ? `Текст із підстановками: використайте оголошені слоти ${declared.map((s) => `{${s}}`).join(', ')} без невідомих слотів чи незакритих дужок.` : '';
        return <Scalar key={key} value={item} label={fieldLabel} fixedType validationError={validationError} onChange={(next) => update(key, next)} />;
      }
      if (value.op && fixedFields.has(key)) return <p key={key} className="break-words text-xs text-slate-500">{fieldLabel}: {String(item)} (контракт)</p>;
      const child = <ValueForm value={item} label={fieldLabel} context={context} path={`${path}.${key}`}
        newItem={key === 'bands' ? { min: null, max: null, minInclusive: true, maxInclusive: true, value: '' }
          : key === 'items' ? { op: 'literal', value: ['all', 'any'].includes(value.op) ? true : value.op === 'firstPresent' ? null : '' } : undefined}
        fixedType={['template', 'delimiter', 'allowed'].includes(key)} onChange={(next) => update(key, next)} />;
      return item && typeof item === 'object' ? <details key={key} className="et-advanced-branch"><summary>{fieldLabel} / {operationLabels[item.op] || 'Складене правило'}</summary>{child}</details> : <div key={key}>{child}</div>;
    })}
    {value.op === 'interpolate' && <SlotControls node={value} onChange={onChange} context={context} />}
  </fieldset>;
}

export function AdvancedDefinitionEditor({ definition, onChange, registry, readOnly = false, initialGroup = 0, initialRow = 0, initialColumn = 'name' }) {
  const [groupIndex, setGroupIndex] = useState(initialGroup);
  const [rowIndex, setRowIndex] = useState(initialRow);
  const [column, setColumn] = useState(initialColumn);
  const [bindingId, setBindingId] = useState('');
  const [tableId, setTableId] = useState('');
  const [section, setSection] = useState('columns');
  if (!definition?.groups || !Array.isArray(definition.groups) || definition.formatVersion !== 1
    || !record(definition.sources) || Object.values(definition.sources).some((s) => !record(s))
    || !record(definition.tables) || Object.values(definition.tables).some((t) => !record(t))
    || !record(definition.questionContracts) || Object.values(definition.questionContracts).some((q) => !record(q) || !record(q.rule) || !Array.isArray(q.allowed))
    || !Array.isArray(definition.bindings) || definition.bindings.some((b) => !record(b) || typeof b.id !== 'string' || !record(b.value))
    || definition.groups.some((g) => !record(g) || !Array.isArray(g.columns) || !Array.isArray(g.rows) || g.rows.some((r) => !record(r) || !record(r.cells)))
    || !['magento-declarative-1', 'magento-declarative-2'].includes(definition.evaluatorVersion) || !['magento-products-v1', 'magento-products-columns-v2'].includes(definition.outputContract)) {
    return <div role="note">Цей формат ще не підтримується формами. Визначення збережено без змін.
      <pre className="overflow-auto">{JSON.stringify(definition, null, 2)}</pre></div>;
  }
  const group = definition.groups[groupIndex];
  if (!group?.rows?.[rowIndex]) return <p>Непідтримувана структура групи збережена без змін.</p>;
  const row = group.rows[rowIndex];
  const change = (path, value) => onChange(replaceAt(definition, path, value));
  const context = { definition, registry, group: group.route,
    openBinding: (id) => { setBindingId(id); setSection('bindings'); },
    openTable: (id) => { setTableId(id); setSection('tables'); } };
  const bindingIndex = definition.bindings.findIndex((b) => b.id === bindingId);
  return <form id="template-definition-form" onSubmit={(e) => e.preventDefault()} className="space-y-4 break-words">
    <div className="grid gap-3 sm:grid-cols-3">
      <label>Група<select className="input" value={groupIndex} onChange={(e) => setGroupIndex(Number(e.target.value))}>
        {definition.groups.map((g, i) => <option key={g.route} value={i}>{g.name} ({g.route})</option>)}
      </select></label>
      <label>Рядок<select className="input" value={rowIndex} onChange={(e) => setRowIndex(Number(e.target.value))}><option value={0}>Базовий</option><option value={1}>EN</option></select></label>
      <label>Розділ редактора<select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
        <option value="columns">Колонки й значення</option><option value="bindings">Спільні правила</option><option value="tables">Спільні таблиці</option><option value="contracts">Обов’язковість і видимість</option><option value="sources">Джерела та одиниці</option>
      </select></label>
    </div>
    <p className="text-sm text-slate-600">Маршрути, склад колонок та ідентифікаційні SKU/мова/тип захищені. Порожні EN-комірки не успадковують базові значення.</p>
    {section === 'columns' && <>
      <label>Колонка<select className="input" value={column} onChange={(e) => setColumn(e.target.value)}>
        {!group.columns.includes(column) && <option value={column}>Оберіть колонку</option>}
        {group.columns.map((key) => <option key={key} value={key}>{labelFor(key)} ({key})</option>)}
      </select></label>
      <fieldset disabled={readOnly} className="space-y-3">
        <div className="flex gap-3"><button type="button" className="btn btn-outline px-3" disabled={group.columns.indexOf(column) <= 0}
          onClick={() => change(['groups', groupIndex, 'columns'], moveItem(group.columns, group.columns.indexOf(column), -1))}>Перемістити колонку вище</button>
        <button type="button" className="btn btn-outline px-3" disabled={group.columns.indexOf(column) < 0 || group.columns.indexOf(column) === group.columns.length - 1}
          onClick={() => change(['groups', groupIndex, 'columns'], moveItem(group.columns, group.columns.indexOf(column), 1))}>Перемістити колонку нижче</button></div>
        <p className="text-xs break-words">Порядок: {group.columns.join(' → ')}</p>
        {protectedCells.has(column) ? <p>Захищене ідентифікаційне поле: {column}.</p>
          : Object.hasOwn(row.cells, column) ? <ValueForm value={row.cells[column]} label={labelFor(column)} context={context}
            onChange={(next) => change(['groups', groupIndex, 'rows', rowIndex, 'cells', column], next)} />
            : <><p>Порожня комірка. У визначенні відсутня; виводиться порожній текст.</p>
              {group.columns.includes(column) && <button type="button" className="btn btn-outline px-3" onClick={() => change(['groups', groupIndex, 'rows', rowIndex, 'cells', column], { op: 'literal', value: '' })}>Додати текст у цю комірку</button>}</>}
        {Object.hasOwn(row.cells, column) && !['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type'].includes(column) && <button type="button" className="underline text-sm" onClick={() => change(['groups', groupIndex, 'rows', rowIndex, 'cells'], Object.fromEntries(Object.entries(row.cells).filter(([key]) => key !== column)))}>Прибрати значення комірки (порожній вивід)</button>}
      </fieldset>
    </>}
    {section === 'bindings' && <>
      <label>Спільне правило<select className="input" value={bindingId} onChange={(e) => setBindingId(e.target.value)}><option value="">Оберіть правило</option>
        {definition.bindings.map((b) => <option key={b.id} value={b.id}>{b.group} · {labelFor(b.id.split('.').at(-1))} ({b.id})</option>)}
      </select></label>
      {bindingIndex >= 0 && <><p className="rounded bg-amber-50 p-3 text-sm">Спільна зміна вплине на: {consumers(definition, 'ref', bindingId).join('; ') || 'лише перевірки або незадіяне правило'}.</p>
        <fieldset disabled={readOnly || bindingId === 'sku'}><ValueForm value={definition.bindings[bindingIndex].value} label={`Правило ${bindingId}`}
          context={{ ...context, group: definition.bindings[bindingIndex].group }} onChange={(next) => change(['bindings', bindingIndex, 'value'], next)} /></fieldset></>}
    </>}
    {section === 'tables' && <>
      <label>Спільна таблиця<select className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}><option value="">Оберіть таблицю</option>
        {Object.keys(definition.tables).map((name) => <option key={name}>{name}</option>)}
      </select></label>
      {Object.hasOwn(definition.tables, tableId) && <><p className="rounded bg-amber-50 p-3 text-sm">Спільна зміна вплине на: {consumers(definition, 'table', tableId).join('; ') || 'незадіяну таблицю'}.</p>
        <fieldset disabled={readOnly} className="space-y-3">
          <button type="button" className="btn btn-outline px-3" onClick={() => {
            let index = 1; while (Object.hasOwn(definition.tables, `${tableId}.copy${index}`)) index++;
            const id = `${tableId}.copy${index}`;
            change(['tables'], { ...definition.tables, [id]: copyDefinition(definition.tables[tableId]) }); setTableId(id);
          }}>Створити окрему копію таблиці</button>
          <p className="text-xs">Копія не змінює споживачів. Щоб використати її локально, оберіть цю копію в потрібному правилі; для комірки спочатку створіть локальну копію правила.</p>
          <TableEntries key={tableId} table={definition.tables[tableId]} onChange={(next) => change(['tables', tableId], next)} />
        </fieldset></>}
    </>}
    {section === 'contracts' && <div className="space-y-3">{Object.entries(definition.questionContracts).filter(([, q]) => definition.sources[q.source]?.category === group.route).map(([id, contract]) =>
      <details key={id} className="rounded border p-3"><summary>{id} · {contract.required ? 'обов’язкове' : 'необов’язкове'}</summary>
        <p className="text-xs">Джерело: {contract.source}; наявність у момент фіксації: {String(contract.exists)}. Поточний каталог не оновлює ці правила автоматично.</p>
        <fieldset disabled={readOnly} className="space-y-3 mt-3">
          <Scalar value={contract.required} label="Обов’язкове" fixedType onChange={(v) => change(['questionContracts', id, 'required'], v)} />
          <RuleForm value={contract.rule} context={context} onChange={(v) => change(['questionContracts', id, 'rule'], v)} />
          <ValueForm value={contract.allowed} label="Зафіксовані семантичні ID" context={context} fixedType path="allowed" onChange={(v) => change(['questionContracts', id, 'allowed'], v)} />
        </fieldset>
      </details>)}</div>}
    {section === 'sources' && <ul className="space-y-3">{Object.entries(definition.sources).filter(([, s]) => s.kind === 'product' || s.category === group.route).map(([id, source]) =>
      <li key={id} className="rounded border p-3 break-words"><strong>{id}</strong> · {source.kind} · {source.category || 'товар'} · {source.key || source.field}
        <p className="text-sm">{registry?.units?.[source.field] || 'Збережені значення; без перетворення одиниць'}</p>
        {source.aliases?.length > 0 && <p>Аліаси збережені без змін; сервер перевіряє їх походження: {JSON.stringify(source.aliases)}</p>}
      </li>)}</ul>}
    <details><summary>Технічне визначення (лише читання)</summary><pre className="max-h-96 overflow-auto text-xs">{JSON.stringify(definition, null, 2)}</pre></details>
  </form>;
}
