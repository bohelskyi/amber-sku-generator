import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fieldLabels, protectedCells } from '../../lib/export-template-editor';
import { requiredColumns, COLUMN_CONTRACT } from '../../lib/export-template-columns';
import { outputNode, resolveNode, sourceLabel, sourceOf } from '../../lib/export-template-presentation';
import { categoryNames } from '../../lib/export-template-categories';

function ruleSummary(definition, value, column, registry) {
  if (protectedCells.has(column)) return 'Захищене правило';
  if (!value) return 'Порожня клітинка';
  const root = resolveNode(definition, value).node;
  const { node } = outputNode(definition, value);
  if (!node) return 'Власне правило';
  if (node.op === 'literal') return node.value === '' ? 'Порожня клітинка' : node.value === null ? 'Відсутнє значення · null' : `Постійний ${typeof node.value === 'string' ? 'текст' : 'елемент'}: ${String(node.value)}`;
  if (node.op === 'lookup') return sourceLabel(definition, sourceOf(definition, node.input), registry) + ' → відповідності';
  if (node.op === 'interpolate') return `Текст із ${Object.keys(node.slots || {}).length} характеристик`;
  if (['when', 'require'].includes(root?.op)) return 'Умова';
  if (node.op === 'firstPresent') return 'Перше заповнене значення';
  if (node.op === 'numericBand') return 'Числові діапазони';
  if (node.op === 'join') return 'Текст із кількох частин';
  const source = definition.sources[sourceOf(definition, node)];
  if (source?.field === 'total_price_uah') return 'Збережена ціна';
  if (source?.kind === 'product') return 'З товару';
  if (source) return sourceLabel(definition, sourceOf(definition, node), registry);
  return 'Власне правило · розширені правила';
}

export function CategoryTabs({ groups, selected, onSelect, panelId }) {
  const id = useId();
  return <div role="tablist" aria-label="Категорії файлів" className="et-tabs">{groups.map((group, index) => <button key={group.route} type="button" role="tab" id={id + index} aria-controls={panelId} aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
    onClick={() => onSelect(index)} onKeyDown={(event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); onSelect(next); document.getElementById(id + next)?.focus();
    }}>{categoryNames[group.route] || group.name}</button>)}</div>;
}

function HeaderMenu({ menu, group, editable, onAction, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('button:not(:disabled)')?.focus();
    const outside = (e) => { if (!ref.current?.contains(e.target)) onClose(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [onClose]);
  const actions = [['configure', 'Налаштувати'], ['left', 'Додати ліворуч'], ['right', 'Додати праворуч'], ['duplicate', 'Дублювати'], ['move', 'Перемістити…'], ['rename', 'Перейменувати…'], ['remove', 'Видалити…']];
  return createPortal(<div ref={ref} role="menu" aria-label={'Дії колонки ' + menu.code} className="et-header-menu" style={{ left: Math.max(8, Math.min(menu.left, window.innerWidth - 270)), top: Math.max(8, Math.min(menu.top, window.innerHeight - 370)) }} onKeyDown={(e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(true); }
    if (e.key === 'Tab') { onClose(false); return; }
    const items = [...ref.current.querySelectorAll('button:not(:disabled)')]; const index = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index + items.length - 1) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (next !== null) { e.preventDefault(); items[next]?.focus(); }
  }}>{actions.map(([action, label]) => <button key={action} role="menuitem" type="button" disabled={!['configure', 'move'].includes(action) && (!editable || (['rename', 'remove'].includes(action) && requiredColumns.has(menu.code)) || (['left', 'right', 'duplicate'].includes(action) && group.columns.length >= 64))} onClick={() => { onClose(true); onAction(action, menu.code); }}>{label}</button>)}
    {requiredColumns.has(menu.code) && <small>Обов’язкову колонку не можна перейменувати або видалити.</small>}
  </div>, document.body);
}

