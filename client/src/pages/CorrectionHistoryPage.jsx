import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Copy,
  Download,
  House,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { copyPlainText } from '../lib/clipboard';
import { formatDateTime, formatDecimal, formatUah } from '../lib/formatters';

function getApiError(error) {
  return error.response?.data?.error || error.message || 'Невідома помилка';
}

function useDebouncedValue(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeoutId);
  }, [delay, value]);
  return debouncedValue;
}

function formatUsdPerGram(value) {
  if (value === null || value === undefined || value === '') return '---';
  const number = Number(value);
  return Number.isFinite(number) ? `$${formatDecimal(value)}/г` : '---';
}

function formatSignedUah(value) {
  const number = Number(value || 0);
  const formatted = formatUah(Math.abs(number));
  if (number > 0) return `+${formatted}`;
  if (number < 0) return `-${formatted}`;
  return formatted;
}

function CopyButton({ label, value }) {
  return (
    <button
      type="button"
      className="btn btn-outline flex h-8 w-8 shrink-0 items-center justify-center p-0"
      onClick={() => copyPlainText(value)}
      title={label}
      aria-label={label}
    >
      <Copy size={14} />
    </button>
  );
}

function SkuTransition({ item }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase text-slate-500">Було</div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-800">
            {item.sourceSku}
          </span>
          <CopyButton label="Скопіювати старий артикул" value={item.sourceSku} />
        </div>
      </div>
      <ArrowRight size={16} className="hidden text-slate-400 sm:block" />
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase text-[#8a5f2b]">Стало</div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">
            {item.correctedSku}
          </span>
          <CopyButton label="Скопіювати новий артикул" value={item.correctedSku} />
        </div>
      </div>
    </div>
  );
}

