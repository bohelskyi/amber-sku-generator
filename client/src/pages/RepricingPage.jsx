import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Download,
  FilePenLine,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { getPricingAxis } from '../lib/pricing-axis';
import {
  applyManualPrices,
  getInvalidManualPriceIds,
  getManualOverrides,
  getRepricingSummary,
  parseManualPrice,
  sortRepricingItems,
} from '../lib/repricing';

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

function SortHeader({ align = 'left', children, column, onSort, sort }) {
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

function ConfirmDialog({ changedCount, manualCount, onCancel, onConfirm, pending }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-amber-600" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Застосувати переоцінку</h2>
            <p className="mt-2 text-sm text-slate-600">Буде оновлено ціну для {changedCount} товарів.</p>
            {manualCount > 0 && (
              <p className="mt-1 text-sm font-medium text-amber-700">
                Ручних коригувань: {manualCount}.
              </p>
            )}
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

function RollbackDialog({ batch, onCancel, onConfirm, pending }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <Undo2 className="mt-0.5 text-rose-600" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Відкотити переоцінку</h2>
            <p className="mt-2 text-sm text-slate-600">
              Для {batch.changed_count} товарів буде повернуто ціни, які були до партії #{batch.id}.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Якщо хоча б один товар пізніше змінювали, відкат не буде застосовано.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <Undo2 size={16} />
            {pending ? 'Відкат...' : 'Відкотити'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscardDraftDialog({ onCancel, onConfirm, pending }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <Trash2 className="mt-0.5 text-rose-600" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Відкинути чернетку?</h2>
            <p className="mt-2 text-sm text-slate-600">
              Збережені ручні ціни буде видалено. Товари та матриця не зміняться.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={pending}>
            Скасувати
          </button>
          <button type="button" className="btn btn-primary gap-2" onClick={onConfirm} disabled={pending}>
            <Trash2 size={16} />
            {pending ? 'Видаляємо...' : 'Відкинути'}
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
  const [drafts, setDrafts] = useState([]);
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
  const [manualPrices, setManualPrices] = useState({});
  const [sort, setSort] = useState({ key: 'sku', direction: 'asc' });
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [draftSync, setDraftSync] = useState(null);
  const [draftConflicts, setDraftConflicts] = useState([]);
  const [draftSaveState, setDraftSaveState] = useState('idle');
  const [discardDraftOpen, setDiscardDraftOpen] = useState(false);
  const [discardingDraft, setDiscardingDraft] = useState(false);

  const loadBatches = () => api.get('/admin/repricing/batches').then((response) => {
    setBatches(response.data || []);
    return response.data || [];
  });

  const loadDrafts = () => api.get('/admin/repricing/drafts').then((response) => {
    setDrafts(response.data || []);
    return response.data || [];
  });

  useEffect(() => {
    Promise.all([
      api.get('/admin/config'),
      api.get('/admin/repricing/scenarios'),
      api.get('/admin/repricing/batches'),
      api.get('/admin/repricing/drafts'),
    ])
      .then(([configResponse, scenariosResponse, batchesResponse, draftsResponse]) => {
        const nextScenarios = scenariosResponse.data || [];
        const nextDrafts = draftsResponse.data || [];
        setConfig(configResponse.data);
        setScenarios(nextScenarios);
        setBatches(batchesResponse.data || []);
        setDrafts(nextDrafts);
        const preferredScenario = nextScenarios.find((item) => item.price_mode === 'fixed_uah');
        setScenarioId(String(nextDrafts[0]?.scenarioId || preferredScenario?.id || nextScenarios[0]?.id || ''));
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setLoading(false));
  }, []);

  const selectedScenario = scenarios.find((item) => Number(item.id) === Number(scenarioId));
  const selectedDraft = drafts.find((item) => Number(item.scenarioId) === Number(scenarioId));
  const effectiveItems = useMemo(
    () => applyManualPrices(preview?.items || [], manualPrices),
    [manualPrices, preview]
  );
  const effectiveSummary = useMemo(
    () => getRepricingSummary(preview?.summary || {}, effectiveItems),
    [effectiveItems, preview]
  );
  const manualOverrides = useMemo(() => getManualOverrides(manualPrices), [manualPrices]);
  const invalidManualPriceIds = useMemo(
    () => new Set(getInvalidManualPriceIds(manualPrices)),
    [manualPrices]
  );
  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toUpperCase();
    const filteredItems = effectiveItems.filter((item) => {
      if (filter !== 'all' && item.status !== filter) return false;
      return !normalizedSearch || String(item.sku || '').toUpperCase().includes(normalizedSearch);
    });
    return sortRepricingItems(filteredItems, sort);
  }, [effectiveItems, filter, search, sort]);

  const handleSort = (key) => {
    setSort((currentSort) => ({
      key,
      direction: currentSort.key === key && currentSort.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const setManualPrice = (productId, value) => {
    setManualPrices((currentPrices) => ({ ...currentPrices, [productId]: value }));
  };

  const resetManualPrice = (productId) => {
    setManualPrices((currentPrices) => {
      const nextPrices = { ...currentPrices };
      delete nextPrices[productId];
      return nextPrices;
    });
  };

  const getDraftUiState = () => ({ filter, search, sort });

  const applyDraftPayload = (data) => {
    const nextManualPrices = Object.fromEntries(
      (data.manualOverrides || data.draft?.manualOverrides || []).map((item) => (
        [item.productId, String(item.newPriceUah)]
      ))
    );
    const uiState = data.draft?.uiState || {};
    setActiveDraft(data.draft);
    if (data.preview) setPreview(data.preview);
    setManualPrices(nextManualPrices);
    setDraftSync(data.sync || null);
    setDraftConflicts(data.conflicts || []);
    setFilter(uiState.filter || (data.preview?.summary?.errorCount > 0 ? 'error' : 'changed'));
    setSearch(uiState.search || '');
    setSort(uiState.sort || { key: 'sku', direction: 'asc' });
    setDraftSaveState('saved');
  };

  const openDraft = (draftId) => {
    if (!draftId || previewing) return;
    setPreviewing(true);
    setError('');
    setAppliedBatch(null);
    api.get(`/admin/repricing/drafts/${draftId}`)
      .then((response) => applyDraftPayload(response.data))
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setPreviewing(false));
  };

  const saveDraft = ({ automatic = false } = {}) => {
    if (!preview || invalidManualPriceIds.size > 0) return Promise.resolve(null);
    if (!automatic) setDraftSaveState('saving');
    const payload = {
      scenarioId: preview.scenario.id,
      manualOverrides,
      uiState: getDraftUiState(),
    };
    const request = activeDraft
      ? api.put(`/admin/repricing/drafts/${activeDraft.id}`, payload)
      : api.post('/admin/repricing/drafts', payload);

    setDraftSaveState('saving');
    return request
      .then((response) => {
        const nextDraft = response.data.draft;
        setActiveDraft(nextDraft);
        if (response.data.preview) {
          setDraftSync(response.data.sync || null);
          setDraftConflicts(response.data.conflicts || []);
        }
        setDraftSaveState('saved');
        return loadDrafts().then(() => nextDraft);
      })
      .catch((requestError) => {
        setDraftSaveState('error');
        if (!automatic) setError(getApiError(requestError));
        throw requestError;
      });
  };

  useEffect(() => {
    if (!preview || invalidManualPriceIds.size > 0) return undefined;
    if (draftConflicts.length > 0) return undefined;
    if (!activeDraft && manualOverrides.length === 0) return undefined;

    const timeoutId = window.setTimeout(() => {
      saveDraft({ automatic: true }).catch(() => {});
    }, 800);
    return () => window.clearTimeout(timeoutId);
  // Saving depends on the editable state, while saveDraft itself intentionally stays local.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDraft?.id, draftConflicts.length, filter, manualPrices, search, sort]);

  const buildPreview = () => {
    if (!scenarioId || previewing) return;
    setPreviewing(true);
    setError('');
    setAppliedBatch(null);
    setActiveDraft(null);
    setDraftSync(null);
    setDraftConflicts([]);
    setDraftSaveState('idle');
    setManualPrices({});
    api.post('/admin/repricing/preview', { scenarioId: Number(scenarioId) })
      .then((response) => {
        setPreview(response.data);
        setFilter(response.data.summary.errorCount > 0 ? 'error' : 'changed');
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setPreviewing(false));
  };

  const openSelectedRepricing = () => {
    if (selectedDraft) openDraft(selectedDraft.id);
    else buildPreview();
  };

  const syncDraft = async () => {
    if (!activeDraft || previewing) return;
    if (invalidManualPriceIds.size > 0) {
      setError('Виправте некоректну ручну ціну перед оновленням чернетки.');
      return;
    }
    if (draftConflicts.length > 0) {
      setError('Спочатку вирішіть конфлікти ручних цін у чернетці.');
      return;
    }
    setPreviewing(true);
    setError('');
    try {
      await saveDraft();
      const response = await api.post(`/admin/repricing/drafts/${activeDraft.id}/sync`);
      applyDraftPayload(response.data);
    } catch (requestError) {
      setError(getApiError(requestError));
    } finally {
      setPreviewing(false);
    }
  };

  const removeDraftConflicts = () => {
    const conflictIds = new Set(draftConflicts.map((item) => Number(item.productId)));
    setManualPrices((currentPrices) => Object.fromEntries(
      Object.entries(currentPrices).filter(([productId]) => !conflictIds.has(Number(productId)))
    ));
    setDraftConflicts([]);
    setDraftSaveState('saving');
  };

  const discardDraft = () => {
    if (!activeDraft || discardingDraft) return;
    setDiscardingDraft(true);
    setError('');
    api.delete(`/admin/repricing/drafts/${activeDraft.id}`)
      .then(() => {
        setDiscardDraftOpen(false);
        setActiveDraft(null);
        setPreview(null);
        setManualPrices({});
        setDraftSync(null);
        setDraftConflicts([]);
        setDraftSaveState('idle');
        return loadDrafts();
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setDiscardingDraft(false));
  };

  const applyPreview = async () => {
    if (!preview || applying) return;
    setApplying(true);
    setError('');
    try {
      let draftForApply = activeDraft;
      if (activeDraft) draftForApply = await saveDraft();
      const response = await api.post('/admin/repricing/apply', {
        scenarioId: preview.scenario.id,
        previewToken: preview.previewToken,
        manualOverrides,
        draftId: draftForApply?.id || null,
      });
      setAppliedBatch(response.data.batch);
      setPreview(null);
      setManualPrices({});
      setActiveDraft(null);
      setDraftSync(null);
      setDraftConflicts([]);
      setDraftSaveState('idle');
      setConfirmOpen(false);
      await Promise.all([loadBatches(), loadDrafts()]);
    } catch (requestError) {
      setConfirmOpen(false);
      setError(getApiError(requestError));
    } finally {
      setApplying(false);
    }
  };

  const downloadBatch = (batchId) => {
    api.get(`/admin/repricing/${batchId}/csv`, { responseType: 'blob' })
      .then((response) => downloadBlob(response.data, `amber-repricing-${batchId}.csv`))
      .catch((requestError) => setError(getApiError(requestError)));
  };

  const downloadRollbackBatch = (batchId) => {
    api.get(`/admin/repricing/${batchId}/rollback-csv`, { responseType: 'blob' })
      .then((response) => downloadBlob(response.data, `amber-repricing-rollback-${batchId}.csv`))
      .catch((requestError) => setError(getApiError(requestError)));
  };

  const rollbackBatch = () => {
    if (!rollbackTarget || rollingBack) return;
    setRollingBack(true);
    setError('');
    api.post(`/admin/repricing/${rollbackTarget.id}/rollback`)
      .then((response) => {
        setRollbackResult(response.data.batch);
        setRollbackTarget(null);
        setAppliedBatch(null);
        return loadBatches();
      })
      .catch((requestError) => {
        setRollbackTarget(null);
        setError(getApiError(requestError));
      })
      .finally(() => setRollingBack(false));
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

        {rollbackResult && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-center gap-3 text-sm text-amber-900">
              <Undo2 size={19} />
              <span>Переоцінку #{rollbackResult.id} відкочено. Старі ціни повернено.</span>
            </div>
            <button type="button" className="btn btn-outline gap-2" onClick={() => downloadRollbackBatch(rollbackResult.id)}>
              <Download size={16} />
              CSV відкату
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
                    setManualPrices({});
                    setActiveDraft(null);
                    setDraftSync(null);
                    setDraftConflicts([]);
                    setDraftSaveState('idle');
                  }}
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
                {selectedDraft ? <FilePenLine size={16} /> : <RefreshCw size={16} className={previewing ? 'animate-spin' : ''} />}
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

          {preview && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
                <div className="flex min-w-0 items-center gap-3 text-sm">
                  <FilePenLine size={18} className={activeDraft ? 'text-amber-700' : 'text-slate-500'} />
                  {activeDraft ? (
                    <div className="min-w-0">
                      <span className="font-semibold text-slate-800">Чернетка #{activeDraft.id}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {draftSaveState === 'saving'
                          ? 'Зберігаємо...'
                          : draftSaveState === 'error'
                            ? 'Не вдалося зберегти'
                            : `Збережено ${formatDate(activeDraft.updatedAt)}`}
                      </span>
                    </div>
                  ) : (
                    <span className="text-slate-600">Перегляд ще не збережено</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeDraft ? (
                    <>
                      <button type="button" className="btn btn-outline gap-2" onClick={syncDraft} disabled={previewing || invalidManualPriceIds.size > 0}>
                        <RefreshCw size={15} className={previewing ? 'animate-spin' : ''} />
                        Оновити список
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline flex h-9 w-9 items-center justify-center p-0 text-rose-700"
                        onClick={() => setDiscardDraftOpen(true)}
                        title="Відкинути чернетку"
                        aria-label="Відкинути чернетку"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-outline gap-2"
                      onClick={() => saveDraft().catch(() => {})}
                      disabled={invalidManualPriceIds.size > 0}
                    >
                      <Save size={15} />
                      Зберегти чернетку
                    </button>
                  )}
                </div>
              </div>

              {activeDraft && draftSync?.hasChanges && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                    <span>
                      Дані або розрахунок змінилися після збереження чернетки:
                      {draftSync.contextChanged ? ' матрицю оновлено;' : ''}
                      {' '}додано {draftSync.added.length}, прибрано {draftSync.removed.length},
                      {' '}перераховано {draftSync.changed.length}.
                    </span>
                  </div>
                  <button type="button" className="btn btn-outline gap-2" onClick={syncDraft} disabled={previewing || invalidManualPriceIds.size > 0}>
                    <RefreshCw size={15} />
                    Прийняти оновлення
                  </button>
                </div>
              )}

              {draftConflicts.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 sm:px-5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                    <span>
                      {draftConflicts.length} ручних цін більше не належать цій переоцінці:
                      {' '}{draftConflicts.map((item) => item.sku).join(', ')}.
                    </span>
                  </div>
                  <button type="button" className="btn btn-outline" onClick={removeDraftConflicts}>
                    Відкинути недоступні ціни
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 border-b border-slate-200 sm:grid-cols-5">
                {[
                  ['Знайдено', preview.summary.candidateCount],
                  ['Зміниться', effectiveSummary.changedCount],
                  ['Без змін', effectiveSummary.unchangedCount],
                  ['Пропущено', preview.summary.skippedCount],
                  ['Помилки', effectiveSummary.errorCount],
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

              <div className="relative isolate max-h-[560px] overflow-auto">
                <table className="min-w-full bg-white">
                  <thead>
                    <tr className="table-head">
                      <SortHeader column="sku" sort={sort} onSort={handleSort}>Артикул</SortHeader>
                      <SortHeader column="weight" sort={sort} onSort={handleSort}>Вага</SortHeader>
                      <th className="table-cell sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-left shadow-[0_1px_0_rgba(148,163,184,0.35)]">Умова</th>
                      <SortHeader align="right" column="oldPriceUah" sort={sort} onSort={handleSort}>Стара ціна</SortHeader>
                      <SortHeader align="right" column="newPriceUah" sort={sort} onSort={handleSort}>Нова ціна</SortHeader>
                      <SortHeader align="right" column="priceDeltaUah" sort={sort} onSort={handleSort}>Різниця</SortHeader>
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
                        <td className="table-cell min-w-44 whitespace-nowrap text-right text-sm font-semibold">
                          {item.status === 'error' ? '-' : (
                            <div className="flex flex-col items-end gap-1">
                              <div className="flex items-center justify-end gap-1.5">
                                <div className="relative">
                                  <input
                                    className={`input-sm w-28 pr-7 text-right font-semibold ${invalidManualPriceIds.has(item.productId) ? 'border-rose-400 focus:border-rose-500' : ''}`}
                                    inputMode="decimal"
                                    aria-label={`Нова ціна для ${item.sku}`}
                                    value={Object.prototype.hasOwnProperty.call(manualPrices, item.productId)
                                      ? manualPrices[item.productId]
                                      : item.newPriceUah}
                                    onChange={(event) => setManualPrice(item.productId, event.target.value)}
                                    onBlur={(event) => {
                                      const normalizedPrice = parseManualPrice(event.target.value);
                                      if (normalizedPrice !== null) setManualPrice(item.productId, String(normalizedPrice));
                                    }}
                                  />
                                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-normal text-slate-400">₴</span>
                                </div>
                                {Object.prototype.hasOwnProperty.call(manualPrices, item.productId) && (
                                  <button
                                    type="button"
                                    className="btn btn-outline flex h-8 w-8 shrink-0 items-center justify-center p-0"
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
                                  Вручну · матриця {formatUah(item.calculatedPriceUah)}
                                </span>
                              )}
                              {invalidManualPriceIds.has(item.productId) && (
                                <span className="text-[10px] font-medium text-rose-600">Вкажіть ціну більше нуля</span>
                              )}
                            </div>
                          )}
                        </td>
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
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span>Рядків у перегляді: {visibleItems.length}</span>
                  {manualOverrides.length > 0 && (
                    <span className="font-medium text-amber-700">Ручних цін: {manualOverrides.length}</span>
                  )}
                  {activeDraft && draftSaveState === 'saving' && (
                    <span className="font-medium text-slate-600">Зберігаємо чернетку...</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-primary gap-2"
                  disabled={effectiveSummary.changedCount === 0
                    || effectiveSummary.errorCount > 0
                    || invalidManualPriceIds.size > 0
                    || draftConflicts.length > 0
                    || Boolean(activeDraft && draftSync?.hasChanges)}
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
                  <th className="table-cell text-left">Статус</th>
                  <th className="table-cell text-right">Оновлено</th>
                  <th className="table-cell text-right">CSV</th>
                  <th className="table-cell text-right">Дія</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="border-t border-slate-100">
                    <td className="table-cell whitespace-nowrap text-sm">{formatDate(batch.applied_at)}</td>
                    <td className="table-cell text-sm font-medium">{batch.category_code} — {batch.scenario_name}</td>
                    <td className="table-cell text-sm">
                      {batch.status === 'rolled_back' ? (
                        <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
                          Відкочено
                        </span>
                      ) : (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                          Застосовано
                        </span>
                      )}
                    </td>
                    <td className="table-cell text-right text-sm">{batch.changed_count}</td>
                    <td className="table-cell text-right">
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className="btn btn-outline flex h-8 w-8 items-center justify-center p-0" onClick={() => downloadBatch(batch.id)} title="CSV застосованих цін">
                          <Download size={15} />
                        </button>
                        {batch.status === 'rolled_back' && (
                          <button type="button" className="btn btn-outline flex h-8 w-8 items-center justify-center p-0" onClick={() => downloadRollbackBatch(batch.id)} title="CSV відновлених цін">
                            <Undo2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="table-cell text-right">
                      {batch.status === 'completed' && (
                        <button
                          type="button"
                          className="btn btn-outline flex h-8 w-8 items-center justify-center p-0 ml-auto disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => setRollbackTarget(batch)}
                          disabled={!batch.can_rollback}
                          title={batch.can_rollback
                            ? 'Відкотити переоцінку'
                            : 'Після цієї партії товари вже змінювали'}
                          aria-label={`Відкотити переоцінку ${batch.id}`}
                        >
                          <Undo2 size={15} />
                        </button>
                      )}
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
          changedCount={effectiveSummary.changedCount}
          manualCount={manualOverrides.length}
          pending={applying}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={applyPreview}
        />
      )}

      {rollbackTarget && (
        <RollbackDialog
          batch={rollbackTarget}
          pending={rollingBack}
          onCancel={() => setRollbackTarget(null)}
          onConfirm={rollbackBatch}
        />
      )}

      {discardDraftOpen && activeDraft && (
        <DiscardDraftDialog
          pending={discardingDraft}
          onCancel={() => setDiscardDraftOpen(false)}
          onConfirm={discardDraft}
        />
      )}
    </div>
  );
}
