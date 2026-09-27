import { useEffect, useId, useRef, useState } from 'react';
import { columnSourceChoices, codeError, createColumn, applyDirectColumn } from '../../lib/export-template-columns';
import { mappingsForSource } from '../../lib/export-template-presentation';
import { SourcePicker } from './SourcePicker';
import { categoryNames } from '../../lib/export-template-categories';
import { MappingTableEditor } from './MappingTableEditor';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';
import { copyCurrentOptionLabels } from '../../lib/export-template-option-labels';
import { frozenNamesHelp } from './OptionNamesCopy';

export function ColumnValueForm({ definition, registry, group, value, onChange, readOnly, loadSource, focused = false }) {
  const choices = columnSourceChoices(definition, registry, group, value.source);
  const selected = choices.find((s) => s.id === value.source);
  const mappings = mappingsForSource(definition, value.source);
  const evidence = useSourceEvidence(selected?.descriptor || definition.sources[value.source], loadSource);
  const semantic = selected?.descriptor.kind === 'semantic';
  const ids = [...new Set([
    ...(registry?.references?.questions || []).filter((q) => q.category_code === group && q.key === selected?.descriptor.key).flatMap((q) => q.value_ids || []),
    ...(registry?.references?.schemas || []).filter((s) => s.category_code === group).flatMap((s) => s.questions.filter((q) => q.key === selected?.descriptor.key).flatMap((q) => q.value_ids || [])),
  ])];
  const update = (patch) => onChange({ ...value, ...patch });
  return <div className="et-column-form">
    {!focused && <label>Звідки брати значення<select className="input" disabled={readOnly} value={value.mode} onChange={(e) => update({ mode: e.target.value, text: value.text ?? '' })}>
      <option value="literal">Постійний текст</option><option value="source">Характеристика товару</option>
    </select></label>}
    {value.mode === 'literal' ? <><label>Текст у файлі<textarea className="input" rows={3} disabled={readOnly} value={value.text ?? ''} onChange={(e) => update({ text: e.target.value })} /></label>{!value.text && <p>Порожня клітинка</p>}</> : <>
      <SourcePicker registry={registry} group={group} choices={choices} value={value.source} showDetails={!focused} disabled={readOnly} onChange={(source) => update({ source, output: choices.find((entry) => entry.id === source)?.descriptor.kind === 'semantic' ? '' : 'raw', table: '', mappingEntries: undefined, namesCopied: false })} />
      <label>Як записувати значення<select className="input" disabled={readOnly || !selected} value={value.namesCopied ? 'labels' : semantic && value.output === 'raw' ? '' : value.output || ''} onChange={(e) => {
        const mode = e.target.value;
        const stored = value.mappingEntries ?? definition.tables[value.table];
        const mappingEntries = mode === 'labels' ? copyCurrentOptionLabels(evidence, stored)
          : mode === 'mapping' ? stored !== undefined ? structuredClone(stored) : semantic ? copyCurrentOptionLabels(evidence) : {} : undefined;
        update({ output: mode === 'labels' ? 'mapping' : mode, namesCopied: mode === 'labels', table: value.output === 'mapping' ? value.table : '', mappingEntries });
      }}>
        <option value="">Оберіть спосіб запису</option>
        {semantic ? <option value="labels" disabled={!Object.keys(copyCurrentOptionLabels(evidence)).length}>Як названо в характеристиці</option> : <option value="raw">Використати значення як є</option>}
        {(!focused || semantic || value.output === 'mapping') && <option value="mapping">Задати свої значення</option>}
      </select></label>
      {semantic && <>
        <p className="et-muted">{frozenNamesHelp}</p>
        {!evidence && <p>Назви завантажуються або недоступні. Власні значення можна задати вручну.</p>}
        {value.output === 'raw' && <p>{focused ? 'Збережений спосіб запису налаштовано в технічних подробицях.' : 'Налаштовано технічний вивід внутрішнього ID. Його можна змінити вище або переглянути в розширених налаштуваннях.'}</p>}
        {!focused && <details><summary>Технічні налаштування</summary>
          <p>Спеціальний режим для інтеграцій. Для звичайних полів Magento зазвичай використовуються назви або власні відповідності.</p>
          <button type="button" className="btn btn-outline px-3" disabled={readOnly} aria-pressed={value.output === 'raw'} onClick={() => update({ output: 'raw', namesCopied: false, table: '', mappingEntries: undefined })}>Внутрішній ID варіанта</button>
        </details>}
      </>}
      {value.output === 'mapping' && <>
        {!focused && <p>Де застосувати зміни: <strong>Лише ця колонка</strong></p>}
        <p className="et-muted">Перегляньте й за потреби змініть текст у таблиці. Для непідтвердженої назви додайте власний текст явно; інакше відповідності не буде.</p>
        {!focused && mappings.length > 0 && !readOnly && <details><summary>Взяти збережені відповідності</summary>
          <p>Виберіть явно. Подальші зміни стосуються лише цієї колонки.</p>
          {mappings.map((id, i) => <button type="button" className="et-link et-mapping-preset" key={id} onClick={() => update({ table: id, mappingEntries: structuredClone(definition.tables[id]), namesCopied: false })}>Використати набір {i + 1}: {Object.values(definition.tables[id]).slice(0, 3).map((v) => JSON.stringify(v)).join(' / ')}</button>)}
        </details>}
        <MappingTableEditor entries={value.mappingEntries ?? definition.tables[value.table] ?? {}} ids={ids} evidence={evidence} support={definition.sourceSupport?.sources?.[`${selected?.descriptor.category}.${selected?.descriptor.key}`]} readOnly={readOnly} showEvidence={!focused} technical={!focused} onChange={(mappingEntries) => update({ mappingEntries, namesCopied: false })} />
        {!focused && value.table && <details><summary>Технічна ідентичність відповідностей</summary><code>{value.table}</code></details>}
      </>}
    </>}
  </div>;
}