function PriceTransition({ item }) {
  const deltaClass = Number(item.priceDeltaUah) > 0
    ? 'text-emerald-700'
    : Number(item.priceDeltaUah) < 0
      ? 'text-rose-700'
      : 'text-slate-600';

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-500">Ціна</span>
        <span className="flex flex-wrap items-center justify-end gap-1.5 font-semibold text-slate-900">
          {formatUah(item.oldPriceUah)}
          <ArrowRight size={13} className="text-slate-400" />
          {formatUah(item.newPriceUah)}
        </span>
      </div>
      {(item.oldPricePerGram !== null || item.newPricePerGram !== null) && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500">За грам</span>
          <span className="flex flex-wrap items-center justify-end gap-1.5 text-slate-700">
            {formatUsdPerGram(item.oldPricePerGram)}
            <ArrowRight size={13} className="text-slate-400" />
            <strong className="font-semibold text-slate-900">
              {formatUsdPerGram(item.newPricePerGram)}
            </strong>
          </span>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
        <span className="text-slate-500">Різниця</span>
        <strong className={`font-semibold ${deltaClass}`}>{formatSignedUah(item.priceDeltaUah)}</strong>
      </div>
    </div>
  );
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function CorrectionHistoryPage() {
  const [searchParams] = useSearchParams();
  const isAdminView = searchParams.get('from') === 'admin';
  const latestRequestId = useRef(0);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({});
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const params = useMemo(() => ({
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(category ? { category } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }), [category, debouncedSearch, from, to]);

  useEffect(() => {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    api.get('/admin/product-corrections', { params })
      .then((response) => {
        if (latestRequestId.current !== requestId) return;
        setError('');
        setItems(response.data.items || []);
        setSummary(response.data.summary || {});
        setCategories(response.data.categories || []);
      })
      .catch((requestError) => {
        if (latestRequestId.current === requestId) setError(getApiError(requestError));
      })
      .finally(() => {
        if (latestRequestId.current === requestId) setLoading(false);
      });
  }, [params]);

  const clearFilters = () => {
    setSearch('');
    setCategory('');
    setFrom('');
    setTo('');
  };

  const loadMore = async () => {
    if (loadingMore || items.length >= Number(summary.totalCount || 0)) return;
    const requestId = latestRequestId.current;
    setLoadingMore(true);
    setError('');
    try {
      const response = await api.get('/admin/product-corrections', {
        params: { ...params, offset: items.length },
      });
      if (latestRequestId.current !== requestId) return;
      setItems((currentItems) => [...currentItems, ...(response.data.items || [])]);
    } catch (requestError) {
      setError(getApiError(requestError));
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const response = await api.get('/admin/product-corrections/csv', {
        params,
        responseType: 'blob',
      });
      downloadBlob(response.data, 'amber-correction-history.csv');
    } catch (requestError) {
      setError(getApiError(requestError));
    } finally {
      setExporting(false);
    }
  };

  const hasFilters = Boolean(search || category || from || to);

  return (
    <div className="app-page">
      <main className="mx-auto w-full min-w-0 max-w-7xl space-y-5 overflow-hidden px-4 py-4 pb-20 sm:px-6 sm:py-6">
        <header className="console-header">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Історія переобліків</h1>
            <p className="mt-1 text-xs text-slate-500">Зміни SKU, характеристик і цін.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isAdminView && (
              <Link to="/admin" className="btn btn-outline">
                Адмін-панель
              </Link>
            )}
            <Link to="/" className="btn btn-outline gap-2">
              <House size={16} />
              На головну
            </Link>
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="card grid grid-cols-2 overflow-hidden lg:grid-cols-5">
          {[
            ['Усього', summary.totalCount || 0, 'text-slate-900'],
            ['Ціна зросла', summary.increasedCount || 0, 'text-emerald-700'],
            ['Ціна зменшилась', summary.decreasedCount || 0, 'text-rose-700'],
            ['Без зміни ціни', summary.unchangedCount || 0, 'text-slate-700'],
            ['Сумарна різниця', formatSignedUah(summary.netPriceDeltaUah), 'text-slate-900'],
          ].map(([label, value, valueClass]) => (
            <div
              key={label}
              className={`border-b border-r border-slate-200 px-4 py-4 last:border-r-0 sm:px-5 lg:border-b-0 ${label === 'Сумарна різниця' ? 'col-span-2 lg:col-span-1' : ''}`}
            >
              <div className="text-xs font-medium text-slate-500">{label}</div>
              <div className={`mt-1 text-xl font-semibold ${valueClass}`}>{value}</div>
            </div>
          ))}
        </section>

        <section className="card min-w-0 overflow-hidden">
          <div className="grid gap-3 border-b border-slate-200 p-4 sm:p-5 lg:grid-cols-[minmax(220px,1fr)_180px_160px_160px_auto] lg:items-end">
            <label className="relative block min-w-0">
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">Пошук</span>
              <Search size={16} className="absolute bottom-2.5 left-3 text-slate-400" />
              <input
                className="input-sm pl-9"
                value={search}
                placeholder="Старий або новий SKU"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">Категорія</span>
              <select className="input-sm" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">Усі категорії</option>
                {categories.map((item) => (
                  <option key={item.code} value={item.code}>{item.code} · {item.name} ({item.count})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">Від дати</span>
              <input type="date" className="input-sm" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">До дати</span>
              <input type="date" className="input-sm" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <div className="flex gap-2">
              {hasFilters && (
                <button type="button" className="btn btn-outline flex h-10 w-10 shrink-0 items-center justify-center p-0" onClick={clearFilters} title="Скинути фільтри" aria-label="Скинути фільтри">
                  <RotateCcw size={16} />
                </button>
              )}
              <button type="button" className="btn btn-primary flex-1 gap-2 whitespace-nowrap" onClick={exportCsv} disabled={exporting || summary.totalCount === 0}>
                <Download size={16} />
                {exporting ? 'Експортуємо...' : 'CSV'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <RefreshCw size={24} className="animate-spin text-slate-500" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">Переобліків за цими умовами не знайдено.</div>
          ) : (
            <div className="divide-y divide-slate-200">
              {items.map((item) => (
                <article key={item.id} className="p-4 sm:p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip">{item.categoryCode}</span>
                      <span className="text-xs font-medium text-slate-500">#{item.id} · {formatDateTime(item.createdAt)}</span>
                      {item.weight !== null && item.weight !== undefined && (
                        <span className="text-xs text-slate-500">{formatDecimal(item.weight)} г</span>
                      )}
                    </div>
                    {item.reason && <span className="text-sm text-slate-600">{item.reason}</span>}
                  </div>

                  <div className="grid gap-5 xl:grid-cols-[minmax(360px,1.1fr)_minmax(300px,1fr)_minmax(250px,0.7fr)]">
                    <SkuTransition item={item} />

                    <div className="min-w-0">
                      <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Змінені характеристики</div>
                      <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                        {item.changes.map((change) => (
                          <div key={change.key} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(110px,0.7fr)_minmax(0,1.3fr)]">
                            <span className="font-medium text-slate-600">{change.questionLabel}</span>
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-slate-700">
                              <span>{change.fromLabel}</span>
                              <ArrowRight size={13} className="shrink-0 text-slate-400" />
                              <strong className="font-semibold text-slate-900">{change.toLabel}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50/70 p-3">
                      <PriceTransition item={item} />
                      {(item.oldMatrixName || item.newMatrixName) && (
                        <div className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-600">
                          <span>{item.oldMatrixName || 'Матрицю не збережено'}</span>
                          <ArrowRight size={12} className="mx-1 inline text-slate-400" />
                          <strong className="font-semibold text-slate-800">{item.newMatrixName || 'Матрицю не збережено'}</strong>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {!loading && items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-500 sm:px-5">
              <span>Показано {items.length} із {summary.totalCount || 0}</span>
              {items.length < Number(summary.totalCount || 0) && (
                <button type="button" className="btn btn-outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Завантажуємо...' : 'Показати ще'}
                </button>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
