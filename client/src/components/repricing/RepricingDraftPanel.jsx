import { AlertTriangle, FilePenLine, RefreshCw, Save, Trash2 } from 'lucide-react';

const formatDate = (value) => (
  value
    ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(value))
    : '-'
);

export function RepricingDraftPanel({ controller }) {
  const {
    activeDraft,
    draftConflicts,
    draftSaveState,
    draftSync,
    invalidManualPriceIds,
    previewing,
    removeDraftConflicts,
    saveDraft,
    setDiscardDraftOpen,
    syncDraft,
  } = controller;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3 text-sm">
          <FilePenLine size={18} className={activeDraft ? 'text-amber-700' : 'text-slate-500'} />
          {activeDraft ? (
            <div className="min-w-0">
              <span className="font-semibold text-slate-800">Чернетка #{activeDraft.id}</span>
              <span className="ml-2 text-xs text-slate-500">
                {draftSaveState === 'saving'
                  ? 'Зберігаємо...'
                  : draftSaveState === 'error'
                    ? 'Не вдалося зберегти'
                    : `Збережено ${formatDate(activeDraft.updatedAt)}`}
              </span>
            </div>
          ) : (
            <span className="text-slate-600">Перегляд ще не збережено</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {activeDraft ? (
            <>
              <button
                type="button"
                className="btn btn-outline gap-2"
                onClick={syncDraft}
                disabled={previewing || invalidManualPriceIds.size > 0}
              >
                <RefreshCw size={15} className={previewing ? 'animate-spin' : ''} />
                Оновити список
              </button>
              <button
                type="button"
                className="btn btn-outline btn-icon-md text-rose-700"
                onClick={() => setDiscardDraftOpen(true)}
                title="Відкинути чернетку"
                aria-label="Відкинути чернетку"
              >
                <Trash2 size={16} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-outline gap-2"
              onClick={() => saveDraft().catch(() => {})}
              disabled={invalidManualPriceIds.size > 0}
            >
              <Save size={15} />
              Зберегти чернетку
            </button>
          )}
        </div>
      </div>

      {activeDraft && draftSync?.hasChanges && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>
              Дані або розрахунок змінилися після збереження чернетки:
              {draftSync.contextChanged ? ' матрицю оновлено;' : ''}
              {' '}додано {draftSync.added.length}, прибрано {draftSync.removed.length},
              {' '}перераховано {draftSync.changed.length}.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-outline gap-2"
            onClick={syncDraft}
            disabled={previewing || invalidManualPriceIds.size > 0}
          >
            <RefreshCw size={15} />
            Прийняти оновлення
          </button>
        </div>
      )}

      {draftConflicts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 sm:px-5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>
              {draftConflicts.length} ручних цін більше не належать цій переоцінці:
              {' '}{draftConflicts.map((item) => item.sku).join(', ')}.
            </span>
          </div>
          <button type="button" className="btn btn-outline" onClick={removeDraftConflicts}>
            Відкинути недоступні ціни
          </button>
        </div>
      )}
    </>
  );
}