export function ColumnDialog({ title, children, onCancel, firstInput = false, suspended = false }) {
  const initial = useRef(null);
  return <WorkspaceDialog title={title} onClose={onCancel} initialFocusRef={initial} className="et-column-dialog" suspended={suspended}>
    <h2>{title}</h2><div ref={(element) => { initial.current = firstInput ? element?.querySelector('input') : null; }}>{children}</div>
  </WorkspaceDialog>;
}

const emptyValue = () => ({ mode: 'literal', text: '', source: '', output: '', table: '' });
export function NewColumnDialog({ definition, registry, groupIndex, rowIndex, anchor, onCreate, onCancel, readOnly, onPendingChange, loadSource, suspended }) {
  const group = definition.groups[groupIndex];
  const [value, setValue] = useState({ name: '', code: '', before: anchor ?? '' });
  const [rows, setRows] = useState([emptyValue(), emptyValue()]);
  const [selectedRow, setSelectedRow] = useState(rowIndex);
  const [other, setOther] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const committed = useRef(false);
  const form = useRef(null);
  const id = useId();
  const problem = codeError(value.code, group.columns);
  const pending = Boolean(value.name || value.code || value.before !== (anchor ?? '') || other || JSON.stringify(rows) !== JSON.stringify([emptyValue(), emptyValue()]));
  useEffect(() => { onPendingChange?.(pending); return () => onPendingChange?.(false); }, [pending, onPendingChange]);
  return <ColumnDialog title="Нова колонка" onCancel={onCancel} firstInput suspended={suspended}>
    <p>{categoryNames[group.route] || group.name} · налаштування {selectedRow === 1 ? 'EN' : 'Основного рядка'}.</p>
    <form ref={form} className="et-column-form" onSubmit={(e) => e.preventDefault()}>
      <label>Назва колонки<input className="input" maxLength={160} disabled={readOnly} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} /></label>
      <label>Код у CSV<input className="input" disabled={readOnly} value={value.code} aria-invalid={submitted && Boolean(problem)} aria-describedby={submitted && problem ? id + '-code' : undefined} onChange={(e) => setValue({ ...value, code: e.target.value })} /></label>
      {submitted && problem && <p id={id + '-code'} role="alert">{problem}</p>}
      <ColumnValueForm definition={definition} registry={registry} group={group.route} value={rows[selectedRow]} onChange={(next) => setRows(rows.map((row, i) => i === selectedRow ? next : row))} readOnly={readOnly} loadSource={loadSource} />
      <label>Позиція нової колонки<select className="input" disabled={readOnly} value={value.before} onChange={(e) => setValue({ ...value, before: e.target.value })}>
        {group.columns.map((c, i) => <option key={c} value={c}>{i + 1} · Перед {c}</option>)}<option value="">{group.columns.length + 1} · Наприкінці, після {group.columns.at(-1)}</option>
      </select></label>
      <fieldset><legend>Основний / EN</legend><p>Зараз налаштовується: {selectedRow === 1 ? 'EN' : 'Основний'}.</p>
        <label><input type="checkbox" checked={other} onChange={(e) => { setOther(e.target.checked); if (!e.target.checked) setSelectedRow(rowIndex); }} /> Налаштувати інший рядок окремо</label>
        {other ? <div className="et-actions">{['Основний', 'EN'].map((label, i) => <button key={label} type="button" aria-pressed={selectedRow === i} onClick={() => setSelectedRow(i)}>{label}</button>)}</div> : <p>Інший рядок залишиться порожнім. Успадкування немає.</p>}
      </fieldset>
      {error && <p id={id + '-form'} role="alert">{error}</p>}
      <footer className="et-actions"><button type="button" className="btn btn-primary px-3" disabled={readOnly} onClick={() => {
        if (committed.current || readOnly) return;
        setSubmitted(true); if (problem || !form.current.reportValidity()) return;
        try {
          let next = createColumn(definition, groupIndex, rowIndex, value.before || null, { ...value, ...rows[rowIndex] }, registry);
          if (other) next = applyDirectColumn(next, groupIndex, 1 - rowIndex, value.code, rows[1 - rowIndex], registry);
          committed.current = true;
          if (onCreate(next, value.code) === false) { committed.current = false; setError('Стан чернетки змінився. Перевірте форму й повторіть додавання.'); }
        } catch (e) { setError(e.message); }
      }}>Додати колонку</button><button type="button" className="btn btn-outline px-3" onClick={onCancel}>Скасувати</button></footer>
    </form>
    <p className="et-muted">Колонка додається локально. Потім натисніть «Зберегти чернетку».</p>
  </ColumnDialog>;
}