export function TemplateDesignGrid({ definition, groupIndex, registry, selected, onSelect, onAction, readOnly, onCreate }) {
  const group = definition.groups[groupIndex];
  const [menu, setMenu] = useState(null);
  const [focus, setFocus] = useState({ row: selected?.rowIndex || 0, code: selected?.column || group.columns[0] });
  const root = useRef(null);
  const menuTrigger = useRef(null);
  const stableClose = useCallback((restore) => { setMenu(null); if (restore) menuTrigger.current?.focus(); }, []);
  useEffect(() => { if (selected) root.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [selected?.column, selected?.rowIndex, selected]);
  const moveFocus = (event, row, index) => {
    const nextRow = event.key === 'ArrowUp' ? Math.max(0, row - 1) : event.key === 'ArrowDown' ? Math.min(group.rows.length - 1, row + 1) : row;
    const nextColumn = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(group.columns.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? group.columns.length - 1 : index;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setFocus({ row: nextRow, code: group.columns[nextColumn] }); root.current.querySelector(`[data-rule-row="${nextRow}"][data-rule-column="${nextColumn}"]`)?.focus();
  };
  const focusCode = group.columns.includes(focus.code) ? focus.code : group.columns[0];
  return <section ref={root} className="et-grid et-design-grid" aria-label={(categoryNames[group.route] || group.name) + ' · структура CSV'}>
    <div className="et-grid-tools"><p>Правила майбутнього CSV · {group.columns.length} колонок</p>{!readOnly && definition.outputContract === COLUMN_CONTRACT && <button type="button" className="btn btn-outline px-3" onClick={onCreate}>+ Колонка</button>}</div>
    <div className="et-grid-scroll" tabIndex={0} aria-label="Прокручування таблиці" onScroll={() => setMenu(null)}>
      <table><caption className="sr-only">{categoryNames[group.route]}: правила Основного та EN рядків, не значення товарів</caption><thead><tr><th scope="col">Рядок</th>{group.columns.map((code) => <th scope="col" key={code}>
        <div className="et-header-code"><button type="button" aria-label={'Налаштувати колонку ' + code} onClick={() => onSelect(code, 0)}><code>{code}</code></button>
          {!readOnly && <button type="button" aria-label={'Дії колонки ' + code} aria-haspopup="menu" aria-expanded={menu?.code === code} onClick={(e) => { menuTrigger.current = e.currentTarget; const rect = e.currentTarget.getBoundingClientRect(); setMenu({ code, left: rect.left, top: rect.bottom }); }}>⋯</button>}</div>
        <small>{group.columnLabels?.[code] || fieldLabels[code] || code}</small>
        {requiredColumns.has(code) && <span className="et-protection" title="Код не можна перейменувати; колонку не можна видалити">◆ Обов’язкова колонка</span>}
        {protectedCells.has(code) && <span className="et-protection">▣ Захищене правило</span>}
      </th>)}</tr></thead><tbody>{group.rows.map((row, ri) => <tr key={row.id}><th scope="row">{ri === 1 ? 'EN' : 'Основний'}</th>{group.columns.map((code, ci) => <td key={code}>
        <button type="button" className="et-rule-cell" data-rule-row={ri} data-rule-column={ci} tabIndex={focus.row === ri && focusCode === code ? 0 : -1} aria-label={`${group.route} / ${code} / ${ri === 1 ? 'EN' : 'Основний'}`} aria-pressed={selected?.column === code && selected?.rowIndex === ri}
          onFocus={() => setFocus({ row: ri, code })} onKeyDown={(e) => moveFocus(e, ri, ci)} onClick={() => onSelect(code, ri)}>{ruleSummary(definition, row.cells[code], code, registry)}</button>
      </td>)}</tr>)}</tbody></table>
    </div>
    {menu && <HeaderMenu menu={menu} group={group} editable={!readOnly && definition.outputContract === COLUMN_CONTRACT} onClose={stableClose} onAction={onAction} />}
  </section>;
}
