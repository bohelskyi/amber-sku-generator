import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { availableSources, codeError, createColumn } from '../../lib/export-template-columns';
import { mappingsForSource } from '../../lib/export-template-presentation';

export function ColumnValueForm({ definition, registry, group, value, onChange, readOnly, preview = true, errorId }) {
  const choices = availableSources(registry, group);
  const mappings = mappingsForSource(definition, value.source);
  const selected = choices.find((s) => s.id === value.source);
  const update = (patch) => onChange({ ...value, ...patch });
  return <div className="et-column-form">
    <label>Чим заповнювати<select className="input" disabled={readOnly} value={value.mode} onChange={(e) => update({ mode: e.target.value, text: value.text ?? '' })}>
      <option value="literal">Постійний текст</option><option value="source">Характеристика товару</option>
    </select></label>
    {value.mode === 'literal' ? <label>Текст у файлі<textarea className="input" rows={3} disabled={readOnly} value={value.text ?? ''} onChange={(e) => update({ text: e.target.value })} /></label> : <>
      <label>Характеристика<select className="input" disabled={readOnly} aria-describedby={errorId} value={value.source || ''} onChange={(e) => update({ source: e.target.value, output: '', table: '' })}>
        <option value="">Оберіть перевірене джерело</option>{!selected && value.source && <option value={value.source}>{value.source} · немає в доступному реєстрі</option>}{choices.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select></label>
      <label>Як записувати<select className="input" disabled={readOnly || !selected} aria-describedby={errorId} value={value.output || ''} onChange={(e) => update({ output: e.target.value, table: '' })}>
        <option value="">Оберіть спосіб запису</option><option value="raw">{selected?.descriptor.kind === 'semantic' ? 'Збережений ID без заміни' : 'Збережене значення без заміни'}</option><option value="mapping">За таблицею відповідностей</option>
      </select></label>
      {value.output === 'mapping' && <>
        <label>Таблиця відповідностей<select className="input" disabled={readOnly} aria-describedby={errorId} value={value.table || ''} onChange={(e) => update({ table: e.target.value })}>
          <option value="">Оберіть відповідності</option>{mappings.map((id) => <option key={id} value={id}>{id}</option>)}
        </select></label>
        {!mappings.length && <p>Сумісних відповідностей немає. Власну таблицю можна налаштувати в розширених правилах.</p>}
        {preview && definition.tables[value.table] && <div className="et-table-scroll"><table aria-label="Відповідності для колонки"><thead><tr><th>Збережений ID</th><th>Текст у файлі</th></tr></thead>
          <tbody>{Object.entries(definition.tables[value.table]).map(([id, text]) => <tr key={id}><th scope="row">{id}</th><td>{text === '' ? 'Порожній текст' : text}</td></tr>)}</tbody></table></div>}
      </>}
      <p className="et-muted">Ключ джерела та його збережений ID — окремі від коду колонки CSV. Поточні назви варіантів і коди SKU не підставляються автоматично.</p>
    </>}
  </div>;
}

export function ColumnDialog({ title, children, onCancel, firstInput = false }) {
  const surface = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    (firstInput ? surface.current?.querySelector('input') : surface.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [firstInput]);
  return createPortal(<div className="et-column-backdrop"><section ref={surface} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="et-column-dialog" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key !== 'Tab') return;
    const fields = [...surface.current.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')];
    if (!fields.length) return;
    if (event.shiftKey && (document.activeElement === fields[0] || document.activeElement === surface.current)) { event.preventDefault(); fields.at(-1).focus(); }
    else if (!event.shiftKey && (document.activeElement === fields.at(-1) || document.activeElement === surface.current)) { event.preventDefault(); fields[0].focus(); }
  }}><h2>{title}</h2>{children}</section></div>, document.body);
}

export function NewColumnDialog({ definition, registry, groupIndex, rowIndex, anchor, onCreate, onCancel, readOnly, onPendingChange }) {
  const group = definition.groups[groupIndex];
  const [value, setValue] = useState({ name: '', code: '', mode: 'literal', text: '', source: '', output: '', table: '', before: anchor ?? '' });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const committed = useRef(false);
  const id = useId();
  const problem = codeError(value.code, group.columns);
  const pending = Boolean(value.name || value.code || value.text || value.source || value.mode !== 'literal' || value.before !== (anchor ?? ''));
  useEffect(() => { onPendingChange?.(pending); return () => onPendingChange?.(false); }, [pending, onPendingChange]);
  return <ColumnDialog title="Нова колонка" onCancel={onCancel} firstInput>
    <p>{group.name} ({group.route}) · {rowIndex === 1 ? 'EN' : 'Основний рядок'}. Інший рядок залишиться порожнім.</p>
    <div className="et-column-form">
      <label>Назва для редактора<input className="input" maxLength={160} disabled={readOnly} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} /></label>
      <label>Код колонки CSV<input className="input" disabled={readOnly} value={value.code} aria-invalid={submitted && Boolean(problem)} aria-describedby={submitted && problem ? id + '-code' : undefined} onChange={(e) => setValue({ ...value, code: e.target.value })} /></label>
      {submitted && problem && <p id={id + '-code'} role="alert">{problem}</p>}
      <label>Позиція нової колонки<select className="input" disabled={readOnly} value={value.before} onChange={(e) => setValue({ ...value, before: e.target.value })}>
        {group.columns.map((c, i) => <option key={c} value={c}>{i + 1} · Перед {c}</option>)}<option value="">{group.columns.length + 1} · Наприкінці, після {group.columns.at(-1)}</option>
      </select></label>
      <ColumnValueForm definition={definition} registry={registry} group={group.route} value={value} onChange={setValue} readOnly={readOnly} errorId={error ? id + '-form' : undefined} />
      {error && <p id={id + '-form'} role="alert">{error}</p>}
    </div>
    <footer className="et-actions"><button type="button" className="btn btn-primary px-3" disabled={readOnly} aria-describedby={error ? id + '-form' : undefined} onClick={() => {
      if (committed.current || readOnly) return;
      setSubmitted(true); if (problem) return;
      try {
        const next = createColumn(definition, groupIndex, rowIndex, value.before || null, value, registry);
        committed.current = true;
        if (onCreate(next, value.code) === false) { committed.current = false; setError('Стан чернетки змінився. Перевірте форму й повторіть додавання.'); }
      }
      catch (e) { setError(e.message); }
    }}>Додати колонку</button><button type="button" className="btn btn-outline px-3" onClick={onCancel}>Скасувати</button></footer>
    <p className="et-muted">Колонка додається до локальної чернетки. Збереження на сервері — кнопкою «Зберегти чернетку».</p>
  </ColumnDialog>;
}
