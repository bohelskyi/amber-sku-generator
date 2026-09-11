import {
  ClipboardList,
  RotateCcw,
  ScanSearch,
  Square,
  SquareCheckBig,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { PricingExplanation, SortHeader } from './RepricingTablePrimitives';

export function RepricingTable({
  canApplyDirectRecount,
  canCreateCorrectionRequest,
  controller,
}) {
  const {
    activeCorrectionRequestByProductId,
    config,
    handleManualPriceBlur,
    handleSort,
    invalidManualPriceIds,
    keepCurrentManualPrice,
    manualPrices,
    preview,
    resetManualPrice,
    reviewedProductIdSet,
    selectAutomaticPrice,
    setManualPrice,
    setRecountTarget,
    sort,
    toggleReviewed,
    visibleItems,
  } = controller;

  return (
    <div className="relative isolate max-h-[560px] overflow-auto">
      <table className="dense-table min-w-full bg-white">
        <thead>
          <tr className="table-head">
            <SortHeader column="sku" sort={sort} onSort={handleSort}>Артикул</SortHeader>
            <SortHeader column="weight" sort={sort} onSort={handleSort}>Вага</SortHeader>
            <th className="table-cell sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-left shadow-[0_1px_0_rgba(148,163,184,0.35)]">Умова та розрахунок</th>
            <SortHeader align="right" column="oldPriceUah" sort={sort} onSort={handleSort}>Стара ціна</SortHeader>
            <SortHeader align="right" column="newPriceUah" sort={sort} onSort={handleSort}>Нова ціна</SortHeader>
            <SortHeader align="right" column="priceDeltaUah" sort={sort} onSort={handleSort}>Різниця</SortHeader>
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => {
            const isReviewed = reviewedProductIdSet.has(Number(item.productId));
            const correctionRequest = activeCorrectionRequestByProductId.get(
              Number(item.productId)
            );
            const requiresManualPrice = ['price_missing', 'manual_price'].includes(
              item.errorCode
            );
            const hasManualOverride = Object.prototype.hasOwnProperty.call(
              manualPrices,
              item.productId
            );
            const hasAutomaticResolution = Boolean(item.useAutomatic);
            const canUseAutomaticPrice = item.errorCode === 'manual_price'
              && Number(item.automaticPriceUah ?? item.newPriceUah) > 0;
            return (
              <tr
                key={item.productId}
                className={`border-t border-slate-100 ${isReviewed ? 'bg-emerald-50/45' : ''}`}
              >
                <td className="table-cell min-w-48 text-xs text-slate-800">
                  <div className="font-mono font-semibold">{item.sku}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className={`status-badge ${
                      item.status === 'error'
                        ? 'is-error'
                        : item.status === 'skipped'
                          ? 'is-skipped'
                          : item.status === 'unchanged'
                            ? 'is-neutral'
                            : 'is-change'
                    }`}>
                      {item.status === 'error'
                        ? 'Помилка'
                        : item.status === 'skipped'
                          ? 'Пропущено'
                          : item.status === 'unchanged'
                            ? 'Без змін'
                            : 'Зміниться'}
                    </span>
                    <span className={`status-badge ${
                      item.pricingState === 'manual' || item.errorCode === 'manual_price' || item.manualOverride
                        ? 'is-manual'
                        : item.pricingState === 'missing' || item.errorCode === 'price_missing'
                          ? 'is-missing'
                          : 'is-automatic'
                    }`}>
                      {item.manualOverride
                        ? 'Ручна підтверджена'
                        : item.pricingState === 'manual' || item.errorCode === 'manual_price'
                          ? 'Ручна'
                          : item.pricingState === 'missing' || item.errorCode === 'price_missing'
                            ? 'Ціна відсутня'
                            : 'Автоматична'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-3 font-sans">
                    {(canApplyDirectRecount || canCreateCorrectionRequest) && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 hover:text-slate-900"
                        onClick={() => setRecountTarget({
                          productId: Number(item.productId),
                          sku: item.sku,
                          mode: 'request',
                        })}
                      >
                        <ScanSearch size={14} />
                        Перевірити
                      </button>
                    )}
                    {correctionRequest && (
                      <Link
                        to={`/admin/corrections?request=${correctionRequest.id}&from=admin`}
                        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 hover:text-sky-900"
                      >
                        <ClipboardList size={14} />
                        Запит #{correctionRequest.id}
                      </Link>
                    )}
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${isReviewed ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-900'}`}
                      onClick={() => toggleReviewed(item.productId)}
                      aria-pressed={isReviewed}
                    >
                      {isReviewed ? <SquareCheckBig size={14} /> : <Square size={14} />}
                      {isReviewed ? 'Переглянуто' : 'Позначити'}
                    </button>
                  </div>
                </td>
                <td className="table-cell whitespace-nowrap text-sm">
                  {item.weight === null || item.weight === undefined
                    ? '-'
                    : formatDecimal(item.weight)} г
                </td>
                <td className="table-cell min-w-64 text-xs text-slate-600">
                  {item.status === 'error' && !requiresManualPrice
                    ? <span className="text-rose-700">{item.message}</span>
                    : requiresManualPrice
                      ? (
                        <div className="space-y-2">
                          <div className={item.manualOverride || item.useAutomatic ? 'text-amber-800' : 'text-rose-700'}>
                            {item.message}
                          </div>
                          <div className="text-slate-600">
                            {item.categoryCode ? `${item.categoryCode} — ` : ''}
                            {item.scenarioName || item.matrixName || 'Активну матрицю не визначено'}
                            {item.automaticPriceUah > 0
                              ? ` · розраховано ${formatUah(item.calculatedPriceUah)} → автоматично ${formatUah(item.automaticPriceUah)}`
                              : ''}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="btn btn-outline btn-compact"
                              onClick={() => keepCurrentManualPrice(
                                item.productId,
                                item.oldPriceUah
                              )}
                            >
                              Залишити ручну ціну · {formatUah(item.oldPriceUah)}
                            </button>
                            {canUseAutomaticPrice && (
                              <button
                                type="button"
                                className="btn btn-outline btn-compact text-sky-800"
                                onClick={() => selectAutomaticPrice(item.productId)}
                              >
                                Застосувати автоматичну ціну ·{' '}
                                {formatUah(item.automaticPriceUah ?? item.newPriceUah)}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                      : (
                        <PricingExplanation
                          config={config}
                          categoryCode={item.categoryCode || preview.scenario?.categoryCode}
                          item={item}
                        />
                      )}
                </td>
                <td className="table-cell whitespace-nowrap text-right text-sm">
                  {formatUah(item.oldPriceUah)}
                </td>
                <td className="table-cell min-w-44 whitespace-nowrap text-right text-sm font-semibold">
                  {item.status === 'error' && !requiresManualPrice ? '-' : (
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="relative">
                          <input
                            className={`input-sm w-28 pr-7 text-right font-semibold ${invalidManualPriceIds.has(item.productId) ? 'border-rose-400 focus:border-rose-500' : ''}`}
                            inputMode="decimal"
                            aria-label={`Нова ціна для ${item.sku}`}
                            value={hasManualOverride
                              ? manualPrices[item.productId]
                              : (hasAutomaticResolution
                                  ? formatDecimal(item.automaticPriceUah ?? item.newPriceUah)
                                  : (requiresManualPrice ? '' : formatDecimal(item.newPriceUah)))}
                            onChange={(event) => setManualPrice(item.productId, event.target.value)}
                            onBlur={(event) => handleManualPriceBlur(
                              item.productId,
                              event.target.value,
                              hasAutomaticResolution
                            )}
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-normal text-slate-400">₴</span>
                        </div>
                        {(hasManualOverride || hasAutomaticResolution) && (
                          <button
                            type="button"
                            className="btn btn-outline btn-icon"
                            onClick={() => resetManualPrice(item.productId)}
                            title="Повернути розраховану ціну"
                            aria-label={`Скинути ручну ціну для ${item.sku}`}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                      {item.manualOverride && (
                        <span className="text-[10px] font-semibold uppercase text-amber-700">
                          {item.resolvedManualPrice || item.resolvedPriceMissing
                            ? 'Ручну ціну підтверджено'
                            : `Вручну · автоматично ${formatUah(item.automaticPriceUah)}`}
                        </span>
                      )}
                      {item.useAutomatic && (
                        <span className="text-[10px] font-semibold uppercase text-sky-700">
                          Автоматичну ціну підтверджено
                        </span>
                      )}
                      {invalidManualPriceIds.has(item.productId) && (
                        <span className="text-[10px] font-medium text-rose-600">
                          Вкажіть ціну більше нуля
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className={`table-cell whitespace-nowrap text-right text-sm font-semibold ${Number(item.priceDeltaUah) >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {item.status === 'error' ? '-' : formatUah(item.priceDeltaUah)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {visibleItems.length === 0 && (
        <div className="px-4 py-12 text-center text-sm text-slate-500">
          Немає рядків для цього фільтра.
        </div>
      )}
    </div>
  );
}
