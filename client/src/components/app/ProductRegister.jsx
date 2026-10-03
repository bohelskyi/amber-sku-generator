import { useState } from 'react';
import { ExternalLink, RefreshCw, Search } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { formatDecimal, formatUah } from '../../lib/formatters';
import { useProductRegister } from '../../hooks/product/useProductRegister';
import { CopyButton } from '../shared/CopyButton';
import { EmptyState, LoadingState, Notice, StatusBadge } from './UiPrimitives';

const lifecycleLabels = {
  current: 'Поточні',
  archived: 'Архівні',
  corrected: 'Переобліковані',
  all: 'Уся історія',
};

const statusPresentation = {
  active: { label: 'Активний', tone: 'success' },
  archived: { label: 'Архівний', tone: 'neutral' },
  corrected: { label: 'Переоблікований', tone: 'warning' },
};

function productLink(article) {
  return `/products/open?article=${encodeURIComponent(article)}`;
}

function ProductStatus({ status }) {
  const presentation = statusPresentation[status] || { label: status || 'Невідомо', tone: 'neutral' };
  return <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>;
}

function ProductRowActions({ product, canDecode }) {
  const location = useLocation();
  const article = product.publicSku;
  const currentProduct = product.status === 'active';
  return <div className="product-register-actions">
    <CopyButton label={`Скопіювати артикул ${article}`} value={article} />
    {canDecode && currentProduct && <Link className="btn btn-outline btn-icon" to={productLink(article)}
      state={{ productReturnTo: location.pathname + location.search, productReturnState: location.state }}
      aria-label={`Відкрити товар ${article}`} title="Відкрити товар">
      <ExternalLink size={15} aria-hidden="true" />
    </Link>}
    {!currentProduct && <Link className="btn btn-outline btn-icon"
      to={`/products/history?sku=${encodeURIComponent(product.internalSku)}`}
      aria-label={`Відкрити історію товару ${article}`} title="Відкрити історію товару">
      <ExternalLink size={15} aria-hidden="true" />
    </Link>}
  </div>;
}

export function ProductRegister({ canDecode = true, refreshKey = 0 }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const filterKey = searchParams.toString();
  const cursor = searchParams.get('cursor') || null;
  const requestedPage = Number.parseInt(searchParams.get('page') || '1', 10);
  const pageIndex = cursor && Number.isSafeInteger(requestedPage) && requestedPage > 1 ? requestedPage - 1 : 0;
  const back = Array.isArray(location.state?.productRegisterBack)
    ? location.state.productRegisterBack.filter((value) => value === null || typeof value === 'string')
    : [];
  const urlFilters = {
    search: searchParams.get('search') || '',
    category: searchParams.get('category') || '',
    lifecycle: searchParams.get('lifecycle') || 'current',
  };
  return <ProductRegisterContent key={filterKey} canDecode={canDecode} initialFilters={urlFilters}
    initialPage={{ cursor, index: pageIndex, back }} locationState={location.state}
    refreshKey={refreshKey} searchParams={searchParams} setSearchParams={setSearchParams} />;
}

