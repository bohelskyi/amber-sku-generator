import { useEffect, useRef, useState } from 'react';
import { createExportViewMemory } from '../../lib/export-view-memory';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';

export function ExportReview({ preview, stale, busy, onRefresh, onEditName, canDecode, onHandoff, productChanged, viewMemory, recoveryFocusBlocked = false }) {
  const [localView] = useState(createExportViewMemory); const recovery = useRef(null); const grid = useRef(null); const restore = useRef(false);
  useEffect(() => { if (productChanged && stale && !recoveryFocusBlocked) recovery.current?.focus(); }, [productChanged, stale, recoveryFocusBlocked]);
  useEffect(() => { if (!busy && !stale && restore.current) { restore.current = false; grid.current?.querySelector('[data-cell]')?.focus(); } }, [busy, stale, preview]);
  return <section aria-label="Попередня перевірка" className={stale ? 'bg-amber-50/40' : ''}>
    <div className="p-4 space-y-2"><h3 className="text-lg font-semibold">ПОПЕРЕДНІЙ ПЕРЕГЛЯД</h3>
      <p>Перевірено: {dateText(preview.checkedAt)} · {stale ? 'ЗАСТАРІЛО — потрібна явна повторна перевірка' : 'Актуально на час перевірки'}</p>
      <p>Товарів: {preview.representedCount} · Готові: {preview.readyCount}. Сервер звірить актуальність перед створенням.</p>
      <p>{preview.template ? `${preview.templateLabel?.displayName || preview.template.displayName || 'Опублікований шаблон'} · v${preview.templateLabel?.versionNumber || preview.template.versionNumber || 'Немає даних'}` : 'Системний профіль · звичайний експорт'}</p>
      {preview.range && <p>Перевірений діапазон: {preview.range.fromSku} — {preview.range.toSku || preview.range.resolvedToSku}</p>}
      {stale && productChanged && <div role="status"><p>Дані товару змінено. Попередній перегляд застарів.</p><p>Оновіть перевірку, щоб продовжити роботу з актуальними проблемами.</p></div>}
      {onRefresh && <button ref={recovery} className={`btn ${stale ? 'btn-primary' : 'btn-outline'} px-3`} disabled={busy} onClick={() => { restore.current = true; onRefresh(); }}>Оновити перевірку</button>}
    </div>
    <div ref={grid}><ExportDataGrid key={preview.tableFingerprint || preview.checkedAt} identity={preview.tableFingerprint} files={preview.review?.files || preview.artifacts}
      viewMemory={viewMemory || localView} onEditName={stale || busy ? undefined : onEditName} canDecode={!stale && !busy && canDecode} onHandoff={onHandoff} /></div>
    <details className="px-4 pb-3"><summary>Ідентичність перевірки</summary><p className="break-all">{preview.tableFingerprint || 'Немає даних'}</p>{preview.template && <p className="break-all">Публікація: {preview.template.versionId} · {preview.template.definitionHash}</p>}</details>
  </section>;
}
