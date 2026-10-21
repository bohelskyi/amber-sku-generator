import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TechnicalDisclosure } from '../ui/index.js';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { PricingExplanation, SortHeader } from './RepricingTablePrimitives';

function resultLabel(item) {
  if (item.status === 'error') return item.message || 'Потрібне рішення';
  if (item.manualPreserved) return 'Ручну ціну збережено';
  if (item.status === 'skipped') return 'Пропущено';
  if (item.status === 'unchanged') return 'Без змін';
  return item.manualOverride ? 'Нова ручна ціна' : 'Зміниться';
}

function RepricingRowDetail({ item, onClose, canApplyDirectRecount, canCreateCorrectionRequest, canPrepareRepricing, controller }) {
  const headingRef = useRef(null);
  useLayoutEffect(() => { headingRef.current?.focus(); }, []);
  const { activeCorrectionRequestByProductId, config, handleManualPriceBlur, handleManualPriceFocus,
    invalidManualPriceIds, keepCurrentManualPrice, manualPrices, preview, resetManualPrice,
    reviewedProductIdSet, selectAutomaticPrice, setManualPrice, setRecountTarget, toggleReviewed } = controller;
  const correctionRequest = activeCorrectionRequestByProductId.get(Number(item.productId));
  const requiresManualPrice = ['price_missing', 'manual_price'].includes(item.errorCode);
  const hasManualOverride = Object.prototype.hasOwnProperty.call(manualPrices, item.productId);
  const hasAutomaticResolution = Boolean(item.useAutomatic);
  const canUseAutomaticPrice = (item.manualPreserved || item.errorCode === 'manual_price') && item.pricingDetails?.matrix
    && Number(item.automaticPriceUah ?? item.newPriceUah) > 0;
  const article = item.publicSku || 'Артикул недоступний';
  const errorId = `repricing-price-error-${item.productId}`;
  const locked = !canPrepareRepricing || item.manualPreserved || preview.scope === 'global' && item.hasManualPrice;
  const isReviewed = reviewedProductIdSet.has(Number(item.productId));

  return <div className="repricing-row-detail" id={`repricing-detail-${item.productId}`}>
    <div className="space-y-3">
      <button type="button" className="btn btn-outline repricing-detail-back" onClick={onClose}>До списку цін</button>
      <h3 ref={headingRef} className="font-semibold" tabIndex={-1}>Рішення для {article}</h3>
      <p className="text-sm text-slate-500">Вага: {item.weight === null || item.weight === undefined ? 'не вказана' : `${formatDecimal(item.weight)} г`}</p>
      {item.manualPreserved ? <p>Ручну ціну збережено без змін.</p> : item.status === 'error' && !requiresManualPrice
        ? <p role="alert">{item.message}</p> : requiresManualPrice ? <p>{item.message}</p>
          : <PricingExplanation config={config} categoryCode={item.categoryCode || preview.scenario?.categoryCode} item={item} />}
      {requiresManualPrice && <p>{item.scenarioName || item.matrixName || 'Активну матрицю не визначено'}
        {Number(item.automaticPriceUah) > 0 ? ` · автоматично ${formatUah(item.automaticPriceUah)}` : ''}</p>}
      {canPrepareRepricing && <div className="flex flex-wrap gap-2">
        {requiresManualPrice && !item.manualPreserved && <button type="button" className="btn btn-outline"
          onClick={() => keepCurrentManualPrice(item.productId, item.oldPriceUah)}>Залишити ручну ціну · {formatUah(item.oldPriceUah)}</button>}
        {canUseAutomaticPrice && <button type="button" className="btn btn-outline" onClick={() => selectAutomaticPrice(item.productId)}>
          Перейти на автоматичну ціну · {formatUah(item.automaticPriceUah ?? item.newPriceUah)}</button>}
      </div>}
      {!(item.status === 'error' && !requiresManualPrice) && <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">Нова ціна, грн<input className="input-sm w-40" inputMode="decimal" readOnly={locked}
          aria-label={`Нова ціна для ${article}`} aria-invalid={invalidManualPriceIds.has(item.productId) || undefined}
          aria-describedby={invalidManualPriceIds.has(item.productId) ? errorId : undefined}
          value={hasManualOverride ? manualPrices[item.productId] : hasAutomaticResolution
            ? formatDecimal(item.automaticPriceUah ?? item.newPriceUah) : requiresManualPrice ? '' : formatDecimal(item.newPriceUah)}
          onChange={(event) => { if (!locked) setManualPrice(item.productId, event.target.value); }}
          onFocus={() => { if (!locked) handleManualPriceFocus(item.productId); }}
          onBlur={(event) => { if (!locked) handleManualPriceBlur(item.productId, event.target.value, hasAutomaticResolution); }} />
        </label>
        {canPrepareRepricing && (hasManualOverride || hasAutomaticResolution) && <button type="button" className="btn btn-outline"
          onClick={() => resetManualPrice(item.productId)} aria-label={`Скинути ручну ціну для ${article}`}>Повернути розраховану ціну</button>}
        {invalidManualPriceIds.has(item.productId) && <p id={errorId} role="alert">Вкажіть ціну більше нуля</p>}
      </div>}
      {item.manualOverride && <p className="text-sm">{item.resolvedManualPrice || item.resolvedPriceMissing ? 'Ручну ціну підтверджено' : `Вручну · автоматично ${formatUah(item.automaticPriceUah)}`}</p>}
      {item.useAutomatic && <p className="text-sm">Автоматичну ціну підтверджено</p>}
    </div>
    <div className="space-y-3">
      {canPrepareRepricing && <button type="button" className="btn btn-outline" onClick={() => toggleReviewed(item.productId)} aria-pressed={isReviewed}>
        {isReviewed ? 'Переглянуто' : 'Позначити як переглянутий'}</button>}
      {(canApplyDirectRecount || canCreateCorrectionRequest) && <button type="button" className="btn btn-outline" onClick={() => setRecountTarget({
        productId: Number(item.productId), sku: item.publicSku || item.sku, mode: canApplyDirectRecount ? 'apply' : 'request',
      })}>Змінити характеристики</button>}
      {correctionRequest && <Link className="btn btn-outline" to={`/admin/corrections?request=${correctionRequest.id}&from=admin`}>Запит #{correctionRequest.id}</Link>}
      {item.sku && <TechnicalDisclosure summary="Внутрішній SKU"><span className="font-mono">{item.sku}</span></TechnicalDisclosure>}
    </div>
  </div>;
}

export function RepricingTable(props) {
  const { controller } = props;
  const { handleSort, sort, visibleItems, reviewedProductIdSet } = controller;
  const [selected, setSelected] = useState(null);
  return <div className="repricing-table-scroll">
    <table className="dense-table min-w-full bg-white">
      <caption className="sr-only">Перевірка цін. Відкрийте рядок для розрахунку й ручного рішення.</caption>
      <thead><tr className="table-head">
        <SortHeader column="sku" sort={sort} onSort={handleSort}>Артикул</SortHeader>
        <SortHeader align="right" column="oldPriceUah" sort={sort} onSort={handleSort}>Зараз</SortHeader>
        <SortHeader align="right" column="newPriceUah" sort={sort} onSort={handleSort}>Буде</SortHeader>
        <SortHeader align="right" column="priceDeltaUah" sort={sort} onSort={handleSort}>Різниця</SortHeader>
        <th scope="col" className="table-cell">Результат</th><th scope="col" className="table-cell"><span className="sr-only">Дії</span></th>
      </tr></thead>
      <tbody>{visibleItems.map((item) => {
        const article = item.publicSku || 'Артикул недоступний';
        const expanded = selected === item.productId;
        return <Fragment key={item.productId}><tr className={expanded ? 'is-selected' : ''}>
          <th scope="row" className="table-cell text-left font-mono">{article}</th>
          <td className="table-cell text-right tabular-nums">{formatUah(item.oldPriceUah)}</td>
          <td className="table-cell text-right font-semibold tabular-nums">{item.status === 'error' ? '—' : formatUah(item.newPriceUah)}</td>
          <td className="table-cell text-right tabular-nums">{item.status === 'error' ? '—' : formatUah(item.priceDeltaUah)}</td>
          <td className="table-cell"><span className={item.status === 'error' ? 'text-rose-700' : ''}>{resultLabel(item)}</span>
            {reviewedProductIdSet.has(Number(item.productId)) && <span className="ml-2 text-slate-500">· Переглянуто</span>}</td>
          <td className="table-cell"><button type="button" id={`repricing-open-${item.productId}`} className="btn btn-outline" aria-expanded={expanded}
            aria-controls={`repricing-detail-${item.productId}`} aria-label={`${expanded ? 'Закрити' : 'Переглянути'} рішення для ${article}`}
            onClick={() => {
              setSelected(expanded ? null : item.productId);
            }}>{expanded ? 'Закрити' : item.status === 'error' ? 'Вирішити' : 'Переглянути'}</button></td>
        </tr>{expanded && <tr className="repricing-detail-row"><td colSpan={6}><RepricingRowDetail {...props} item={item} onClose={() => {
          setSelected(null);
          requestAnimationFrame(() => document.getElementById(`repricing-open-${item.productId}`)?.focus());
        }} /></td></tr>}</Fragment>;
      })}</tbody>
    </table>
    {visibleItems.length === 0 && <p className="p-6 text-center text-slate-500">Немає рядків для цього фільтра.</p>}
  </div>;
}
