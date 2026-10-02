import { useMemo } from 'react';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';
import { StoredSnapshot } from './StoredSnapshot';
import { Notice, SectionHeader } from '../ui';

export function PriceExportWorkspace({ workflow, canCreate }) {
  const files = useMemo(() => workflow.review ? [{ groupCode: 'prices', fileName: 'sku,price', csvContent: workflow.review.csvContent }] : [], [workflow.review]);
  return <section className="space-y-4"><SectionHeader title="Оновлення цін Magento" description="Перевірте поточну чергу, створіть файл і окремо підтвердьте збережений результат." />
    {workflow.snapshot ? <>
      {workflow.changed && <p role="status">Після попереднього перегляду дані змінилися. Файл створено з актуальними значеннями нижче.</p>}
      <StoredSnapshot snapshot={workflow.snapshot} loading={workflow.busy || workflow.compared === false} canConfirm={canCreate} onDownload={workflow.download} onConfirm={workflow.confirm} loadArtifact={workflow.readArtifact} />
      <button className="btn btn-outline px-3" disabled={workflow.busy} onClick={workflow.reset}>Новий експорт цін</button>
    </> : <>
      <h3 className="font-semibold">Попередній перегляд</h3>
      <p>Під час створення файлу чергу буде перевірено ще раз. Якщо дані зміняться, ви побачите фактичний збережений файл.</p>
      <button className="btn btn-outline px-3" disabled={workflow.busy || workflow.pending} onClick={workflow.check}>Оновити / переглянути поточну чергу</button>
      {workflow.review && <><p>Перевірено: {dateText(workflow.review.checkedAt)} · {workflow.review.rowCount} рядків</p>{workflow.review.rowCount > 0 ? <ExportDataGrid key={workflow.review.checkedAt} files={files} identity={workflow.review.checkedAt} />
        : <p role="status">Немає змін цін, які очікують експорту.</p>}
      </>}
      {canCreate && (workflow.pending || workflow.review?.rowCount > 0) && <button className="btn btn-primary px-4" disabled={workflow.busy} onClick={workflow.create}>{workflow.pending ? 'Повторити початкове створення файлу цін' : 'Створити файл'}</button>}
      {workflow.pending && <Notice tone="warning" title="Результат створення невідомий">Повтор відновлює початкову операцію. Перевірте її результат перед створенням іншого файлу.</Notice>}
    </>}
    {workflow.error && <Notice tone="error">{workflow.error}</Notice>}
  </section>;
}
