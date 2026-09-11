import { AlertTriangle, CheckCircle2, ClipboardList, Download, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';

export function RepricingWorkflowNotices({ controller }) {
  const {
    appliedBatch,
    blockingCorrectionRequests,
    createdCorrectionRequest,
    downloadBatch,
    downloadRollbackBatch,
    preview,
    rollbackResult,
  } = controller;

  return (
    <>
      {createdCorrectionRequest && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span>Створено запит #{createdCorrectionRequest.id} для {createdCorrectionRequest.sourceSku}.</span>
          <Link to={`/admin/corrections?request=${createdCorrectionRequest.id}&from=admin`} className="btn btn-outline gap-2">
            <ClipboardList size={15} />
            Відкрити запит
          </Link>
        </div>
      )}

      {preview && blockingCorrectionRequests.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
            <div>
              <div className="font-semibold">Переоцінку тимчасово заблоковано</div>
              <div className="mt-1 leading-6 text-amber-900">
                Спочатку опрацюйте {blockingCorrectionRequests.length}{' '}
                {blockingCorrectionRequests.length === 1 ? 'активний запит' : 'активні запити'},
                що {preview.scope === 'global' ? 'належать товарам у загальній переоцінці' : 'належать цій матриці'}.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            {blockingCorrectionRequests.slice(0, 3).map((request) => (
              <Link
                key={request.id}
                to={`/admin/corrections?request=${request.id}&from=admin`}
                className="btn btn-outline btn-compact-md gap-2 bg-white"
              >
                <ClipboardList size={14} />
                Запит #{request.id}
              </Link>
            ))}
            {blockingCorrectionRequests.length > 3 && (
              <Link to="/admin/corrections?from=admin" className="btn btn-outline btn-compact-md bg-white">
                Ще {blockingCorrectionRequests.length - 3}
              </Link>
            )}
          </div>
        </div>
      )}

      {appliedBatch && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <div className="flex items-center gap-3 text-sm text-emerald-900">
            <CheckCircle2 size={19} />
            <span>Оновлено товарів: {appliedBatch.changed_count ?? appliedBatch.changedCount}</span>
          </div>
          <button type="button" className="btn btn-outline gap-2" onClick={() => downloadBatch(appliedBatch.id)}>
            <Download size={16} />
            CSV для сайту
          </button>
        </div>
      )}

      {rollbackResult && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-3 text-sm text-amber-900">
            <Undo2 size={19} />
            <span>Переоцінку #{rollbackResult.id} відкочено. Старі ціни повернено.</span>
          </div>
          <button type="button" className="btn btn-outline gap-2" onClick={() => downloadRollbackBatch(rollbackResult.id)}>
            <Download size={16} />
            CSV відкату
          </button>
        </div>
      )}
    </>
  );
}
