import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseReviewFile } from '../../lib/export-review-presentation';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';
import './export-data-grid.css';

const defaultWidth = (code) => /name|meta_|categories|description/.test(code) ? 320 : /sku|code|price|qty/.test(code) ? 140 : 200;
const targetsColumn = (issue, column) => issue.target?.column === column || issue.target?.columns?.includes(column);
const fileName = (file) => file.groupName || ({ BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри', prices: 'Ціни' })[file.groupCode] || file.groupCode;
const issueLabel = (issue) => issue.code === 'manual_name_review_required' ? 'Потрібна перевірка успадкованих назв'
  : issue.code === 'manual_name_required' ? 'Потрібно вказати назву'
  : ['decor_weight', 'vaha_vyrobu'].includes(issue.field || issue.target?.column) ? 'Потрібно перевірити вагу виробу'
    : (issue.field || issue.target?.column) === 'categories' ? 'Потрібно перевірити категорію Magento'
  : issue.field === 'price' ? 'Потрібно перевірити ціну'
    : issue.field === 'name' ? 'Потрібно перевірити назву'
      : issue.code === 'SOURCE_SUPPORT_INVALID' ? 'Ця версія не підтримує дані товару'
        : 'Потрібно перевірити дані товару';
export function ExportDataGrid({ files = [], identity, stored = false, loadFile, onDownload,
  onDenied, canDecode = false, onEditName, onHandoff, viewMemory }) {
  const tabsId = useId();
  const [group, setGroup] = useState(() => viewMemory?.read()?.group || ''); const [loaded, setLoaded] = useState({});
  const [loadError, setLoadError] = useState(''); const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(() => viewMemory?.read()?.search || ''); const [attention, setAttention] = useState(() => viewMemory?.read()?.attention || 'all');
  const [language, setLanguage] = useState(() => viewMemory?.read()?.language || 'all'); const [page, setPage] = useState(() => viewMemory?.read()?.page || 0);
  const [widths, setWidths] = useState(() => viewMemory?.read()?.widths || {}); const [widthColumn, setWidthColumn] = useState(null);
  const [focus, setFocus] = useState([0, 0]); const [detail, setDetail] = useState(null);
  const [notice, setNotice] = useState(''); const table = useRef(null);
  const selected = files.find((file) => file.groupCode === group) || files[0];
  const fileKey = `${identity}:${selected?.groupCode}`;
  const available = selected?.rows || typeof selected?.csvContent === 'string' || loaded[fileKey] !== undefined;
  useEffect(() => {
    if (!selected || available || !loadFile) return;
    let live = true;
    Promise.resolve().then(() => { if (live) setLoadError(''); return loadFile(selected.groupCode); })
      .then((csvContent) => { if (live) setLoaded((previous) => ({ ...previous, [fileKey]: { ...selected, csvContent } })); })
      .catch((error) => {
        if (!live) return;
        if ([401, 403, 404].includes(error.response?.status)) onDenied?.(error);
        setLoadError('Файли створено, але таблицю не вдалося завантажити.');
      });
    return () => { live = false; };
  }, [selected, available, fileKey, loadFile, onDenied, retry]);
  const parsed = useMemo(() => {
    if (!selected || !available) return { headers: [], rows: [] };
    try { return parseReviewFile(loaded[fileKey] || selected, stored); }
    catch (error) { return { headers: [], rows: [], error: error.message }; }
  }, [selected, available, loaded, fileKey, stored]);
  const rows = useMemo(() => parsed.rows.filter((row) => row.sku.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    && (attention === 'all' || row.readiness === 'attention') && (language === 'all' || language === row.language)), [parsed, search, attention, language]);
  const attentionCount = useMemo(() => new Set(files.flatMap((file) => (file.rows || []).filter((row) => row.readiness === 'attention').map((row) => row.productId ?? row.sku))).size, [files]);
  const categoryAttention = useMemo(() => Object.fromEntries(files.map((file) => [file.groupCode, new Set((file.rows || []).filter((row) => row.readiness === 'attention').map((row) => row.productId ?? row.sku)).size])), [files]);
  const activePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  useEffect(() => {
    viewMemory?.update({ group: selected?.groupCode || '', search, attention, language, page: available ? activePage : page, widths });
  }, [viewMemory, selected?.groupCode, search, attention, language, available, activePage, page, widths]);
  const visible = rows.slice(activePage * 50, (activePage + 1) * 50);
  const changeFilter = (setter, value) => { setter(value); setPage(0); setFocus([0, 0]); setDetail(null); };
  const chooseFile = (file) => { setGroup(file.groupCode); setPage(0); setFocus([0, 0]); setDetail(null); setNotice(''); setLoadError(''); };
  const navigateCell = (event, row, column) => {
    const directions = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (!directions[event.key]) return;
    event.preventDefault(); const [dr, dc] = directions[event.key];
    const next = [Math.max(0, Math.min(visible.length - 1, row + dr)), Math.max(0, Math.min(parsed.headers.length - 1, column + dc))];
    setFocus(next); table.current?.querySelector(`[data-cell="${next.join(':')}"]`)?.focus();
  };
  const detailRow = detail?.row; const detailCell = detailRow?.cells[detail.column];
  const issues = detailRow?.issues.filter((issue) => detail.column === undefined || targetsColumn(issue, parsed.headers[detail.column])) || [];
  if (!selected) return <p className="p-4">Немає доступних таблиць. Історичні файли не відтворюються за поточними правилами.</p>;
  return <section className="export-grid" aria-label={stored ? 'Збережені таблиці' : 'Майбутні таблиці'}>
    <div className="export-grid-tabs" role="tablist" aria-label="Файли">
      {files.map((file, index) => <button type="button" role="tab" key={file.groupCode} aria-selected={file === selected} aria-label={fileName(file)} aria-describedby={!stored && categoryAttention[file.groupCode] ? `${tabsId}-${file.groupCode}` : undefined}
        tabIndex={file === selected ? 0 : -1} onClick={() => chooseFile(file)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + files.length) % files.length;
          chooseFile(files[next]); event.currentTarget.parentElement.children[next].focus();
        }}>{fileName(file)}{!stored && categoryAttention[file.groupCode] > 0 && <span id={`${tabsId}-${file.groupCode}`} className="export-tab-count" aria-label={`${categoryAttention[file.groupCode]} потребують уваги`}>{categoryAttention[file.groupCode]}</span>}</button>)}
    </div>
    <div className="export-grid-toolbar">
      <label>Пошук SKU<input value={search} onChange={(e) => changeFilter(setSearch, e.target.value)} /></label>
      {!stored && <label>Готовність<select value={attention} onChange={(e) => changeFilter(setAttention, e.target.value)}><option value="all">Усі</option><option value="attention">Потребують уваги</option></select></label>}
      {selected.groupCode !== 'prices' && <label>Мова рядка<select value={language} onChange={(e) => changeFilter(setLanguage, e.target.value)}><option value="all">Усі рядки</option><option value="main">Основний</option><option value="en">EN</option></select></label>}
      <button type="button" className="btn btn-outline px-3" disabled={!parsed.headers.length} onClick={() => setWidthColumn(parsed.headers[0])}>Ширина колонок</button>
      {stored && onDownload && <button type="button" className="btn btn-outline px-3" onClick={async () => { setNotice(''); if (await onDownload(selected.groupCode) !== false) setNotice('Передано браузеру для завантаження'); }}>Завантажити CSV</button>}
    </div>
    {!!attentionCount && <button type="button" className="export-issue-summary" onClick={() => {
      const first = files.find((file) => file.rows?.some((row) => row.readiness === 'attention'));
      if (first) chooseFile(first); changeFilter(setAttention, 'attention');
    }}>{attentionCount} {new Intl.PluralRules('uk').select(attentionCount) === 'one' ? 'товар потребує' : new Intl.PluralRules('uk').select(attentionCount) === 'few' ? 'товари потребують' : 'товарів потребують'} уваги · усі категорії</button>}
    <details className="export-grid-note"><summary>Як читати таблицю</summary><p>Пошук, фільтри й ширина змінюють лише вигляд. Порядок CSV збережено. Закріплена смуга SKU / мова / стан не входить у CSV.</p>
      {!stored && <p>≈ Попереднє діагностичне значення · Не обчислено — немає достовірного значення · Порожньо — навмисна порожня клітинка готового рядка.</p>}</details>
    {notice && <p role="status">{notice}</p>}
    {loadError || parsed.error ? <div role="alert"><p>{loadError || (stored ? 'Файли створено, але таблицю не вдалося завантажити.' : parsed.error)}</p><button type="button" onClick={() => setRetry((n) => n + 1)}>Повторити завантаження таблиці</button></div>
      : !available ? <p role="status">Завантаження збереженої таблиці…</p> : <>
        {rows.length > 0 && <div className="export-grid-scroll" tabIndex={0} aria-label="Прокручування таблиці"><table ref={table}>
          <caption>{selected.fileName || selected.groupName || selected.groupCode} · {stored ? 'збережений CSV' : 'попередній перегляд'}</caption>
          <colgroup><col className="export-review-col" />{parsed.headers.map((code) => <col key={code} style={{ width: widths[code] || defaultWidth(code) }} />)}</colgroup>
          <thead><tr><th scope="col" className="export-review-rail">SKU · мова · стан</th>{parsed.headers.map((code) => <th scope="col" key={code}>{code}</th>)}</tr></thead>
          <tbody>{visible.map((row, rowIndex) => <tr key={row.ordinal} data-readiness={row.readiness}>
            <th scope="row" className="export-review-rail"><span className="export-row-sku" title={row.sku}>{row.sku}</span><span>#{row.ordinal} · {row.language === 'en' ? 'EN' : 'Основний'}</span>
              {row.readiness === 'attention' ? <button type="button" onClick={() => setDetail({ row })}>⚠ Потребує уваги</button> : <span>{stored ? 'Збережено' : '✓ Готовий'}</span>}</th>
            {parsed.headers.map((code, column) => {
              const cell = row.cells[column]; const marked = row.issues?.some((issue) => targetsColumn(issue, code));
              return <td key={code} data-state={cell?.state} data-issue={marked || undefined}><button type="button" data-cell={`${rowIndex}:${column}`} tabIndex={focus[0] === rowIndex && focus[1] === column ? 0 : -1}
                onFocus={() => setFocus([rowIndex, column])} onKeyDown={(e) => navigateCell(e, rowIndex, column)}
                aria-label={`Значення ${code}, рядок ${row.ordinal}${marked ? ', потребує уваги' : ''}`} onClick={() => setDetail({ row, column })}>
                {marked && <span aria-hidden="true">⚠ </span>}{cell?.state === 'provisional' && <span aria-hidden="true">≈ </span>}
                {cell?.state === 'not-evaluated' ? 'Не обчислено' : cell?.value === '' ? (cell.state === 'provisional' ? 'Попередньо порожньо' : 'Порожньо') : cell?.value?.length > 160 ? `${cell.value.slice(0, 160)}…` : cell?.value}
              </button></td>;
            })}</tr>)}</tbody>
        </table></div>}
        {!rows.length && <div className="export-grid-empty" role="status">{attention === 'attention' && !categoryAttention[selected.groupCode] ? <><p>У категорії «{fileName(selected)}» зараз немає товарів, що потребують уваги.</p>
          {files.filter((file) => categoryAttention[file.groupCode] > 0).map((file) => <button className="btn btn-outline px-3" key={file.groupCode} onClick={() => { chooseFile(file); setSearch(''); setLanguage('all'); }}>Переглянути: {fileName(file)} · {categoryAttention[file.groupCode]}</button>)}</>
          : parsed.rows.length === 0 ? <p>У цій категорії немає товарів у вибраному діапазоні.</p> : <><p>За цими фільтрами рядків немає.</p><button className="underline" onClick={() => { setSearch(''); setAttention('all'); setLanguage('all'); }}>Скинути фільтри</button></>}</div>}
        {rows.length > 0 && <div className="export-grid-toolbar"><button type="button" disabled={!activePage} onClick={() => { setPage(activePage - 1); setFocus([0, 0]); }}>Попередні рядки</button><span>{activePage * 50 + 1}–{Math.min(rows.length, (activePage + 1) * 50)} / {rows.length} · порядок файлу</span><button type="button" disabled={(activePage + 1) * 50 >= rows.length} onClick={() => { setPage(activePage + 1); setFocus([0, 0]); }}>Наступні рядки</button></div>}
      </>}
    {widthColumn !== null && <WorkspaceDialog title="Ширина колонок" onClose={() => setWidthColumn(null)}><h3>Ширина колонок — лише цей перегляд</h3><label>Колонка<select value={widthColumn} onChange={(e) => setWidthColumn(e.target.value)}>{parsed.headers.map((code) => <option key={code}>{code}</option>)}</select></label><label>Ширина, px<input type="number" min="100" max="640" value={widths[widthColumn] || defaultWidth(widthColumn)} onChange={(e) => { const value = Number(e.target.value); if (value >= 100 && value <= 640) setWidths((w) => ({ ...w, [widthColumn]: value })); }} /></label><button onClick={() => setWidths({})}>Скинути ширину</button><button onClick={() => setWidthColumn(null)}>Готово</button></WorkspaceDialog>}
    {detail && <WorkspaceDialog title="Повне значення та проблеми" onClose={() => setDetail(null)}><h3>{detailRow.sku} · {detailRow.language === 'en' ? 'EN' : 'Основний'}{detail.column !== undefined && ` · ${parsed.headers[detail.column]}`}</h3>
      {issues.map((issue, index) => <p className="text-lg font-semibold" key={index}>{issueLabel(issue)}</p>)}
      {!!issues.length && <div className="flex flex-wrap gap-3">
        {onEditName && issues.some((issue) => ['manual_name_required', 'manual_name_review_required'].includes(issue.code)) && <button className="btn btn-primary px-3" onClick={() => { setDetail(null); onEditName({ productId: detailRow.productId, sku: detailRow.sku,
          ...(issues.some((issue) => issue.code === 'manual_name_review_required') ? { reviewRequired: true } : {}) }); }}>{issues.some((issue) => issue.code === 'manual_name_review_required') ? 'Перевірити назви' : 'Заповнити назву'}</button>}
        {canDecode && <Link className="btn btn-outline px-3" to={`/?exportSku=${encodeURIComponent(detailRow.sku)}`} onClick={() => onHandoff?.({ sku: detailRow.sku, reason: issues.map(issueLabel).join('; ') })}>Відкрити товар</Link>}
        <button className="underline" onClick={async () => { try { await navigator.clipboard.writeText(detailRow.sku); setNotice('SKU скопійовано'); } catch { setNotice('Скопіюйте SKU з повного значення.'); } }}>Копіювати SKU</button>
      </div>}
      {detailCell && <div role="region" aria-label="Повне значення"><p>{({ final: 'Значення CSV', blank: 'Навмисна порожня клітинка', provisional: 'Попереднє діагностичне значення', 'not-evaluated': 'Значення ще не обчислено' })[detailCell.state]}</p>{detailCell.value != null && <pre className="export-exact-value">{detailCell.value}</pre>}</div>}
      {issues.map((issue, index) => <details key={index}><summary>Технічні подробиці</summary><p>{issue.message}</p><pre className="export-exact-value">{JSON.stringify({ code: issue.code, field: issue.field, target: issue.target }, null, 2)}</pre></details>)}
      <button onClick={() => setDetail(null)}>Закрити значення</button>
    </WorkspaceDialog>}
  </section>;
}
