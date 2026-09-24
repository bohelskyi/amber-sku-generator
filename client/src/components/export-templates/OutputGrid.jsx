import { useEffect, useRef, useState } from 'react';
import { fieldLabels } from '../../lib/export-template-editor';
import './export-template-editor.css';

// Presentation only. Values come from the authoritative CSV, never an evaluator.
export function OutputGrid({ columns, rows = [], labels = {}, rules, onColumn, revealColumn, title = 'Таблиця', children }) {
  const selectedHeader = useRef(null);
  useEffect(() => { selectedHeader.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [revealColumn]);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState(null);
  const pageSize = 50;
  const detailValue = detail && columns.includes(detail.code) ? rows[detail.rowIndex]?.values?.[columns.indexOf(detail.code)] : undefined;
  const activePage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return <section className="et-grid" aria-label={title}>
    <div className="et-grid-tools"><strong>{title}</strong>{children}</div>
    <div className="et-grid-scroll" tabIndex={0} aria-label="Прокручування таблиці">
      <table><thead><tr><th scope="col">Рядок</th>{columns.map((code) => <th scope="col" key={code}>
        {onColumn ? <button ref={code === revealColumn ? selectedHeader : undefined} type="button" aria-label={`Налаштувати колонку ${code}`} onClick={() => onColumn(code)}><code>{code}</code><span aria-hidden="true"> ▾</span></button> : <code>{code}</code>}
        <small>{labels[code] || fieldLabels[code] || code}</small>
      </th>)}</tr></thead><tbody>
        {rules && <tr className="et-grid-rules"><th scope="row">Правила · метадані редактора</th>{columns.map((code) => <td key={code}><button type="button" onClick={() => onColumn(code)}>{rules[code] || 'Порожня клітинка'}</button></td>)}</tr>}
        {rows.slice(activePage * pageSize, (activePage + 1) * pageSize).map((row, index) => <tr key={activePage * pageSize + index}><th scope="row">{row.label || activePage * pageSize + index + 1}</th>{columns.map((code, i) => <td key={code}>
          {row.placeholder ? <span className="et-muted">—</span> : <button className="et-grid-cell" type="button" aria-label={`Значення ${code}, рядок ${activePage * pageSize + index + 1}`} onClick={() => setDetail({ code, rowIndex: activePage * pageSize + index })}>{row.values[i] || <span className="et-muted">Порожньо</span>}</button>}
        </td>)}</tr>)}
      </tbody></table>
    </div>
    {rows.length > pageSize && <div className="et-actions"><button type="button" disabled={!activePage} onClick={() => setPage(activePage - 1)}>Попередні рядки</button><span>{activePage * pageSize + 1}–{Math.min(rows.length, (activePage + 1) * pageSize)} / {rows.length} · порядок файлу</span><button type="button" disabled={(activePage + 1) * pageSize >= rows.length} onClick={() => setPage(activePage + 1)}>Наступні рядки</button></div>}
    {detail && detailValue !== undefined && <div className="et-cell-detail" role="region" aria-label="Повне значення"><button type="button" autoFocus onClick={() => setDetail(null)}>Закрити значення</button><strong>{detail.code}</strong><pre>{detailValue === '' ? 'Порожня клітинка' : detailValue}</pre></div>}
  </section>;
}
