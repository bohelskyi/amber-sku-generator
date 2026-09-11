import { FilePenLine, RefreshCw } from 'lucide-react';

export function RepricingScopePanel({ controller }) {
  const {
    drafts,
    openSelectedRepricing,
    previewing,
    scenarioId,
    scenarios,
    selectScenario,
    selectedDraft,
    selectedScenario,
  } = controller;

  return (
    <div className="border-b border-slate-200 p-5 sm:p-6">
      <div className="mb-3 text-sm font-semibold text-slate-800">Переоцінка за окремою матрицею</div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-end">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Цінова матриця</span>
          <select
            className="input-sm min-w-0 max-w-full"
            value={scenarioId}
            onChange={(event) => selectScenario(event.target.value)}
          >
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.category_code} — {scenario.name}
                {drafts.some((draft) => Number(draft.scenarioId) === Number(scenario.id))
                  ? ' · чернетка'
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary gap-2 lg:min-w-56"
          onClick={openSelectedRepricing}
          disabled={!scenarioId || previewing}
        >
          {selectedDraft
            ? <FilePenLine size={16} />
            : <RefreshCw size={16} className={previewing ? 'animate-spin' : ''} />}
          {previewing
            ? 'Розрахунок...'
            : selectedDraft
              ? 'Продовжити чернетку'
              : 'Попередній перегляд'}
        </button>
      </div>
      {selectedScenario && (
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="chip normal-case tracking-normal">{selectedScenario.category_code}</span>
          <span className="chip normal-case tracking-normal">Пріоритет: {selectedScenario.priority}</span>
          <span className="chip normal-case tracking-normal">
            {selectedScenario.price_mode === 'fixed_uah' ? 'Фіксована UAH' : 'USD за грам'}
          </span>
        </div>
      )}
    </div>
  );
}
