import { useEffect, useRef, useState } from 'react';
import { createExportViewMemory } from '../../lib/export-view-memory';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';

export function ExportReview({ preview, stale, busy, onRefresh, onEditName, canDecode, onHandoff, productChanged, refreshing, viewMemory, recoveryFocusBlocked = false }) {
  const [localView] = useState(createExportViewMemory); const recovery = useRef(null); const grid = useRef(null); const restore = useRef(false);
  useEffect(() => { if (refreshing) restore.current = true; else if (productChanged && stale && !busy && !recoveryFocusBlocked) recovery.current?.focus(); }, [productChanged, stale, busy, refreshing, recoveryFocusBlocked]);
  useEffect(() => { if (!busy && !stale && restore.current) { restore.current = false; grid.current?.querySelector('[data-cell]')?.focus(); } }, [busy, stale, preview]);
  return <section aria-label="Попередня перевірка" className={stale ? 'bg-amber-50/40' : ''}>
    <div className="export-review-heading"><div><h3 className="text-lg font-semibold">ПОПЕРЕДНІЙ ПЕРЕГЛЯД</h3>
      <p>{preview.template ? `${preview.templateLabel?.displayName || preview.template.displayName || 'Опублікований шаблон'} · v${preview.templateLabel?.versionNumber || preview.template.versionNumber || 'Немає даних'}` : 'Системний профіль'} · Товарів: {preview.representedCount} · Готові: {preview.readyCount}</p>
      <p className="text-sm">{dateText(preview.checkedAt)} · {stale ? 'ЗАСТАРІЛО — оновіть перевірку' : 'Актуально на час перевірки'}</p>
      {preview.range && <p className="text-sm">Діапазон: {preview.range.fromSku} — {preview.range.toSku || preview.range.resolvedToSku}</p>}</div>
      {onRefresh && <button ref={recovery} className={`btn ${stale ? 'btn-primary' : 'btn-outline'} px-3`} disabled={busy} onClick={() => { restore.current = true; onRefresh(); }}>{stale && productChanged ? 'Повторити перевірку' : 'Оновити перевірку'}</button>}
    </div>
    {refreshing ? <p className="px-4" role="status">Оновлюємо перевірку після зміни товару…</p> : stale && productChanged && <p className="px-4" role="status">Дані товару змінено. Попередній перегляд застарів. Оновіть перевірку, щоб продовжити.</p>}
    <div ref={grid}><ExportDataGrid key={preview.tableFingerprint || preview.checkedAt} identity={preview.tableFingerprint} files={preview.review?.files || preview.artifacts}
      viewMemory={viewMemory || localView} onEditName={stale || busy ? undefined : onEditName} canDecode={!stale && !busy && canDecode} onHandoff={onHandoff} /></div>
    <details className="px-4 pb-3"><summary>Технічні подробиці перевірки</summary><p>Сервер звірить актуальність перед створенням файлів.</p><p className="break-all">{preview.tableFingerprint || 'Немає даних'}</p>{preview.template && <p className="break-all">Публікація: {preview.template.versionId} · {preview.template.definitionHash}</p>}</details>
  </section>;
}
