import { Search } from 'lucide-react';

export function RepricingFilters({ controller }) {
  const {
    filter,
    preview,
    previewScenarios,
    reviewFilter,
    reviewedProductIds,
    scenarioFilter,
    search,
    setFilter,
    setReviewFilter,
    setScenarioFilter,
    setSearch,
  } = controller;

  return (
    <div className="repricing-toolbar flex flex-col gap-3 border-b border-slate-200 p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {[
            ['changed', 'Зміняться'],
            ['unchanged', 'Без змін'],
            ...(preview.summary.skippedCount > 0 ? [['skipped', 'Пропущені']] : []),
            ['error', 'Помилки'],
            ['all', 'Усі'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${filter === value ? 'border-amber-300 bg-amber-50 text-amber-950 shadow-sm' : 'border-transparent text-slate-600'}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {[
            ['all', 'Усі перевірки'],
            ['pending', 'Непереглянуті'],
            ['reviewed', `Переглянуті · ${reviewedProductIds.length}`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${reviewFilter === value ? 'border-amber-300 bg-amber-50 text-amber-950 shadow-sm' : 'border-transparent text-slate-600'}`}
              onClick={() => setReviewFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {preview.scope === 'global' && (
          <label className="flex items-center gap-2 rounded-lg bg-slate-100 px-2 text-xs font-semibold text-slate-600">
            <span>Матриця</span>
            <select
              className="h-8 max-w-64 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"
              value={scenarioFilter}
              onChange={(event) => setScenarioFilter(event.target.value)}
            >
              <option value="all">Усі матриці</option>
              {previewScenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.categoryCode ? `${scenario.categoryCode} — ` : ''}{scenario.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="relative block w-full lg:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className="input-sm pl-9"
          value={search}
          placeholder="Пошук SKU"
          aria-label="Пошук товарів за SKU"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
    </div>
  );
}
