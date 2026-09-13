import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown } from 'lucide-react';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { getPricingAxis } from '../../lib/pricing-axis';

const formatUsdPerGram = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? `$${formatDecimal(value)}/г` : null;
};

const formatRate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? `${formatDecimal(value)} ₴/$` : null;
};

function getOptionLabel(config, categoryCode, key, value, context) {
  const questions = config?.questions?.[categoryCode] || [];
  const axis = getPricingAxis(key, questions, key, [], context);
  const option = axis.options.find((item) => Number(item.id) === Number(value));
  return option?.label || String(value ?? '-');
}

function getPricingBasis(config, categoryCode, item) {
  const matrix = item.pricingDetails?.matrix;
  if (!matrix) return '-';
  const scenarioContext = item.pricingDetails?.scenario?.match_json || {};
  const parts = [];

  if (matrix.x?.label) {
    parts.push(matrix.x.label);
  } else if (matrix.x?.key && matrix.x.key !== 'weight') {
    parts.push(getOptionLabel(config, categoryCode, matrix.x.key, matrix.x.value, scenarioContext));
  }
  if (matrix.y?.key) {
    parts.push(matrix.y.label || getOptionLabel(
      config,
      categoryCode,
      matrix.y.key,
      matrix.y.value,
      scenarioContext
    ));
  }
  return parts.join(' / ') || '-';
}

function getPriceBasisLabel(mode, pricePerGram, fixedPriceUah) {
  if (mode === 'per_gram_usd') return formatUsdPerGram(pricePerGram);
  if (mode === 'fixed_uah') {
    return fixedPriceUah === null || fixedPriceUah === undefined
      ? null
      : `${formatUah(fixedPriceUah)} фікс.`;
  }
  return null;
}

function ValueTransition({ oldValue, newValue }) {
  if (!oldValue && !newValue) return null;
  if (!oldValue || oldValue === newValue) {
    return <span className="font-semibold text-slate-800">{newValue || oldValue}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-slate-500">{oldValue}</span>
      <ArrowRight size={12} className="shrink-0 text-slate-400" />
      <span className="font-semibold text-slate-800">{newValue}</span>
    </span>
  );
}

export function PricingExplanation({ config, categoryCode, item }) {
  const change = item.pricingChange || {};
  const oldBasis = getPriceBasisLabel(
    change.oldPriceMode,
    change.oldPricePerGram,
    change.oldFixedPriceUah
  );
  const newBasis = getPriceBasisLabel(
    change.newPriceMode,
    change.newPricePerGram,
    change.newFixedPriceUah
  );
  const showRateChange = (change.reasonCodes || []).includes('exchange_rate_only');
  const matrixChanged = change.oldMatrixName
    && change.newMatrixName
    && change.oldMatrixName !== change.newMatrixName;

  return (
    <div className="min-w-64 max-w-80 space-y-1">
      <div className="text-xs">
        {matrixChanged ? (
          <ValueTransition oldValue={change.oldMatrixName} newValue={change.newMatrixName} />
        ) : (
          <strong className="font-semibold text-slate-800">
            {change.newMatrixName || item.matrixName || change.oldMatrixName || 'Матрицю не визначено'}
          </strong>
        )}
      </div>
      <div className="text-slate-600">{getPricingBasis(config, categoryCode, item)}</div>
      {(oldBasis || newBasis) && (
        <div className="text-slate-700">
          <span className="mr-1 text-slate-500">Розрахунок:</span>
          <ValueTransition oldValue={oldBasis} newValue={newBasis} />
        </div>
      )}
      {showRateChange && (
        <div className="text-slate-700">
          <span className="mr-1 text-slate-500">Курс:</span>
          <ValueTransition
            oldValue={formatRate(change.oldUahRate)}
            newValue={formatRate(change.newUahRate)}
          />
        </div>
      )}
      {(change.reasonLabels || []).length > 0 && (
        <div className="font-medium text-amber-800">
          {change.reasonLabels.join(' · ')}
        </div>
      )}
    </div>
  );
}

export function SortHeader({ align = 'left', children, column, onSort, sort }) {
  const active = sort.key === column;
  const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      className={`table-cell sticky top-0 z-20 border-b border-slate-200 bg-slate-100 shadow-[0_1px_0_rgba(148,163,184,0.35)] ${align === 'right' ? 'text-right' : 'text-left'}`}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`flex w-full items-center gap-1.5 ${align === 'right' ? 'justify-end' : 'justify-start'}`}
        onClick={() => onSort(column)}
        title={`Сортувати за колонкою «${children}»`}
      >
        <span>{children}</span>
        <Icon size={13} className={active ? 'text-slate-800' : 'text-slate-400'} />
      </button>
    </th>
  );
}
