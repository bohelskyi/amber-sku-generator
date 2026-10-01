import { formatDecimal } from '../../lib/formatters';
export function RepricingSummary({ controller, config }) {
  const { effectiveSummary: summary, currentCalculationRate } = controller;
  return <div className="space-y-3 border-b border-slate-200 p-5">
    <h2 className="text-lg font-semibold">Буде змінено {summary.changedCount} товарів</h2>
    {(summary.categories || []).map(({ code, count }) => <p key={code}>{config?.categories?.[code]?.name || code} — {count}</p>)}
    <div className="flex flex-wrap gap-4 text-sm text-slate-600">
      <span>Ручні ціни збережено: {summary.manualPreservedCount || 0}</span>
      <span>Актуальні ціни без змін: {summary.currentCount ?? summary.unchangedCount}</span>
      <span>Потребують вирішення: {summary.errorCount}</span>
    </div>
    {currentCalculationRate !== null && <p className="text-xs text-slate-500">Курс нового розрахунку: {formatDecimal(currentCalculationRate)} ₴/$</p>}
  </div>;
}
