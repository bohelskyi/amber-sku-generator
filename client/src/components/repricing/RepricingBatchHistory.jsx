import { RepricingSyncProgress } from './RepricingSyncProgress.jsx';
import { useState } from 'react';
import { Download, Undo2 } from 'lucide-react';
import { Pagination, StatusBadge, TechnicalDisclosure } from '../ui/index.js';

const formatDate = (value) => (
  value
    ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(value))
    : '-'
);
function BatchSyncDetails({ batchId }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs">Magento</summary>
    {open && <RepricingSyncProgress batchId={batchId} />}
  </details>;
}

export function RepricingBatchHistory({ canRollbackRepricing, controller }) {
  const {
    batches,
    batchPageLoading,
    batchPageInfo,
    downloadBatch,
    downloadRollbackBatch,
    setRollbackTarget,
    setBatchPage,
  } = controller;

  return (
    <section className="card min-w-0 overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-lg font-semibold text-slate-900">Історія переоцінок</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="dense-table min-w-full">
          <thead>
            <tr className="table-head">
              <th scope="col" className="table-cell text-left">Дата</th>
              <th scope="col" className="table-cell text-left">Матриця</th>
              <th scope="col" className="table-cell text-left">Статус</th>
              <th scope="col" className="table-cell text-right">Оновлено</th>
              <th scope="col" className="table-cell text-right">CSV</th>
              <th scope="col" className="table-cell text-right">Дія</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id} className="border-t border-slate-100">
                <td className="table-cell whitespace-nowrap text-sm">
                  {formatDate(batch.applied_at)}
                </td>
                <td className="table-cell text-sm font-medium">
                  {batch.scope === 'global'
                    ? batch.scenario_name
                    : `${batch.category_code} — ${batch.scenario_name}`}
                </td>
                <td className="table-cell text-sm">
                  <StatusBadge tone={batch.status === 'rolled_back' ? 'warning' : 'success'}>
                    {batch.status === 'rolled_back' ? 'Відкочено' : 'Застосовано'}
                  </StatusBadge>
                </td>
                <td className="table-cell text-right text-sm">{batch.changed_count}<BatchSyncDetails batchId={batch.id} /></td>
                <td className="table-cell text-right">
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      className="btn btn-outline btn-icon"
                      onClick={() => downloadBatch(batch.id)}
                      title="CSV застосованих цін"
                      aria-label={`Завантажити CSV застосованих цін для партії ${batch.id}`}
                    >
                      <Download size={15} />
                    </button>
                    {batch.status === 'rolled_back' && (
                      <button
                        type="button"
                        className="btn btn-outline btn-icon"
                        onClick={() => downloadRollbackBatch(batch.id)}
                        title="CSV відновлених цін"
                        aria-label={`Завантажити CSV відновлених цін для партії ${batch.id}`}
                      >
                        <Undo2 size={15} />
                      </button>
                    )}
                  </div>
                </td>
                <td className="table-cell text-right">
                  {batch.status === 'completed' && canRollbackRepricing && (
                    <button
                      type="button"
                      className="btn btn-outline btn-icon ml-auto disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => setRollbackTarget(batch)}
                      disabled={!batch.can_rollback}
                      title={batch.can_rollback ? 'Відкотити переоцінку' : 'Відкат недоступний за поточним станом товарів'}
                      aria-label={`Відкотити переоцінку ${batch.id}`}
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {batches.length === 0 && (
          <div className="px-5 py-8 text-sm text-slate-500">Історія порожня.</div>
        )}
      </div>
      <div className="border-t border-slate-200 px-4 py-3">
        <Pagination busy={batchPageLoading} hasPrevious={batchPageInfo.hasPrevious} hasNext={batchPageInfo.hasNext}
          onPrevious={() => setBatchPage(Math.max(0, batchPageInfo.offset - batchPageInfo.limit))}
          onNext={() => setBatchPage(batchPageInfo.offset + batchPageInfo.limit)}
          summary={batchPageInfo.total > 0
            ? `${batchPageInfo.offset + 1}–${Math.min(batchPageInfo.offset + batches.length, batchPageInfo.total)} із ${batchPageInfo.total}`
            : undefined} />
        <TechnicalDisclosure summary="Про доступність відкату">
          Amber показує дію лише коли сервер підтвердив, що всі товари досі мають точний стан цієї партії. Інтерфейс не обчислює доступність відкату самостійно.
        </TechnicalDisclosure>
      </div>
    </section>
  );
}
