import { ClipboardList, Download } from 'lucide-react';
import { RepricingSyncProgress } from './RepricingSyncProgress.jsx';
import { Link } from 'react-router-dom';
import { Button, Notice, OperationReceipt } from '../ui/index.js';

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
        <OperationReceipt title={`Створено запит #${createdCorrectionRequest.id}`}
          description="Товар залишився без змін; запит передано до черги виправлень."
          identity={createdCorrectionRequest.sourceArticle || createdCorrectionRequest.sourcePublicSku}
          actions={<Link to={`/admin/corrections?request=${createdCorrectionRequest.id}&from=admin`} className="btn btn-outline gap-2">
            <ClipboardList size={15} />
            Відкрити запит
          </Link>} />
      )}

      {preview && blockingCorrectionRequests.length > 0 && (
        <Notice tone="warning" title="Переоцінку тимчасово заблоковано" actions={<div className="flex flex-wrap gap-2 sm:justify-end">
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
          </div>}>
          Спочатку опрацюйте {blockingCorrectionRequests.length}{' '}
          {blockingCorrectionRequests.length === 1 ? 'активний запит' : 'активні запити'},
          що {preview.scope === 'global' ? 'належать товарам у загальній переоцінці' : 'належать цій матриці'}.
        </Notice>
      )}

      {appliedBatch && (
        <OperationReceipt title="Переоцінку застосовано в Amber"
          description={`Оновлено ${appliedBatch.changed_count ?? appliedBatch.changedCount} товарів. Доставка до Magento відстежується окремо.`}
          identity={`#${appliedBatch.id}`} identityLabel="Партія" actions={<Button onClick={() => downloadBatch(appliedBatch.id)}>
            <Download size={16} />
            Файл змінених цін
          </Button>} />
      )}

      {appliedBatch && <RepricingSyncProgress batchId={appliedBatch.id} />}
      {rollbackResult && (
        <OperationReceipt title="Переоцінку відкочено" description="Попередні ціни повернено в Amber."
          identity={`#${rollbackResult.id}`} identityLabel="Партія" tone="warning" actions={<Button onClick={() => downloadRollbackBatch(rollbackResult.id)}>
            <Download size={16} />
            CSV відкату
          </Button>} />
      )}
    </>
  );
}
