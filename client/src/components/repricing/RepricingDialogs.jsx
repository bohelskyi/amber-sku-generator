import { useRef } from 'react';
import { AlertTriangle, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

export function ConfirmDialog({ changedCount, manualCount, onCancel, onConfirm, pending }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useDialogAccessibility({
    closeDisabled: pending,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    isOpen: true,
    onClose: onCancel,
  });

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repricing-confirm-title"
        tabIndex={-1}
        className="dialog-surface dialog-compact max-w-md p-6"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-amber-600" size={22} />
          <div>
            <h2 id="repricing-confirm-title" className="text-lg font-semibold text-slate-900">Застосувати переоцінку</h2>
            <p className="mt-2 text-sm text-slate-600">Буде оновлено ціну для {changedCount} товарів.</p>
            {manualCount > 0 && (
              <p className="mt-1 text-sm font-medium text-amber-700">
                Ручних коригувань: {manualCount}.
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <RefreshCw size={16} className={pending ? 'animate-spin' : ''} />
            {pending ? 'Застосування...' : 'Застосувати'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RollbackDialog({ batch, onCancel, onConfirm, pending }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useDialogAccessibility({
    closeDisabled: pending,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    isOpen: true,
    onClose: onCancel,
  });

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repricing-rollback-title"
        tabIndex={-1}
        className="dialog-surface dialog-compact max-w-md p-6"
      >
        <div className="flex items-start gap-3">
          <Undo2 className="mt-0.5 text-rose-600" size={22} />
          <div>
            <h2 id="repricing-rollback-title" className="text-lg font-semibold text-slate-900">Відкотити переоцінку</h2>
            <p className="mt-2 text-sm text-slate-600">
              Для {batch.changed_count} товарів буде повернуто ціни, які були до партії #{batch.id}.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Якщо хоча б один товар пізніше змінювали, відкат не буде застосовано.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <Undo2 size={16} />
            {pending ? 'Відкат...' : 'Відкотити'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DiscardDraftDialog({ onCancel, onConfirm, pending }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useDialogAccessibility({
    closeDisabled: pending,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    isOpen: true,
    onClose: onCancel,
  });

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repricing-discard-title"
        tabIndex={-1}
        className="dialog-surface dialog-compact max-w-md p-6"
      >
        <div className="flex items-start gap-3">
          <Trash2 className="mt-0.5 text-rose-600" size={22} />
          <div>
            <h2 id="repricing-discard-title" className="text-lg font-semibold text-slate-900">Відкинути чернетку?</h2>
            <p className="mt-2 text-sm text-slate-600">
              Збережені ручні ціни буде видалено. Товари та матриця не зміняться.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <Trash2 size={16} />
            {pending ? 'Видаляємо...' : 'Відкинути'}
          </button>
        </div>
      </div>
    </div>
  );
}
