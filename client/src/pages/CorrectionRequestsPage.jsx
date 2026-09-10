import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Copy,
  House,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, EmptyState, LoadingState, Notice } from '../components/app/UiPrimitives.jsx';
import { useDialogAccessibility } from '../hooks/useDialogAccessibility';
import { getAnswerValueLabel, getQuestionLabel } from '../lib/answer-labels';
import { api } from '../lib/api';
import { copyPlainText } from '../lib/clipboard';
import { formatDateTime, formatUah } from '../lib/formatters';
import { getPermissionUiState } from '../lib/permission-ui.js';
import {
  createLatestRequestGate,
  createVisibilityAwarePoller,
  getCorrectionClaimOwnership,
  getCorrectionLegacyClaimToken,
  getCorrectionRequestsForView,
  isCorrectionClaimConflict,
  readCorrectionClaims,
  reconcileCorrectionClaims,
  removeCorrectionClaim,
  writeCorrectionClaims,
} from '../lib/correction-queue';

const STATUS_LABELS = {
  pending: 'Очікує',
  in_progress: 'В роботі',
  completed: 'Виконано',
  rejected: 'Відхилено',
};

const STATUS_CLASSES = {
  pending: 'is-pending',
  in_progress: 'is-progress',
  completed: 'is-completed',
  rejected: 'is-rejected',
};

const FILTERS = [
  ['active', 'Активні', 'active'],
  ['workspace', 'Робоча область', null],
  ['pending', 'Очікують', 'pending'],
  ['in_progress', 'В роботі', 'inProgress'],
  ['completed', 'Виконані', 'completed'],
  ['rejected', 'Відхилені', 'rejected'],
  ['all', 'Усі', 'all'],
];

function getApiError(error) {
  return error.response?.data?.error || error.message || 'Невідома помилка';
}

function getEmployeeLabel(user) {
  return user?.displayName || user?.preferredUsername || (user?.id ? `Працівник #${user.id}` : null);
}

