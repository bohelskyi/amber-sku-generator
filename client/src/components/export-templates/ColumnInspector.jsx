import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COLUMN_CONTRACT, applyDirectColumn, availableSources, columnChange, directColumn, requiredColumns } from '../../lib/export-template-columns';
import { fieldLabels, protectedCells } from '../../lib/export-template-editor';
import { at } from '../../lib/export-template-presentation';
import { columnIntent, intentNames, ruleSources, ruleTransformTarget, transformColumnRule } from '../../lib/export-template-intent';
import { FieldInspector } from './RuleEditor';
import { AdvancedDefinitionEditor } from './AdvancedDefinitionEditor';
import { ColumnValueForm } from './ColumnForm';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';
import { categoryNames } from '../../lib/export-template-categories';
import { SourceSupportStatus } from './SourceSupportStatus';
import { ColumnTechnicalDetails } from './ColumnTechnicalDetails';
import { RuleSummary } from './RuleSummary';
import MagentoPlacementRuleEditor from './MagentoPlacementRuleEditor.jsx';

// One detached transaction across the normal, technical and advanced surfaces.
// Opening/closing a surface never runs a definition adapter without an actual edit.
export function ColumnInspector({ integration = false, embedded = false, localOnly = false, simple = false, textOnly = false, title, definition, groupIndex, rowIndex, column, registry, readOnly, loadSource, diagnostics, sourceId, overlay, suspended, onApply, onCancel, onRequestClose, onPendingChange }) {
  const fieldTitle = integration ? 'Налаштування поля' : 'Налаштування колонки';
  const [base] = useState(definition);
  const [draft, setDraft] = useState(definition);
  const [secondary, setSecondary] = useState(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [editingLabel, setEditingLabel] = useState(false);
  const [intentOverride, setIntentOverride] = useState(null);
  const [transformation, setTransformation] = useState(null);
  const path = ['groups', groupIndex, 'rows', rowIndex, 'cells', column];
  const getDirect = (d) => !protectedCells.has(column) && columnIntent(d, path) !== 'complex' ? directColumn(d, path) : null;
  const [initialValue, setInitialValue] = useState(() => getDirect(definition));
  const [value, setValue] = useState(initialValue);
  const group = draft.groups[groupIndex];
  const placementEditor = integration && column === 'categories';
  const mode = intentOverride || (value ? value.mode === 'literal' ? 'literal' : 'characteristic' : columnIntent(draft, path));
  const modal = !embedded && (overlay || mode === 'condition');
  const surface = useRef(null); const secondarySurface = useRef(null); const active = useRef(null); const returnFocus = useRef(null);
  const pending = touched || JSON.stringify(draft) !== JSON.stringify(base) || JSON.stringify(value) !== JSON.stringify(initialValue);
  useLayoutEffect(() => { active.current = { readOnly, suspended, secondary }; return () => { active.current = null; }; }, [readOnly, suspended, secondary]);
  const editable = () => active.current && !active.current.readOnly && !active.current.suspended;
  const change = (next, origin = secondary) => { if (!editable() || active.current.secondary !== origin) return; setDraft(next); setTouched(true); };
  const changeValue = (next, origin = secondary) => { if (editable() && active.current.secondary === origin) setValue(next); };
  useEffect(() => { onPendingChange(pending); return () => onPendingChange(false); }, [pending, onPendingChange]);
  const valid = () => [...(secondary ? secondarySurface : surface).current?.querySelectorAll('input,textarea,select') || []].every((control) => control.reportValidity());
  const materialized = () => initialValue && JSON.stringify(value) !== JSON.stringify(initialValue) ? applyDirectColumn(draft, groupIndex, rowIndex, column, value, registry) : draft;
  const refresh = (next) => { const direct = getDirect(next); setDraft(next); setInitialValue(direct); setValue(direct); setIntentOverride(null); };
  const changeIntent = (intent) => {
    if (intent === 'complex') { openSecondary('advanced'); return; }
    if (intent === mode) return;
    if (!editable() || !valid()) return;
    try {
      const before = materialized();
      const target = ruleTransformTarget(before, path);
      const next = transformColumnRule(before, path, intent);
      const direct = intent === 'characteristic' ? directColumn(next, path) : null;
      if (intent === 'characteristic' && !direct) throw new Error('Для цієї колонки змініть характеристику через розширені правила.');
      setTransformation({ definition: before, expression: target?.node, from: mode, to: intent });
      refresh(next); setTouched(true); setIntentOverride(intent === 'empty' ? 'empty' : null);
      if (intent === 'characteristic') {
        // Pending selection is intentionally incomplete until the operator picks
        // a characteristic/output mode. Apply validates it via the same adapter.
        setValue({ ...direct, mode: 'source', source: '', output: '' });
      }
      setError('');
    } catch (e) { setError(e.message); }
  };
  const apply = () => {
    if (!editable() || active.current.secondary !== secondary || !valid()) return false;
    try {
      const next = secondary === 'advanced' ? draft : materialized();
      const currentBase = JSON.stringify(base) === JSON.stringify(definition) ? definition : base;
      if (onApply(next, currentBase) === false) { setError('Чернетка змінилася. Незастосоване введення збережено; закрийте його явно перед повторним відкриттям.'); return false; }
      return true;
    } catch (e) { setError(e.message); return false; }
  };
  const openSecondary = (name) => {
    if (!active.current || active.current.secondary !== secondary || suspended) return;
    if (!valid()) return;
    try {
      if (!secondary && surface.current?.contains(document.activeElement)) returnFocus.current = document.activeElement;
      // Technical uses the same pending source form, including an unchosen output
      // mode. It must be possible to explicitly choose raw-ID output there.
      if (name !== 'technical') refresh(secondary === 'advanced' ? draft : materialized());
      setSecondary(name); setError('');
    }
    catch (e) { setError(e.message); }
  };
  const closeSecondary = () => {
    if (!valid()) return;
    try { if (secondary === 'advanced' || !value) refresh(draft); setSecondary(null); setError(''); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { if (!modal) surface.current?.focus(); }, [modal]);
  const capture = (origin) => { if (editable() && active.current.secondary === origin) setTouched(true); };
  const footer = <footer className="et-inspector-footer et-actions">{!readOnly && <><button type="button" className="btn btn-primary px-3" onClick={apply}>{simple ? 'Готово' : 'Застосувати до чернетки'}</button><button type="button" className="btn btn-outline px-3" onClick={onCancel}>Скасувати</button></>}</footer>;
  const sources = [...new Set([...value?.source ? [value.source] : ruleSources(draft, at(draft, path)), ...sourceId ? [sourceId] : []])];
  const exceptional = sources.filter((id) => {
    const source = draft.sources[id]; const policy = draft.sourceSupport?.sources?.[`${source?.category}.${source?.key}`];
    return diagnostics?.some((d) => d.sourceId === id) || policy?.placeholder || policy?.deferredValues?.length;
  });
  const statusSources = mode === 'condition' ? sourceId ? [sourceId] : [] : exceptional.length ? exceptional : sources.slice(0, 1);
  const approved = availableSources(registry, group.route);
  const content = <section ref={surface} tabIndex={-1} aria-label={fieldTitle} className="et-inspector-content et-intent-editor" onKeyDown={(e) => { if (!modal && !secondary && e.key === 'Escape') { e.preventDefault(); onRequestClose(); } }} onChangeCapture={() => capture(null)}>
    <header><div className="et-row"><h2>{title || group.columnLabels?.[column] || fieldLabels[column] || column}</h2><button type="button" className="et-link" onClick={onRequestClose}>Закрити налаштування</button></div>
      {simple ? <p className="et-muted">{textOnly ? 'Текст для товарів' : 'Відповідність для товарів'} · {rowIndex === 1 ? 'англійською' : 'українською'}</p> : <p className="et-muted"><code>{column}</code> · {categoryNames[group.route]} · <strong>{rowIndex === 1 ? 'EN' : 'Основний'}</strong></p>}
      {!simple && draft.outputContract === COLUMN_CONTRACT && !readOnly && <button type="button" className="et-link" onClick={() => setEditingLabel(!editingLabel)}>{integration ? 'Змінити назву поля' : 'Змінити назву колонки'}</button>}
      {editingLabel && <label>{integration ? 'Назва поля' : 'Назва колонки'}<input className="input" maxLength={160} disabled={readOnly} value={group.columnLabels?.[column] ?? fieldLabels[column] ?? column} onChange={(e) => change(columnChange(draft, groupIndex, 'label', column, e.target.value), null)} /></label>}
      {!simple && requiredColumns.has(column) && <p className="et-muted">{integration ? 'Обов’язкове поле: код і наявність поля захищено.' : 'Обов’язкова колонка: код не можна перейменувати, колонку не можна видалити.'}{!protectedCells.has(column) && ' Правило заповнення можна редагувати.'}</p>}
    </header>
    {error && <p role="alert">{error}</p>}
    {simple && !textOnly && !placementEditor && ruleTransformTarget(draft, path) && <label>Брати значення<select className="input" disabled={readOnly || suspended} value={['literal', 'characteristic'].includes(mode) ? mode : 'advanced'} onChange={(e) => changeIntent(e.target.value)}><option value="characteristic">З нашої характеристики</option><option value="literal">Вписати вручну</option>{!['literal', 'characteristic'].includes(mode) && <option value="advanced" disabled>За налаштованим правилом</option>}</select></label>}
    {!placementEditor && !simple && <section aria-label="Спосіб формування значення"><label>Як формується значення<select className="input et-intent-name" value={mode} disabled={readOnly || protectedCells.has(column)} onChange={(e) => changeIntent(e.target.value)}>
      {Object.entries(intentNames).filter(([intent]) => ruleTransformTarget(draft, path) || intent === mode || intent === 'complex').map(([intent, name]) => <option key={intent} value={intent}>{name}</option>)}
    </select></label></section>}
    {transformation && <details className="et-transform-review" open><summary>Зміна способу заповнення: {intentNames[transformation.from]} → {intentNames[transformation.to]}</summary>
      <p>{transformation.to === 'condition' ? 'Поточне значення збережено як «Інакше». Налаштуйте першу умову нижче.' : transformation.to === 'fallback' ? 'Поточне значення збережено першим у списку.' : 'Перегляньте нове правило перед застосуванням. Попереднє правило буде замінено лише в цій колонці.'}</p>
      <RuleSummary definition={transformation.definition} expression={transformation.expression} registry={registry} loadSource={loadSource} />
      <p>Зміни ще не застосовано. «Скасувати» поверне початкове правило.</p>
      <button type="button" className="et-link" onClick={() => { refresh(transformation.definition); setTransformation(null); setIntentOverride(null); setError(''); }}>Скасувати зміну способу заповнення</button>
    </details>}
    <form id={secondary ? undefined : 'template-definition-form'} onSubmit={(e) => e.preventDefault()} className="et-column-form" aria-label="Налаштування правила">
      {placementEditor ? <MagentoPlacementRuleEditor definition={draft} cellPath={path} registry={registry} loadSource={loadSource} readOnly={readOnly || suspended || Boolean(secondary)} onChange={(next) => change(next, null)} onEditing={() => capture(null)} /> : mode === 'empty' ? <p>{integration ? 'Поле матиме порожній текст у цій мові.' : 'Цей рядок матиме порожню клітинку.'}</p> : mode === 'complex' && !protectedCells.has(column) ? <div className="et-custom-rule"><p>{integration ? 'Це поле використовує складне правило.' : 'Ця колонка використовує складне правило.'}</p><p>Власне правило збережено без змін.</p><button type="button" className="et-link" onClick={() => openSecondary('advanced')}>Відкрити розширені правила</button></div>
        : simple && textOnly && ['literal', 'text'].includes(mode) ? <FieldInspector integration={integration} simple focused textOnly localOnly definition={draft} cellPath={path} registry={registry} readOnly={readOnly || suspended} loadSource={loadSource} diagnostics={diagnostics} onChange={(next) => { change(next, null); refresh(next); }} onAdvanced={() => openSecondary('advanced')} onTechnical={() => openSecondary('technical')} />
          : value ? <ColumnValueForm integration={integration} focused definition={draft} registry={registry} group={group.route} value={value} loadSource={loadSource} readOnly={readOnly} onChange={(next) => changeValue(next, null)} />
            : <FieldInspector integration={integration} focused localOnly={localOnly} definition={draft} cellPath={path} registry={registry} readOnly={readOnly} loadSource={loadSource} diagnostics={diagnostics} openSource={sourceId} onChange={(next) => change(next, null)} onAdvanced={() => openSecondary('advanced')} onTechnical={() => openSecondary('technical')} />}
    </form>
    {!simple && !placementEditor && !['literal', 'empty'].includes(mode) && <RuleSummary definition={draft} expression={at(draft, path)} registry={registry} loadSource={loadSource} value={value} />}
    {footer}
    {!simple && mode !== 'literal' && statusSources.map((id) => <SourceSupportStatus key={id} compact definition={draft} sourceId={id} diagnostics={diagnostics}
      confirmed={approved.some((entry) => ['kind', 'category', 'key', 'field'].every((key) => entry.descriptor[key] === draft.sources[id]?.[key]))} onDetails={() => openSecondary('technical')} />)}
    <nav className="et-editor-tools" aria-label="Додаткові інструменти"><button type="button" className="et-link" onClick={() => openSecondary('technical')}>{simple ? 'Розширені налаштування' : 'Технічні подробиці'}</button>{!simple && <button type="button" className="et-link" onClick={() => openSecondary('advanced')}>{integration ? 'Розширені правила цього поля' : 'Розширені правила цієї колонки'}</button>}</nav>
  </section>;
  return <>
    {modal ? <WorkspaceDialog title={fieldTitle} className="et-inspector-dialog" onClose={onRequestClose} initialFocusRef={returnFocus} suspended={suspended || Boolean(secondary)}>{content}</WorkspaceDialog>
      : <aside hidden={suspended || Boolean(secondary)} className="et-column-drawer" aria-label={fieldTitle}>{content}</aside>}
    {secondary && <WorkspaceDialog title={secondary === 'advanced' ? 'Розширені правила' : 'Технічні подробиці'} className="et-technical-dialog" onClose={closeSecondary} suspended={suspended}>
      <section ref={secondarySurface} onChangeCapture={() => capture(secondary)} className="et-inspector-content">
        <h2>{secondary === 'advanced' ? 'Розширені правила' : 'Технічні подробиці'} · {group.columnLabels?.[column] || fieldLabels[column] || column}</h2>
        <p>{categoryNames[group.route]} · {column} · {rowIndex === 1 ? 'EN' : 'Основний'}</p>
        <button type="button" className="et-link" onClick={closeSecondary}>← Звичайні налаштування</button>
        {error && <p role="alert">{error}</p>}
        {secondary === 'advanced' ? <AdvancedDefinitionEditor definition={draft} onChange={change} registry={registry} readOnly={readOnly} initialGroup={groupIndex} initialRow={rowIndex} initialColumn={column} /> : <>
          {simple && <><label>Як формується значення<select className="input" value={mode} disabled={readOnly || protectedCells.has(column)} onChange={(e) => changeIntent(e.target.value)}>{Object.entries(intentNames).filter(([intent]) => ruleTransformTarget(draft, path) || intent === mode || intent === 'complex').map(([intent, name]) => <option key={intent} value={intent}>{name}</option>)}</select></label><button type="button" className="et-link" onClick={() => openSecondary('advanced')}>Розширені правила цього поля</button></>}
          {draft.outputContract === COLUMN_CONTRACT && <label>{integration ? 'Назва поля' : 'Назва колонки'}<input className="input" maxLength={160} disabled={readOnly} value={group.columnLabels?.[column] ?? fieldLabels[column] ?? column} onChange={(e) => change(columnChange(draft, groupIndex, 'label', column, e.target.value))} /></label>}
          {value ? <ColumnValueForm integration={integration} definition={draft} registry={registry} group={group.route} value={value} loadSource={loadSource} readOnly={readOnly} onChange={changeValue} />
            : <FieldInspector integration={integration} localOnly={localOnly} definition={draft} cellPath={path} registry={registry} readOnly={readOnly} loadSource={loadSource} diagnostics={diagnostics} openSource={sourceId} onChange={change} onAdvanced={() => openSecondary('advanced')} />}
          <ColumnTechnicalDetails definition={draft} expression={at(draft, path)} registry={registry} loadSource={loadSource} diagnostics={diagnostics} sourceId={sourceId} />
        </>}
        {footer}
      </section>
    </WorkspaceDialog>}
  </>;
}
