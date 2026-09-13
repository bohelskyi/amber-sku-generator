import { Download, Undo2 } from 'lucide-react';

const formatDate = (value) => (
  value
    ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(value))
    : '-'
);

export function RepricingBatchHistory({ canRollbackRepricing, controller }) {
  const {
    batches,
    downloadBatch,
    downloadRollbackBatch,
    setRollbackTarget,
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
              <th className="table-cell text-left">Дата</th>
              <th className="table-cell text-left">Матриця</th>
              <th className="table-cell text-left">Статус</th>
              <th className="table-cell text-right">Оновлено</th>
              <th className="table-cell text-right">CSV</th>
              <th className="table-cell text-right">Дія</th>
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
                  {batch.status === 'rolled_back' ? (
                    <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
                      Відкочено
                    </span>
                  ) : (
                    <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                      Застосовано
                    </span>
                  )}
                </td>
                <td className="table-cell text-right text-sm">{batch.changed_count}</td>
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
                      title={batch.can_rollback
                        ? 'Відкотити переоцінку'
                        : 'Після цієї партії товари вже змінювали'}
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
    </section>
  );
}
