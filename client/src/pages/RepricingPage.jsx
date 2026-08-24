import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { getPricingAxis } from '../lib/pricing-axis';

const formatUah = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(Number(value))} ₴`;
};

const formatDate = (value) => (
  value ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '-'
);

const getApiError = (error) => error.response?.data?.error || error.message || 'Невідома помилка';

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

function ConfirmDialog({ changedCount, onCancel, onConfirm, pending }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-amber-600" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Застосувати переоцінку</h2>
            <p className="mt-2 text-sm text-slate-600">Буде оновлено ціну для {changedCount} товарів.</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <RefreshCw size={16} className={pending ? 'animate-spin' : ''} />
            {pending ? 'Застосування...' : 'Застосувати'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RepricingPage() {
  const [config, setConfig] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [batches, setBatches] = useState([]);
  const [scenarioId, setScenarioId] = useState('');
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('changed');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const [appliedBatch, setAppliedBatch] = useState(null);

  const loadBatches = () => api.get('/admin/repricing/batches').then((response) => {
    setBatches(response.data || []);
    return response.data || [];
  });

  useEffect(() => {
    Promise.all([
      api.get('/config'),
      api.get('/admin/repricing/scenarios'),
      api.get('/admin/repricing/batches'),
    ])
      .then(([configResponse, scenariosResponse, batchesResponse]) => {
        const nextScenarios = scenariosResponse.data || [];
        setConfig(configResponse.data);
        setScenarios(nextScenarios);
        setBatches(batchesResponse.data || []);
        const preferredScenario = nextScenarios.find((item) => item.price_mode === 'fixed_uah');
        setScenarioId(String(preferredScenario?.id || nextScenarios[0]?.id || ''));
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setLoading(false));
  }, []);

  const selectedScenario = scenarios.find((item) => Number(item.id) === Number(scenarioId));
  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toUpperCase();
    return (preview?.items || []).filter((item) => {
      if (filter !== 'all' && item.status !== filter) return false;
      return !normalizedSearch || String(item.sku || '').toUpperCase().includes(normalizedSearch);
    });
  }, [filter, preview, search]);

  const buildPreview = () => {
    if (!scenarioId || previewing) return;
    setPreviewing(true);
    setError('');
    setAppliedBatch(null);
    api.post('/admin/repricing/preview', { scenarioId: Number(scenarioId) })
      .then((response) => {
        setPreview(response.data);
        setFilter(response.data.summary.errorCount > 0 ? 'error' : 'changed');
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setPreviewing(false));
  };

  const applyPreview = () => {
    if (!preview || applying) return;
    setApplying(true);
    setError('');
    api.post('/admin/repricing/apply', {
      scenarioId: preview.scenario.id,
      previewToken: preview.previewToken,
    })
      .then((response) => {
        setAppliedBatch(response.data.batch);
        setPreview(null);
        setConfirmOpen(false);
        return loadBatches();
      })
      .catch((requestError) => {
        setConfirmOpen(false);
        setError(getApiError(requestError));
      })
      .finally(() => setApplying(false));
  };

  const downloadBatch = (batchId) => {
    api.get(`/admin/repricing/${batchId}/csv`, { responseType: 'blob' })
      .then((response) => downloadBlob(response.data, `amber-repricing-${batchId}.csv`))
      .catch((requestError) => setError(getApiError(requestError)));
  };

  if (loading) {
    return (
      <div className="min-h-screen app-bg flex items-center justify-center">
        <RefreshCw className="animate-spin text-slate-600" size={26} />
      </div>
    );
  }

  return (
    <div className="min-h-screen app-bg">
      <main className="mx-auto min-w-0 max-w-7xl space-y-8 overflow-hidden px-4 py-8 pb-24 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="eyebrow">Admin Workspace</p>
            <h1 className="page-title">Масова переоцінка</h1>
          </div>
          <Link to="/admin" className="btn btn-outline gap-2 self-start lg:self-auto">
            <ArrowLeft size={16} />
            До адмін-панелі
          </Link>
        </header>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {appliedBatch && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="flex items-center gap-3 text-sm text-emerald-900">
              <CheckCircle2 size={19} />
              <span>Оновлено товарів: {appliedBatch.changed_count ?? appliedBatch.changedCount}</span>
            </div>
            <button type="button" className="btn btn-outline gap-2" onClick={() => downloadBatch(appliedBatch.id)}>
              <Download size={16} />
              CSV для сайту
            </button>
          </div>
        )}

        <section className="card min-w-0 overflow-hidden">
          <div className="border-b border-slate-200 p-5 sm:p-6">
            <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-end">
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-semibold text-slate-600">Цінова матриця</span>
                <select
                  className="input-sm min-w-0 max-w-full"
                  value={scenarioId}
                  onChange={(event) => {
                    setScenarioId(event.target.value);
                    setPreview(null);
                    setAppliedBatch(null);
                  }}
                >
                  {scenarios.map((scenario) => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenario.category_code} — {scenario.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary gap-2 lg:min-w-56"
                onClick={buildPreview}
                disabled={!scenarioId || previewing}
              >
                <RefreshCw size={16} className={previewing ? 'animate-spin' : ''} />
                {previewing ? 'Розрахунок...' : 'Попередній перегляд'}
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

          {preview && (
            <>
              <div className="grid grid-cols-2 border-b border-slate-200 sm:grid-cols-5">
                {[
                  ['Знайдено', preview.summary.candidateCount],
                  ['Зміниться', preview.summary.changedCount],
                  ['Без змін', preview.summary.unchangedCount],
                  ['Пропущено', preview.summary.skippedCount],
                  ['Помилки', preview.summary.errorCount],
                ].map(([label, value]) => (
                  <div key={label} className="border-r border-slate-200 px-4 py-3 last:border-r-0">
                    <div className="text-xs text-slate-500">{label}</div>
                    <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
                  {[
                    ['changed', 'Зміняться'],
                    ['unchanged', 'Без змін'],
                    ['error', 'Помилки'],
                    ['all', 'Усі'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="relative block w-full sm:w-72">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    className="input-sm pl-9"
                    value={search}
                    placeholder="Пошук SKU"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </div>

              <div className="max-h-[560px] overflow-auto">
                <table className="min-w-full bg-white">
                  <thead className="sticky top-0 z-10">
                    <tr className="table-head">
                      <th className="table-cell text-left">Артикул</th>
                      <th className="table-cell text-left">Вага</th>
                      <th className="table-cell text-left">Умова</th>
                      <th className="table-cell text-right">Стара ціна</th>
                      <th className="table-cell text-right">Нова ціна</th>
                      <th className="table-cell text-right">Різниця</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => (
                      <tr key={item.productId} className="border-t border-slate-100">
                        <td className="table-cell font-mono text-xs font-semibold text-slate-800">{item.sku}</td>
                        <td className="table-cell whitespace-nowrap text-sm">{item.weight ?? '-'} г</td>
                        <td className="table-cell min-w-52 text-xs text-slate-600">
                          {item.status === 'error'
                            ? <span className="text-rose-700">{item.message}</span>
                            : getPricingBasis(config, preview.scenario.categoryCode, item)}
                        </td>
                        <td className="table-cell whitespace-nowrap text-right text-sm">{formatUah(item.oldPriceUah)}</td>
                        <td className="table-cell whitespace-nowrap text-right text-sm font-semibold">{formatUah(item.newPriceUah)}</td>
                        <td className={`table-cell whitespace-nowrap text-right text-sm font-semibold ${Number(item.priceDeltaUah) >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {item.status === 'error' ? '-' : formatUah(item.priceDeltaUah)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleItems.length === 0 && (
                  <div className="px-4 py-12 text-center text-sm text-slate-500">Немає рядків для цього фільтра.</div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4 sm:p-5">
                <span className="text-sm text-slate-500">Рядків у перегляді: {visibleItems.length}</span>
                <button
                  type="button"
                  className="btn btn-primary gap-2"
                  disabled={preview.summary.changedCount === 0 || preview.summary.errorCount > 0}
                  onClick={() => setConfirmOpen(true)}
                >
                  <CheckCircle2 size={16} />
                  Застосувати переоцінку
                </button>
              </div>
            </>
          )}
        </section>

        <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white/85">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-semibold text-slate-900">Історія переоцінок</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="table-head">
                  <th className="table-cell text-left">Дата</th>
                  <th className="table-cell text-left">Матриця</th>
                  <th className="table-cell text-right">Оновлено</th>
                  <th className="table-cell text-right">CSV</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="border-t border-slate-100">
                    <td className="table-cell whitespace-nowrap text-sm">{formatDate(batch.applied_at)}</td>
                    <td className="table-cell text-sm font-medium">{batch.category_code} — {batch.scenario_name}</td>
                    <td className="table-cell text-right text-sm">{batch.changed_count}</td>
                    <td className="table-cell text-right">
                      <button type="button" className="btn btn-outline px-3 py-1.5" onClick={() => downloadBatch(batch.id)} title="Завантажити CSV">
                        <Download size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {batches.length === 0 && <div className="px-5 py-8 text-sm text-slate-500">Історія порожня.</div>}
          </div>
        </section>
      </main>

      {confirmOpen && preview && (
        <ConfirmDialog
          changedCount={preview.summary.changedCount}
          pending={applying}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={applyPreview}
        />
      )}
    </div>
  );
}
