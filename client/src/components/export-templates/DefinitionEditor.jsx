import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { COLUMN_CONTRACT, codeError, columnChange } from '../../lib/export-template-columns';
import { ColumnDialog, NewColumnDialog } from './ColumnForm';
import { ColumnInspector } from './ColumnInspector';
import { CategoryTabs, TemplateDesignGrid } from './TemplateDesignGrid';
import { columnIntent } from '../../lib/export-template-intent';
import './export-template-editor.css';

function ColumnOperation({ definition, groupIndex, column, action, onApply, onCancel, onPendingChange, suspended }) {
  const group = definition.groups[groupIndex];
  const [code, setCode] = useState(action === 'rename' ? column : '');
  const [position, setPosition] = useState(group.columns.indexOf(column));
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const id = useId();
  useEffect(() => { onPendingChange(true); return () => onPendingChange(false); }, [onPendingChange]);
  const title = ({ rename: 'Перейменувати колонку', duplicate: 'Дублювати колонку', move: 'Перемістити колонку', remove: 'Видалити колонку' })[action];
  return <ColumnDialog title={title} onCancel={onCancel} firstInput suspended={suspended}>
    <p><strong>{group.columnLabels?.[column] || column}</strong> · <code>{column}</code></p>
    {['duplicate', 'rename'].includes(action) && <label>Код у CSV<input className="input" value={code} aria-invalid={Boolean(error)} aria-describedby={error ? id : undefined} onChange={(e) => setCode(e.target.value)} /></label>}
    {action === 'move' && <label>Перемістити на позицію<select className="input" value={position} onChange={(e) => setPosition(Number(e.target.value))}>{group.columns.map((entry, i) => <option key={entry} value={i}>{i + 1} · {i < group.columns.indexOf(column) ? 'Перед' : 'Після'} {entry}</option>)}</select></label>}
    {action === 'duplicate' && <p>Буде скопійовано обидва наявні правила: Основний та EN, разом із локальними відповідностями.</p>}
    {action === 'remove' && <p>Буде вилучено колонку «{column}» та обидва її правила — Основний і EN. Характеристика SKU Manager, дані товарів і глобальні історичні свідчення залишаються.</p>}
    {error && <p role="alert" id={id}>{error}</p>}
    <footer className="et-actions"><button type="button" className="btn btn-primary px-3" onClick={() => {
      if (submitted.current) return;
      try {
        if (['duplicate', 'rename'].includes(action)) { const problem = codeError(code, group.columns, action === 'rename' ? column : undefined); if (problem) throw new Error(problem); }
        const next = columnChange(definition, groupIndex, action, column, action === 'move' ? position : code);
        submitted.current = true;
        if (onApply(next) === false) { submitted.current = false; setError('Чернетка змінилася. Відкрийте дію знову.'); }
      } catch (e) { setError(e.message); }
    }}>{action === 'remove' ? 'Видалити колонку' : 'Застосувати до чернетки'}</button><button type="button" className="btn btn-outline px-3" onClick={onCancel}>Скасувати</button></footer>
  </ColumnDialog>;
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function DefinitionEditor({ definition, onChange, registry, readOnly = false, loadSource, diagnostics = [], focusField, onFieldSelect, onPendingChange, onEditingChange, visible = true }) {
  const [groupIndex, setGroupIndex] = useState(0);
  const [selection, setSelection] = useState(null);
  const [creation, setCreation] = useState(null);
  const [operation, setOperation] = useState(null);
  const [panelPending, setPanelPending] = useState(false);
  const [dialogPending, setDialogPending] = useState(false);
  const [transition, setTransition] = useState(null);
  const [overlay, setOverlay] = useState(() => window.innerWidth < 1270);
  const root = useRef(null); const active = useRef(null); const trigger = useRef(null); const epoch = useRef(0);
  const panelId = useId();
  useLayoutEffect(() => { active.current = { definition, selection, creation, operation, readOnly }; return () => { active.current = null; }; }, [definition, selection, creation, operation, readOnly]);
  const guardedChange = (next, base = definition) => {
    if (!active.current || active.current.readOnly || readOnly || active.current.definition !== base || active.current.selection !== selection || active.current.creation !== creation || active.current.operation !== operation) return false;
    if (JSON.stringify(next) !== JSON.stringify(base)) onChange(next);
    return true;
  };
  const close = () => { setSelection(null); setPanelPending(false); trigger.current?.focus(); };
  const request = (action) => { if (panelPending) setTransition(() => action); else action(); };
  const select = (column, rowIndex, sourceId) => { trigger.current = document.activeElement; setSelection({ column, rowIndex, sourceId, epoch: ++epoch.current }); };
  const openCreation = (anchor = null) => { if (readOnly || creation) return; request(() => { close(); setCreation({ groupIndex, rowIndex: selection?.rowIndex || 0, anchor }); }); };
  useEffect(() => {
    const update = () => { const width = root.current?.getBoundingClientRect().width || window.innerWidth - 48; setOverlay(width < 1220); };
    update(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (root.current) observer?.observe(root.current);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { onPendingChange?.(panelPending || dialogPending); return () => onPendingChange?.(false); }, [panelPending, dialogPending, onPendingChange]);
  useEffect(() => { onEditingChange?.(Boolean(selection || creation || operation)); return () => onEditingChange?.(false); }, [selection, creation, operation, onEditingChange]);
  useEffect(() => { if (!panelPending && !dialogPending) return; const warn = (e) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [panelPending, dialogPending]);
  useEffect(() => { if (selection) onFieldSelect?.({ groupIndex, rowIndex: selection.rowIndex, column: selection.column }); }, [groupIndex, selection, onFieldSelect]);
  const reveal = useEffectEvent(() => {
    if (focusField) request(() => { setGroupIndex(focusField.groupIndex); select(focusField.column, focusField.rowIndex, focusField.sourceId); });
  });
  useEffect(() => {
    // An explicit issue-navigation request must retain the mounted transaction
    // until the user resolves it, rather than remounting the whole editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reveal();
  }, [focusField]);
  const supported = definition?.formatVersion === 1 && ['magento-declarative-1', 'magento-declarative-2'].includes(definition.evaluatorVersion) && ['magento-products-v1', COLUMN_CONTRACT].includes(definition.outputContract)
    && Array.isArray(definition.groups) && Array.isArray(definition.bindings) && definition.bindings.every((binding) => record(binding) && typeof binding.id === 'string' && record(binding.value))
    && record(definition.sources) && Object.values(definition.sources).every(record) && record(definition.tables) && Object.values(definition.tables).every(record)
    && definition.groups.every((group) => record(group) && Array.isArray(group.columns) && group.columns.every((key) => typeof key === 'string') && Array.isArray(group.rows) && group.rows.every((row) => record(row) && record(row.cells)));
  if (!supported || !definition.groups[groupIndex]) return <div role="note">Цей формат ще не підтримується формами. Визначення збережено без змін.<details><summary>Технічне визначення</summary><pre>{JSON.stringify(definition, null, 2)}</pre></details></div>;
  const inspectorOverlay = overlay || Boolean(selection && columnIntent(definition, ['groups', groupIndex, 'rows', selection.rowIndex, 'cells', selection.column]) === 'condition');
  return <div ref={root} className="et-fields">
    <CategoryTabs groups={definition.groups} selected={groupIndex} panelId={panelId} onSelect={(index) => request(() => { close(); setGroupIndex(index); })} />
    <div role="tabpanel" id={panelId} aria-label={definition.groups[groupIndex].name} className={selection && !inspectorOverlay ? 'et-design-layout et-design-with-panel' : 'et-design-layout'}>
      <TemplateDesignGrid definition={definition} groupIndex={groupIndex} registry={registry} selected={selection} readOnly={readOnly} onCreate={() => openCreation()} onSelect={(code, row) => request(() => select(code, row))} onAction={(action, code) => {
        if (action === 'configure') { request(() => select(code, 0)); return; }
        if (action === 'left' || action === 'right') { const columns = definition.groups[groupIndex].columns; openCreation(action === 'left' ? code : columns[columns.indexOf(code) + 1] ?? null); return; }
        request(() => { close(); setOperation({ groupIndex, column: code, action }); });
      }} />
      {selection && <ColumnInspector key={groupIndex + '/' + selection.epoch} definition={definition} {...selection} groupIndex={groupIndex} registry={registry} readOnly={readOnly} loadSource={loadSource} diagnostics={diagnostics} overlay={inspectorOverlay} suspended={Boolean(transition) || !visible}
        onPendingChange={setPanelPending} onCancel={close} onRequestClose={() => request(close)} onApply={(next, base) => { if (!guardedChange(next, base)) return false; close(); return true; }} />}
    </div>
    <p className="et-design-caption">Основний і EN — незалежні правила, не приклади значень товарів. Категорія змінює лише вигляд.</p>
    {creation && <NewColumnDialog suspended={!visible} {...creation} definition={definition} registry={registry} loadSource={loadSource} readOnly={readOnly} onPendingChange={setDialogPending} onCancel={() => setCreation(null)} onCreate={(next, code) => {
      if (!guardedChange(next)) return false;
      setCreation(null); setGroupIndex(creation.groupIndex); setSelection(null);
      requestAnimationFrame(() => root.current?.querySelector(`[aria-label="Налаштувати колонку ${code}"]`)?.focus());
      return true;
    }} />}
    {operation && <ColumnOperation suspended={!visible} {...operation} definition={definition} onPendingChange={setDialogPending} onCancel={() => setOperation(null)} onApply={(next) => { if (!guardedChange(next)) return false; setOperation(null); return true; }} />}
    {transition && <ColumnDialog title="Незастосоване заповнення" onCancel={() => setTransition(null)}><p>Спочатку застосуйте або скасуйте введені налаштування. Інші локальні зміни чернетки збережено.</p><div className="et-actions"><button type="button" className="btn btn-primary px-3" onClick={() => setTransition(null)}>Залишитися</button><button type="button" className="btn btn-outline px-3" onClick={() => { const proceed = transition; setTransition(null); close(); proceed(); }}>Відкинути заповнення й перейти</button></div></ColumnDialog>}
  </div>;
}
