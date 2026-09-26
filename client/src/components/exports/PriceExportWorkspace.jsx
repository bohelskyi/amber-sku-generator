import { useMemo } from 'react';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';
import { StoredSnapshot } from './StoredSnapshot';

export function PriceExportWorkspace({ workflow, canCreate }) {
  const files = useMemo(() => workflow.review ? [{ groupCode: 'prices', fileName: 'sku,price', csvContent: workflow.review.csvContent }] : [], [workflow.review]);
  return <section className="card p-4 space-y-3"><h2 className="text-xl font-semibold">Оновлення цін Magento</h2>
    {workflow.snapshot ? <>
      {workflow.changed && <p role="status">Після попереднього перегляду дані змінилися. Файл створено з актуальними значеннями нижче.</p>}
      <StoredSnapshot snapshot={workflow.snapshot} loading={workflow.busy || workflow.compared === false} canConfirm={canCreate} onDownload={workflow.download} onConfirm={workflow.confirm} loadArtifact={workflow.readArtifact} />
      <button className="btn btn-outline px-3" disabled={workflow.busy} onClick={workflow.reset}>Новий експорт цін</button>
    </> : <>
      <h3 className="font-semibold">ПОПЕРЕДНІЙ ПЕРЕГЛЯД</h3>
      <p>Попередній перегляд показує поточні дані. Під час створення файлу сервер повторно перевірить актуальну чергу.</p>
      <button className="btn btn-outline px-3" disabled={workflow.busy || workflow.pending} onClick={workflow.check}>Оновити / переглянути поточну чергу</button>
      {workflow.review && <><p>Перевірено: {dateText(workflow.review.checkedAt)} · {workflow.review.rowCount} рядків</p>{workflow.review.rowCount > 0 ? <ExportDataGrid key={workflow.review.checkedAt} files={files} identity={workflow.review.checkedAt} />
        : <p role="status">Немає змін цін, які очікують експорту.</p>}
      </>}
      {canCreate && (workflow.pending || workflow.review?.rowCount > 0) && <button className="btn btn-primary px-4" disabled={workflow.busy} onClick={workflow.create}>{workflow.pending ? 'Повторити початкове створення файлу цін' : 'Створити файл'}</button>}
      {workflow.pending && <p>Результат запиту невідомий. Повтор використовує той самий ключ; нова операція не створюється.</p>}
    </>}
    {workflow.error && <p role="alert">{workflow.error}</p>}
  </section>;
}