function CopyButton({ label, value }) {
  return (
    <button
      type="button"
      className="btn btn-outline btn-icon"
      onClick={() => copyPlainText(value)}
      aria-label={label}
      title={label}
    >
      <Copy size={14} />
    </button>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`status-badge ${STATUS_CLASSES[status] || STATUS_CLASSES.pending}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function RequestChanges({ config, request }) {
  return (
    <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
      {request.changes.map((change) => (
        <div
          key={change.key}
          className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1.4fr)] sm:gap-3"
        >
          <span className="font-medium text-slate-600">
            {getQuestionLabel(config, request.categoryCode, change.key)}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-slate-700">
            <span>{getAnswerValueLabel(config, request.categoryCode, change.key, change.from)}</span>
            <ArrowRight size={13} className="shrink-0 text-slate-400" />
            <strong className="font-semibold text-slate-900">
              {getAnswerValueLabel(config, request.categoryCode, change.key, change.to)}
            </strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function CompletionDialog({ busy, request, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useDialogAccessibility({
    closeDisabled: busy,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    isOpen: Boolean(request),
    onClose: onCancel,
  });

  if (!request) return null;

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="completion-dialog-title"
        tabIndex={-1}
        className="dialog-surface max-w-lg"
      >
        <div className="dialog-header">
          <p className="eyebrow">Завершення запиту #{request.id}</p>
          <h2 id="completion-dialog-title" className="mt-1 text-xl font-semibold text-slate-900">Сайт уже оновлено?</h2>
        </div>
        <div className="dialog-body space-y-4 px-5 py-5 sm:px-6">
          <div className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono font-semibold">{request.sourceSku}</span>
              <ArrowRight size={15} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 break-all text-right font-mono font-semibold">{request.proposedSku}</span>
            </div>
            <div className="text-right font-semibold text-slate-900">
              {formatUah(request.proposedPayload?.totalPriceUah)}
            </div>
          </div>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-slate-700">
            Після підтвердження SKU Manager виконає переоблік і закриє цей запит.
          </div>
        </div>
        <div className="dialog-footer grid gap-3 sm:grid-cols-2">
          <button type="button" className="btn btn-outline order-2 sm:order-1" onClick={onCancel} disabled={busy}>
            Повернутися
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary order-1 gap-2 sm:order-2" onClick={onConfirm} disabled={busy}>
            <CheckCircle2 size={16} />
            {busy ? 'Підтверджуємо...' : 'Підтвердити виправлення'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CorrectionRequestsPage() {
  const auth = useAuth();
  const currentUserId = auth.applicationUser?.id;
  const permissionUi = getPermissionUiState(auth.permissions);
  const canClaim = permissionUi.canClaimCorrections;
  const canComplete = permissionUi.canCompleteCorrections;
  const canForceRelease = permissionUi.canForceReleaseCorrections;
  const canReject = permissionUi.canRejectCorrections;
  const canViewCatalogOrPricing = permissionUi.canViewCatalog || permissionUi.canViewPricing;
  const [searchParams] = useSearchParams();
  const focusedRequestId = Number(searchParams.get('request') || 0);
  const isAdminView = searchParams.get('from') === 'admin';
  const [config, setConfig] = useState(null);
  const [requests, setRequests] = useState([]);
  const [summary, setSummary] = useState({});
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [completionTarget, setCompletionTarget] = useState(null);
  const completionTargetRef = useRef(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [claims, setClaims] = useState(() => readCorrectionClaims());
  const [queueRefreshFailed, setQueueRefreshFailed] = useState(false);
  const requestGate = useRef(createLatestRequestGate());
  const activeFilterRef = useRef('active');

  const persistClaims = useCallback((updater) => {
    setClaims((currentClaims) => {
      const nextClaims = typeof updater === 'function' ? updater(currentClaims) : updater;
      writeCorrectionClaims(nextClaims);
      return nextClaims;
    });
  }, []);

  const loadRequests = useCallback(async (nextFilter) => {
    const loadId = requestGate.current.next();
    const response = await api.get('/admin/correction-requests', {
      params: { status: nextFilter === 'workspace' ? 'active' : nextFilter },
    });
    if (
      !requestGate.current.isLatest(loadId)
      || nextFilter !== activeFilterRef.current
    ) return false;
    const nextRequests = response.data.items || [];
    setRequests(nextRequests);
    setSummary(response.data.summary || {});
    persistClaims((currentClaims) => reconcileCorrectionClaims(currentClaims, nextRequests));
    const currentTarget = completionTargetRef.current;
    if (currentTarget) {
      const currentRequest = nextRequests.find(
        (request) => Number(request.id) === Number(currentTarget.id)
      );
      if (
        !currentRequest
        || currentRequest.status !== 'in_progress'
        || currentRequest.updatedAt !== currentTarget.updatedAt
      ) {
        completionTargetRef.current = null;
        setCompletionTarget(null);
        setSuccess(`Запит #${currentTarget.id} змінився в іншому вікні. Чергу оновлено.`);
      }
    }
    return true;
  }, [persistClaims]);

  useEffect(() => {
    Promise.all([api.get('/config'), loadRequests('active')])
      .then(([configResponse]) => {
        setConfig(configResponse.data);
      })
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setLoading(false));
  }, [loadRequests]);

  useEffect(() => createVisibilityAwarePoller({
    poll: async () => {
      try {
        await loadRequests(filter);
        setQueueRefreshFailed(false);
      } catch {
        setQueueRefreshFailed(true);
      }
    },
  }), [filter, loadRequests]);

  useEffect(() => {
    if (!focusedRequestId || loading) return;
    document.getElementById(`correction-request-${focusedRequestId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [focusedRequestId, loading, requests]);

  const visibleRequests = useMemo(() => {
    const orderedRequests = getCorrectionRequestsForView(
      requests,
      currentUserId,
      claims,
      filter
    );
    const normalizedSearch = search.trim().toUpperCase();
    if (!normalizedSearch) return orderedRequests;
    return orderedRequests.filter((request) => (
      request.sourceSku.includes(normalizedSearch)
      || request.proposedSku.includes(normalizedSearch)
      || request.comment.toUpperCase().includes(normalizedSearch)
    ));
  }, [claims, currentUserId, filter, requests, search]);

  const changeFilter = (nextFilter) => {
    if (nextFilter === filter || loading) return;
    activeFilterRef.current = nextFilter;
    setFilter(nextFilter);
    setLoading(true);
    setError('');
    loadRequests(nextFilter)
      .catch((requestError) => setError(getApiError(requestError)))
      .finally(() => setLoading(false));
  };

  const getClaimHeaders = (request) => {
    const claimToken = getCorrectionLegacyClaimToken(request, claims);
    return claimToken ? { 'X-Correction-Claim-Token': claimToken } : {};
  };

  const clearClaim = (requestId) => {
    persistClaims((currentClaims) => removeCorrectionClaim(currentClaims, requestId));
  };

  const openCompletion = (request) => {
    completionTargetRef.current = request;
    setCompletionTarget(request);
  };

  const closeCompletion = () => {
    completionTargetRef.current = null;
    setCompletionTarget(null);
  };

  const claimRequest = async (request) => {
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await api.post(`/admin/correction-requests/${request.id}/claim`);
      await loadRequests(filter);
      setSuccess(`Запит #${request.id} взято в роботу.`);
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const releaseRequest = async (request) => {
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await api.post(
        `/admin/correction-requests/${request.id}/release`,
        { claimVersion: request.claimVersion },
        { headers: getClaimHeaders(request) }
      );
      clearClaim(request.id);
      await loadRequests(filter);
      setSuccess(`Запит #${request.id} повернуто в чергу.`);
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const forceReleaseRequest = async (request) => {
    const confirmed = window.confirm(
      `Примусово повернути запит #${request.id} в чергу? Переконайтеся, що інший працівник більше не працює з товаром.`
    );
    if (!confirmed) return;
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await api.post(`/admin/correction-requests/${request.id}/force-release`, {
        confirm: true,
        claimVersion: request.claimVersion,
      });
      clearClaim(request.id);
      await loadRequests(filter);
      setSuccess(`Запит #${request.id} примусово повернуто в чергу.`);
    } catch (requestError) {
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const updateStatus = async (request, status) => {
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await api.patch(
        `/admin/correction-requests/${request.id}/status`,
        { status, claimVersion: request.claimVersion },
        { headers: getClaimHeaders(request) }
      );
      if (request.status === 'in_progress') clearClaim(request.id);
      await loadRequests(filter);
    } catch (requestError) {
      if (request.status === 'in_progress' && isCorrectionClaimConflict(requestError)) {
        clearClaim(request.id);
      }
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const refreshRequest = async (request) => {
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await api.post(
        `/admin/correction-requests/${request.id}/refresh`,
        { claimVersion: request.claimVersion },
        { headers: getClaimHeaders(request) }
      );
      await loadRequests(filter);
      setSuccess(`Запит #${request.id} оновлено. Повторно звірте SKU та ціну на сайті.`);
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const completeRequest = async () => {
    if (!completionTarget || busyId) return;
    const request = completionTarget;
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      const response = await api.post(
        `/admin/correction-requests/${request.id}/complete`,
        { claimVersion: request.claimVersion },
        { headers: getClaimHeaders(request) }
      );
      clearClaim(request.id);
      closeCompletion();
      await loadRequests(filter);
      const syncFailures = response.data.draftSyncFailures || [];
      setSuccess(
        syncFailures.length > 0
          ? `Запит #${request.id} виконано. ${syncFailures.length} чернеток переоцінки потребують ручного оновлення.`
          : `Запит #${request.id} виконано, чернетки переоцінки синхронізовано.`
      );
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      closeCompletion();
      await loadRequests(filter).catch(() => {});
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !config) {
    return (
      <div className="app-page"><LoadingState label="Завантажуємо чергу виправлень…" /></div>
    );
  }

  return (
    <div className="app-page">
      <main className="mx-auto w-full min-w-0 max-w-7xl space-y-5 overflow-hidden px-4 py-4 pb-20 sm:px-6 sm:py-6">
        <AppPageHeader
          eyebrow="Виправлення"
          title="Запити на виправлення"
          description="Операційна черга, відповідальні працівники та завершення запитів."
          actions={<>
            {isAdminView && canViewCatalogOrPricing && (
              <Link to="/admin" className="btn btn-outline">
                Адмін-панель
              </Link>
            )}
            <Link to="/" className="btn btn-outline gap-2">
              <House size={16} />
              На головну
            </Link>
          </>}
        />

        {error && <Notice>{error}</Notice>}
        {success && <Notice tone="success">{success}</Notice>}
        {queueRefreshFailed && (
          <Notice tone="warning">
            Не вдалося оновити спільну чергу. Показано останні отримані дані; повторна спроба буде автоматично.
          </Notice>
        )}

        <section className="card queue-workspace w-full min-w-0">
          <div className="queue-toolbar flex min-w-0 flex-col gap-3 border-b border-slate-200 p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-md bg-slate-100 p-1 lg:flex-1">
              {FILTERS.map(([value, label, countKey]) => (
                <button
                  key={value}
                  type="button"
                  className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold ${filter === value ? 'border-amber-300 bg-amber-50 text-amber-950 shadow-sm' : 'border-transparent text-slate-600'}`}
                  onClick={() => changeFilter(value)}
                >
                  {label}{countKey ? ` · ${summary[countKey] || 0}` : ''}
                </button>
              ))}
            </div>
            <label className="relative block w-full lg:w-72">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                className="input-sm pl-9"
                value={search}
                placeholder="SKU або коментар"
                aria-label="Пошук запитів за SKU або коментарем"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          {loading ? (
            <LoadingState compact label="Оновлюємо чергу…" />
          ) : visibleRequests.length === 0 ? (
            <EmptyState compact>Запитів для цього фільтра немає.</EmptyState>
          ) : (
            <div className="correction-list divide-y divide-slate-200">
              {visibleRequests.map((request) => {
                const requestBusy = busyId === request.id;
                const proposedPrice = request.proposedPayload?.totalPriceUah;
                const claimOwnership = getCorrectionClaimOwnership(
                  request,
                  currentUserId,
                  claims
                );
                const isOwnedClaim = claimOwnership === 'owned';
                return (
                  <article
                    id={`correction-request-${request.id}`}
                    key={request.id}
                    className={`p-3 transition-colors sm:p-4 ${focusedRequestId === request.id ? 'is-focused' : 'bg-white/40'}`}
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={request.status} />
                        <Link to={`/admin/corrections/history?sku=${encodeURIComponent(request.sourceSku)}`} className="btn btn-outline text-xs px-2 py-1">
                          Історія товару
                        </Link>
                        <span className="text-xs text-slate-500">
                          #{request.id} · створено {formatDateTime(request.createdAt)}
                          {getEmployeeLabel(request.createdByUser)
                            ? ` · ${getEmployeeLabel(request.createdByUser)}`
                            : ''}
                        </span>
                      </div>
                      {request.status === 'in_progress' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <div className={`claim-state mb-0 ${isOwnedClaim ? 'is-owned' : 'is-external'}`}>
                            {isOwnedClaim
                              ? 'В роботі у вас'
                              : getEmployeeLabel(request.claimedByUser)
                                ? `В роботі: ${getEmployeeLabel(request.claimedByUser)}`
                                : 'В роботі: успадкований запит без визначеного працівника'}
                          </div>
                          <span className="text-xs text-slate-500">взято {formatDateTime(request.claimedAt || request.updatedAt)}</span>
                        </div>
                      )}
                    </div>
                    <div className="grid gap-4 border-t border-slate-100 pt-3 xl:grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.35fr)_minmax(230px,0.75fr)]">
                      <div className="min-w-0">
                        <div className="space-y-2.5">
                          <div>
                            <div className="text-xs font-semibold uppercase text-slate-500">Було</div>
                            <div className="mt-1 flex min-w-0 items-center gap-2">
                              <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-800">{request.sourceSku}</span>
                              <CopyButton label="Скопіювати старий артикул" value={request.sourceSku} />
                            </div>
                            <div className="mt-1 text-sm text-slate-600">{formatUah(request.oldPayload?.totalPriceUah)}</div>
                          </div>
                          <div>
                            <div className="text-xs font-semibold uppercase text-[#8a5f2b]">Стане</div>
                            <div className="mt-1 flex min-w-0 items-center gap-2">
                              <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">{request.proposedSku}</span>
                              <CopyButton label="Скопіювати новий артикул" value={request.proposedSku} />
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <span className="min-w-0 flex-1 text-sm font-semibold text-slate-900">{formatUah(proposedPrice)}</span>
                              <CopyButton label="Скопіювати нову ціну" value={Math.round(Number(proposedPrice || 0))} />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="min-w-0">
                        <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Зміни характеристик</div>
                        <RequestChanges config={config} request={request} />
                        {request.comment && (
                          <div className="mt-3 border-l-2 border-slate-300 pl-3 text-sm leading-6 text-slate-600">
                            {request.comment}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col justify-between gap-4">
                        <div className="text-sm text-slate-500">
                          {request.completedAt && <>Виконано: {formatDateTime(request.completedAt)}</>}
                        </div>
                        <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
                          {(request.status === 'pending'
                            || (request.hasUnownedLegacyClaim && !request.claimFingerprint))
                            && canClaim && (
                              <button type="button" className="btn btn-outline gap-2" onClick={() => claimRequest(request)} disabled={requestBusy}>
                                <Play size={15} />
                                Взяти в роботу
                              </button>
                          )}
                          {request.status === 'pending' && canReject && (
                              <button type="button" className="btn btn-outline flex h-10 w-10 items-center justify-center p-0 text-rose-700" onClick={() => updateStatus(request, 'rejected')} disabled={requestBusy} title="Відхилити" aria-label="Відхилити запит">
                                <XCircle size={16} />
                              </button>
                          )}
                          {request.status === 'in_progress' && isOwnedClaim && (
                            <>
                              {canComplete && <button type="button" className="btn btn-outline flex h-10 w-10 items-center justify-center p-0" onClick={() => refreshRequest(request)} disabled={requestBusy} title="Оновити розрахунок" aria-label="Оновити розрахунок">
                                <RefreshCw size={16} className={requestBusy ? 'animate-spin' : ''} />
                              </button>}
                              {canClaim && <button type="button" className="btn btn-outline gap-2" onClick={() => releaseRequest(request)} disabled={requestBusy}>
                                <RotateCcw size={15} />
                                Повернути в чергу
                              </button>}
                              {canReject && <button type="button" className="btn btn-outline flex h-10 w-10 items-center justify-center p-0 text-rose-700" onClick={() => updateStatus(request, 'rejected')} disabled={requestBusy} title="Відхилити" aria-label="Відхилити запит">
                                <XCircle size={16} />
                              </button>}
                              {canComplete && <button type="button" className="btn btn-primary gap-2" onClick={() => openCompletion(request)} disabled={requestBusy}>
                                <CheckCircle2 size={16} />
                                Підтвердити
                              </button>}
                            </>
                          )}
                          {request.status === 'in_progress' && !isOwnedClaim && canForceRelease && (
                            <button
                              type="button"
                              className="btn btn-outline text-rose-700"
                              onClick={() => forceReleaseRequest(request)}
                              disabled={requestBusy}
                            >
                              Примусово повернути
                            </button>
                          )}
                          {request.status === 'rejected' && canReject && (
                            <button type="button" className="btn btn-outline gap-2" onClick={() => updateStatus(request, 'pending')} disabled={requestBusy}>
                              <RotateCcw size={15} />
                              Повернути
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {canComplete && <CompletionDialog
        busy={Boolean(completionTarget && busyId === completionTarget.id)}
        request={completionTarget}
        onCancel={closeCompletion}
        onConfirm={completeRequest}
      />}
    </div>
  );
}
