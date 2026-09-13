import { CircleDollarSign, SquareCheckBig } from 'lucide-react';
import { formatDecimal } from '../../lib/formatters';

const formatRate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? `${formatDecimal(value)} ₴/$` : null;
};

export function RepricingSummary({ controller }) {
  const {
    currentCalculationRate,
    effectiveSummary,
    keepAllCurrentManualPrices,
    preview,
    unresolvedManualPriceItems,
  } = controller;

  return (
    <>
      <div className="repricing-metrics grid grid-cols-2 border-b border-slate-200 sm:grid-cols-5">
        {[
          ['Знайдено', preview.summary.candidateCount, 'neutral'],
          ['Зміниться', effectiveSummary.changedCount, 'change'],
          ['Без змін', effectiveSummary.unchangedCount, 'neutral'],
          ['Пропущено', preview.summary.skippedCount, 'warning'],
          ['Помилки', effectiveSummary.errorCount, 'error'],
        ].map(([label, value, tone]) => (
          <div key={label} className={`repricing-metric is-${tone} border-r border-slate-200 px-4 py-3 last:border-r-0`}>
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
          </div>
        ))}
      </div>

      {currentCalculationRate !== null && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600 sm:px-5">
          <CircleDollarSign size={16} className="text-slate-500" />
          <span>Курс нового розрахунку</span>
          <strong className="font-semibold text-slate-800">{formatRate(currentCalculationRate)}</strong>
        </div>
      )}

      {preview.scope === 'global' && unresolvedManualPriceItems.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 sm:px-5">
          <div className="text-sm text-amber-900">
            Ручні ціни потребують явного підтвердження перед застосуванням.
          </div>
          <button
            type="button"
            className="btn btn-outline gap-2 border-amber-300 bg-white text-amber-900"
            onClick={keepAllCurrentManualPrices}
          >
            <SquareCheckBig size={16} />
            Залишити поточні ручні ціни для всіх ({unresolvedManualPriceItems.length})
          </button>
        </div>
      )}
    </>
  );
}