function ProductRegisterContent({ canDecode, initialFilters, initialPage, locationState, refreshKey, searchParams, setSearchParams }) {
  const register = useProductRegister({ initialFilters, initialPage, refreshKey });
  const [draftSearch, setDraftSearch] = useState(initialFilters.search);

  const applyFilters = (nextFilters) => {
    const nextParams = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(nextFilters)) {
      if (value && !(key === 'lifecycle' && value === 'current')) nextParams.set(key, value);
      else nextParams.delete(key);
    }
    nextParams.delete('cursor');
    nextParams.delete('page');
    if (nextParams.toString() === searchParams.toString()) register.setFilters(nextFilters);
    else setSearchParams(nextParams, { state: { ...locationState, productRegisterBack: [], productRegisterScrollY: 0 } });
  };
  const nextPage = () => {
    if (!register.pageInfo.nextCursor) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('cursor', register.pageInfo.nextCursor);
    nextParams.set('page', String(register.pageIndex + 2));
    setSearchParams(nextParams, { state: {
      ...locationState,
      productRegisterBack: [...register.backCursors, register.currentCursor],
      productRegisterScrollY: window.scrollY,
    } });
  };
  const previousPage = () => {
    if (register.pageIndex === 0) return;
    const back = register.backCursors.slice(0, -1);
    const cursor = register.backCursors.at(-1) || null;
    const nextParams = new URLSearchParams(searchParams);
    if (cursor) nextParams.set('cursor', cursor); else nextParams.delete('cursor');
    if (register.pageIndex > 1) nextParams.set('page', String(register.pageIndex)); else nextParams.delete('page');
    setSearchParams(nextParams, { state: { ...locationState, productRegisterBack: back, productRegisterScrollY: window.scrollY } });
  };

  const submitSearch = (event) => {
    event.preventDefault();
    applyFilters({ ...register.filters, search: draftSearch.trim() });
  };
  const changeFilter = (key, value) => {
    applyFilters({ ...register.filters, [key]: value });
  };
  const reset = () => {
    setDraftSearch('');
    applyFilters({ search: '', category: '', lifecycle: 'current' });
  };

  return (
    <section className="product-register card" aria-labelledby="product-register-title">
      <div className="product-register-header">
        <div>
          <h2 id="product-register-title" className="section-title-text">Реєстр товарів</h2>
          <p className="section-subtitle mt-1">Пошук за артикулом або внутрішнім SKU.</p>
        </div>
        <button type="button" className="btn btn-outline btn-icon" onClick={register.refresh}
          disabled={register.loading} aria-label="Оновити реєстр" title="Оновити">
          <RefreshCw size={15} className={register.loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      <form className="product-register-toolbar" onSubmit={submitSearch}>
        <label className="product-register-search">
          <span className="sr-only">Пошук товарів</span>
          <Search size={16} aria-hidden="true" />
          <input className="input-sm" value={draftSearch}
            onChange={(event) => setDraftSearch(event.target.value)}
            placeholder="Артикул або внутрішній SKU" />
        </label>
        <select className="input-sm" aria-label="Категорія товарів" value={register.filters.category}
          onChange={(event) => changeFilter('category', event.target.value)}>
          <option value="">Усі категорії</option>
          {register.filterOptions.categories.map((category) => (
            <option key={category.code} value={category.code}>{category.name} · {category.code}</option>
          ))}
        </select>
        <select className="input-sm" aria-label="Стан товарів" value={register.filters.lifecycle}
          onChange={(event) => changeFilter('lifecycle', event.target.value)}>
          {Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="submit" className="btn btn-primary">Знайти</button>
        {(register.filters.search || register.filters.category || register.filters.lifecycle !== 'current') && (
          <button type="button" className="btn btn-ghost" onClick={reset}>Скинути</button>
        )}
      </form>

      {register.error && <div className="p-4"><Notice tone="error" actions={
        <button type="button" className="btn btn-outline" onClick={register.refresh}>Спробувати ще раз</button>
      }>{register.error}</Notice></div>}
      {register.loading ? <LoadingState compact label="Завантажуємо товари…" /> : !register.error && register.items.length === 0
        ? <EmptyState compact>Товарів за цими умовами не знайдено.</EmptyState>
        : !register.error && <>
          <div className="product-register-table-wrap">
            <table className="dense-table min-w-full">
              <caption className="sr-only">Товари: артикул, категорія, стан, вага, ціна та дії.</caption>
              <thead><tr className="table-head">
                <th scope="col" className="table-cell text-left">Артикул</th>
                <th scope="col" className="table-cell text-left">Категорія</th>
                <th scope="col" className="table-cell text-left">Стан</th>
                <th scope="col" className="table-cell text-right">Вага</th>
                <th scope="col" className="table-cell text-right">Ціна</th>
                <th scope="col" className="table-cell text-right"><span className="sr-only">Дії</span></th>
              </tr></thead>
              <tbody>{register.items.map((product) => <tr key={product.id}>
                <td className="table-cell" data-label="Артикул"><div className="font-mono font-semibold text-slate-900">{product.publicSku}</div></td>
                <td className="table-cell" data-label="Категорія"><div>{product.categoryName || product.categoryCode}</div><div className="text-xs text-slate-500">{product.categoryCode}</div></td>
                <td className="table-cell" data-label="Стан"><ProductStatus status={product.status} /></td>
                <td className="table-cell text-right tabular-nums" data-label="Вага">{Number(product.weight) > 0 ? `${formatDecimal(product.weight)} г` : '—'}</td>
                <td className="table-cell text-right font-medium tabular-nums" data-label="Ціна">{product.priceUah !== null && product.priceUah !== undefined ? formatUah(product.priceUah) : '—'}</td>
                <td className="table-cell" data-label="Дії"><ProductRowActions product={product} canDecode={canDecode} /></td>
              </tr>)}</tbody>
            </table>
          </div>
          {(register.pageIndex > 0 || register.pageInfo.hasMore) && <div className="product-register-pagination" aria-label="Сторінки реєстру">
            <button type="button" className="btn btn-outline" onClick={previousPage}
              disabled={register.pageIndex === 0 || register.loading}>Назад</button>
            <span>Сторінка {register.pageIndex + 1}</span>
            <button type="button" className="btn btn-outline" onClick={nextPage}
              disabled={!register.pageInfo.hasMore || register.loading}>Далі</button>
          </div>}
        </>}
    </section>
  );
}
