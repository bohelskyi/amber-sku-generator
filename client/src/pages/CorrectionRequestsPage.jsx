import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { correctionsApi } from '../api/corrections-api';
import {
  Button,
  ConfirmDialog,
  CopyAction,
  EmptyState,
  LoadingState,
  Notice,
  OperationReceipt,
  PageHeader,
  Pagination,
  StatusBadge as UiStatusBadge,
  TechnicalDisclosure,
} from '../components/ui/index.js';
import {
  filterPresentableAnswerChanges,
  getAnswerValueLabel,
  getQuestionLabel,
} from '../lib/answer-labels';
import { formatDateTime, formatUah } from '../lib/formatters';
import { getApiError } from '../lib/http-error';
import { getPermissionUiState } from '../lib/permission-ui.js';
import '../components/attention/attention.css';
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

function getEmployeeLabel(user) {
  return user?.displayName || user?.preferredUsername || (user?.id ? `Працівник #${user.id}` : null);
}

function CorrectionStatusBadge({ status }) {
  return (
    <UiStatusBadge className={STATUS_CLASSES[status] || STATUS_CLASSES.pending} tone={status === 'completed' ? 'success' : status === 'rejected' ? 'danger' : status === 'in_progress' ? 'info' : 'warning'}>
      {STATUS_LABELS[status] || status}
    </UiStatusBadge>
  );
}

function RequestTypeBadge({ requestType }) {
  return <span className="status-badge is-neutral">
    {requestType === 'price_change' ? 'Зміна ціни' : 'Переоблік'}
  </span>;
}

function PricingDecision({ request }) {
  const decision = request.pricingDecision;
  if (!decision) {
    return <span>Ціна: {request.pricingOrigin ? 'точна ручна UAH (резервний режим)' : 'системна автоматична'}</span>;
  }
  if (decision.mode === 'usd_per_gram') {
    return <span>Ціна: {decision.usdPerGram} USD/г · маркетингове округлення {decision.marketingRoundingEnabled ? 'увімкнено' : 'вимкнено'}</span>;
  }
  if (decision.mode === 'manual_uah') {
    return <span>Ціна: ручна {formatUah(decision.manualPriceUah)}
      {request.requestType === 'price_change'
        ? ` · маркетингове округлення ${decision.marketingRoundingEnabled ? 'увімкнено' : 'вимкнено'}`
        : ' · точно без округлення'}
    </span>;
  }
  return <span>Ціна: системна автоматична</span>;
}

function RequestChanges({ config, request }) {
  const changes = filterPresentableAnswerChanges(request.changes, {
    oldPayload: request.oldPayload,
    newPayload: request.proposedPayload,
  });
  return (
    <div className="correction-change-list divide-y divide-slate-200">
      {changes.map((change) => (
        <div
          key={change.key}
          className="change-record-row text-sm"
        >
          <span className="change-record-label font-medium text-slate-700">
            {getQuestionLabel(config, request.categoryCode, change.key)}
          </span>
          <span className="correction-change-comparison">
            <span className="change-record-old text-slate-500">
              {getAnswerValueLabel(config, request.categoryCode, change.key, change.from)}
            </span>
            <ArrowRight size={13} className="change-record-arrow text-slate-400" />
            <strong className="change-record-new font-semibold text-slate-900">
              {getAnswerValueLabel(config, request.categoryCode, change.key, change.to)}
            </strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function CompletionDialog({ busy, request, onCancel, onConfirm }) {
  return <ConfirmDialog
    open={Boolean(request)}
    title="Застосувати зміни в Amber?"
    description={request ? `Запит #${request.id}. Перевірте результат перед застосуванням.` : undefined}
    confirmLabel={request?.requestType === 'price_change' ? 'Змінити ціну в Amber' : 'Виконати переоблік в Amber'}
    busy={busy}
    onClose={onCancel}
    onConfirm={onConfirm}
  >
    {request && <div className="correction-confirm-summary">
      <div><span>Артикул</span><strong>{request.sourceArticle || 'Недоступний'}</strong></div>
      {request.requestType !== 'price_change' && <div><span>Артикул після переобліку</span><strong>{request.proposedArticle || request.sourceArticle || 'Недоступний'}</strong></div>}
      <div><span>Нова ціна</span><strong>{formatUah(request.proposedPayload?.totalPriceUah)}</strong></div>
      <Notice tone="info">Зміна буде збережена в Amber. Подальша доставка до Magento має власний стан і виконується окремо.</Notice>
    </div>}
  </ConfirmDialog>;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const focusedRequestId = Number(searchParams.get('request') || 0);
  const isAdminView = searchParams.get('from') === 'admin';
  const [config, setConfig] = useState(null);
  const [requests, setRequests] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pageInfo, setPageInfo] = useState({ limit: 30, offset: 0, total: 0, hasPrevious: false, hasNext: false });
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState(focusedRequestId || null);
  const [externalRequest, setExternalRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [completionTarget, setCompletionTarget] = useState(null);
  const [forceReleaseTarget, setForceReleaseTarget] = useState(null);
  const completionTargetRef = useRef(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [claims, setClaims] = useState(() => readCorrectionClaims());
  const [queueRefreshFailed, setQueueRefreshFailed] = useState(false);
  const requestGate = useRef(createLatestRequestGate());
  const activeQueryRef = useRef({ filter: 'active', offset: 0, search: '' });

  const persistClaims = useCallback((updater) => {
    setClaims((currentClaims) => {
      const nextClaims = typeof updater === 'function' ? updater(currentClaims) : updater;
      writeCorrectionClaims(nextClaims);
      return nextClaims;
    });
  }, []);

  const loadRequests = useCallback(async (query = activeQueryRef.current) => {
    const loadId = requestGate.current.next();
    const response = await correctionsApi.listRequestPage({
      status: query.filter === 'workspace' ? 'active' : query.filter,
      search: query.search || undefined,
      workspace: query.filter === 'workspace' || undefined,
      workspaceIds: query.filter === 'workspace'
        ? Object.keys(readCorrectionClaims()).join(',') || undefined
        : undefined,
      limit: 30,
      offset: query.offset,
    });
    if (
      !requestGate.current.isLatest(loadId)
      || JSON.stringify(query) !== JSON.stringify(activeQueryRef.current)
    ) return false;
    const nextRequests = response.data.items || [];
    setRequests(nextRequests);
    setSelectedId((current) => (
      current && (focusedRequestId || nextRequests.some((request) => Number(request.id) === Number(current)))
        ? current
        : nextRequests[0]?.id || null
    ));
    setSummary(response.data.summary || {});
    setPageInfo(response.data.pageInfo || { limit: 30, offset: query.offset, total: nextRequests.length, hasPrevious: query.offset > 0, hasNext: false });
    persistClaims((currentClaims) => reconcileCorrectionClaims(currentClaims, nextRequests));
    const currentTarget = completionTargetRef.current;
    if (currentTarget) {
      let currentRequest = nextRequests.find(
        (request) => Number(request.id) === Number(currentTarget.id)
      );
      if (!currentRequest) {
        try { currentRequest = (await correctionsApi.getRequest(currentTarget.id)).data; } catch { currentRequest = null; }
      }
      if (
        !currentRequest
        || currentRequest.status !== 'in_progress'
        || Number(currentRequest.claimVersion) !== Number(currentTarget.claimVersion)
        || currentRequest.updatedAt !== currentTarget.updatedAt
      ) {
        completionTargetRef.current = null;
        setCompletionTarget(null);
        setSuccess(`Запит #${currentTarget.id} змінився в іншому вікні. Чергу оновлено.`);
      }
    }
    return true;
  }, [focusedRequestId, persistClaims]);

  useEffect(() => {
    const configRequest = auth.permissions.includes('products.view')
      ? correctionsApi.getPublicConfig()
      : Promise.resolve({ data: {} });
    configRequest
      .then((configResponse) => setConfig(configResponse.data || {}))
      .catch((requestError) => setError(getApiError(requestError)))
  }, [auth.permissions]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const query = { filter, offset, search: debouncedSearch };
    activeQueryRef.current = query;
    loadRequests(query)
      .then(() => setQueueRefreshFailed(false))
      .catch((requestError) => { setError(getApiError(requestError)); setQueueRefreshFailed(true); })
      .finally(() => setLoading(false));
  }, [debouncedSearch, filter, loadRequests, offset]);

  useEffect(() => createVisibilityAwarePoller({
    poll: async () => {
      try {
        await loadRequests();
        setQueueRefreshFailed(false);
      } catch {
        setQueueRefreshFailed(true);
      }
    },
  }), [loadRequests]);

  useEffect(() => {
    if (!selectedId || requests.some((request) => Number(request.id) === Number(selectedId))) return undefined;
    let live = true;
    correctionsApi.getRequest(selectedId)
      .then(({ data }) => { if (live) setExternalRequest(data); })
      .catch((requestError) => { if (live) setError(getApiError(requestError)); });
    return () => { live = false; };
  }, [requests, selectedId]);

  const visibleRequests = useMemo(() => {
    return getCorrectionRequestsForView(
      requests,
      currentUserId,
      claims,
      filter
    );
  }, [claims, currentUserId, filter, requests]);

  const selectedRequest = visibleRequests.find((request) => Number(request.id) === Number(selectedId))
    || (Number(externalRequest?.id) === Number(selectedId) ? externalRequest : null);

  const changeFilter = (nextFilter) => {
    if (nextFilter === filter || loading) return;
    setFilter(nextFilter);
    setLoading(true);
    setError('');
    setOffset(0);
    setSelectedId(null);
    setExternalRequest(null);
  };

  const selectRequest = (request) => {
    setSelectedId(request.id);
    const next = new URLSearchParams(searchParams);
    next.set('request', String(request.id));
    setSearchParams(next, { replace: true });
  };

  const getClaimHeaders = (request) => {
    const claimToken = getCorrectionLegacyClaimToken(request, claims);
    return claimToken ? { 'X-Correction-Claim-Token': claimToken } : {};
  };

  const clearClaim = (requestId) => {
    persistClaims((currentClaims) => removeCorrectionClaim(currentClaims, requestId));
  };

  const refreshQueueAfterWrite = async () => {
    try {
      await loadRequests();
      setQueueRefreshFailed(false);
    } catch {
      setQueueRefreshFailed(true);
    }
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
      await correctionsApi.claimRequest(request.id);
      setSuccess(`Запит #${request.id} взято в роботу.`);
      await refreshQueueAfterWrite();
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
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
      await correctionsApi.releaseRequest(
        request.id,
        request.claimVersion,
        getClaimHeaders(request)
      );
      clearClaim(request.id);
      setSuccess(`Запит #${request.id} повернуто в чергу.`);
      await refreshQueueAfterWrite();
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      setError(getApiError(requestError));
    } finally {
      setBusyId(null);
    }
  };

  const forceReleaseRequest = async (request) => {
    setBusyId(request.id);
    setError('');
    setSuccess('');
    try {
      await correctionsApi.forceReleaseRequest(request.id, request.claimVersion);
      clearClaim(request.id);
      setForceReleaseTarget(null);
      setSuccess(`Запит #${request.id} примусово повернуто в чергу.`);
      await refreshQueueAfterWrite();
    } catch (requestError) {
      setForceReleaseTarget(null);
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
      await correctionsApi.updateRequestStatus(
        request.id,
        status,
        request.claimVersion,
        getClaimHeaders(request)
      );
      if (request.status === 'in_progress') clearClaim(request.id);
      setSuccess(`Статус запиту #${request.id} змінено.`);
      await refreshQueueAfterWrite();
    } catch (requestError) {
      if (request.status === 'in_progress' && isCorrectionClaimConflict(requestError)) {
        clearClaim(request.id);
      }
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
      await correctionsApi.refreshRequest(
        request.id,
        request.claimVersion,
        getClaimHeaders(request)
      );
      setSuccess(`Запит #${request.id} оновлено. Перевірте актуальні параметри й ціну перед виконанням.`);
      await refreshQueueAfterWrite();
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
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
      const response = await correctionsApi.completeRequest(
        request.id,
        request.claimVersion,
        getClaimHeaders(request)
      );
      clearClaim(request.id);
      closeCompletion();
      const syncFailures = response.data.draftSyncFailures || [];
      setReceipt({
        title: 'Зміни застосовано в Amber',
        description: request.requestType === 'price_change'
          ? `Запит #${request.id} закрито, ціну товару змінено.`
          : syncFailures.length > 0
            ? `Запит #${request.id} закрито. ${syncFailures.length} чернеток переоцінки потребують ручного оновлення.`
            : `Запит #${request.id} закрито, пов’язані чернетки переоцінки синхронізовано.`,
        article: response.data.request?.proposedArticle || request.proposedArticle || request.sourceArticle,
      });
      await refreshQueueAfterWrite();
    } catch (requestError) {
      if (isCorrectionClaimConflict(requestError)) clearClaim(request.id);
      closeCompletion();
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

  const proposedPrice = selectedRequest?.proposedPayload?.totalPriceUah;
  const requestBusy = selectedRequest && busyId === selectedRequest.id;
  const claimOwnership = selectedRequest
    ? getCorrectionClaimOwnership(selectedRequest, currentUserId, claims)
    : null;
  const isOwnedClaim = claimOwnership === 'owned';
  const historyIdentity = selectedRequest?.sourceArticle || selectedRequest?.sourceInternalSku;

  return <div className="app-page"><main className="correction-queue-page">
    <PageHeader
      breadcrumbs={[{ label: 'Історичні запити' }]}
      title="Історичні запити"
      description="Раніше створені запити та завершення розпочатої роботи. Поточні зміни виконуються безпосередньо в картці товару за відповідними дозволами."
      actions={isAdminView && canViewCatalogOrPricing ? <Link to="/admin" className="btn btn-outline">Налаштування</Link> : undefined}
    />
    {error && <Notice tone="error">{error}</Notice>}
    {success && <Notice tone="success">{success}</Notice>}
    {receipt && <OperationReceipt title={receipt.title} description={receipt.description} identity={receipt.article} />}
    {queueRefreshFailed && <Notice tone="warning">Не вдалося оновити спільну чергу. Показано останні отримані дані; повторна спроба буде автоматично.</Notice>}

    <section className="correction-queue-shell">
      <div className="correction-queue-toolbar">
        <div className="correction-filter-tabs" role="group" aria-label="Стан запитів">
          {FILTERS.map(([value, label, countKey]) => <Button key={value} size="compactMd"
            variant={filter === value ? 'primary' : 'ghost'} onClick={() => changeFilter(value)}>
            {label}{countKey ? ` · ${summary && Object.prototype.hasOwnProperty.call(summary, countKey) ? summary[countKey] : '—'}` : ''}
          </Button>)}
        </div>
        <label className="correction-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Пошук запитів</span>
          <input className="input-sm" value={search} placeholder="Артикул, внутрішній SKU або коментар"
            onChange={(event) => { setSearch(event.target.value); setOffset(0); setLoading(true); setError(''); }} />
        </label>
      </div>

      <div className="correction-master-detail">
        <aside className="correction-queue-list" aria-label="Черга запитів">
          {loading && <LoadingState compact label="Оновлюємо чергу…" />}
          {!loading && !error && visibleRequests.length === 0 && <EmptyState compact title="Запитів немає">Для вибраного фільтра нічого не знайдено.</EmptyState>}
          {!loading && visibleRequests.map((request) => {
            const ownership = getCorrectionClaimOwnership(request, currentUserId, claims);
            return <button key={request.id} type="button"
              className={`correction-queue-item ${Number(selectedId) === Number(request.id) ? 'is-selected' : ''}`}
              onClick={() => selectRequest(request)} aria-pressed={Number(selectedId) === Number(request.id)}>
              <span className="correction-queue-item-top"><CorrectionStatusBadge status={request.status} /><RequestTypeBadge requestType={request.requestType} /></span>
              <strong>{request.sourceArticle || 'Артикул недоступний'}</strong>
              <span>Запит #{request.id} · {formatDateTime(request.createdAt)}</span>
              {request.status === 'in_progress' && <span>{ownership === 'owned' ? 'В роботі у вас' : getEmployeeLabel(request.claimedByUser) ? `В роботі: ${getEmployeeLabel(request.claimedByUser)}` : 'В роботі без визначеного працівника'}</span>}
            </button>;
          })}
          <Pagination busy={loading} hasPrevious={pageInfo.hasPrevious} hasNext={pageInfo.hasNext}
            onPrevious={() => { setLoading(true); setOffset(Math.max(0, offset - pageInfo.limit)); setSelectedId(null); }}
            onNext={() => { setLoading(true); setOffset(offset + pageInfo.limit); setSelectedId(null); }}
            summary={pageInfo.total ? `${offset + 1}–${Math.min(offset + visibleRequests.length, pageInfo.total)} із ${pageInfo.total}` : undefined} />
        </aside>

        <section className="correction-request-detail" aria-label="Деталі запиту">
          {!selectedRequest && <EmptyState title="Оберіть запит"><ClipboardList size={22} aria-hidden="true" />Деталі й доступні дії з’являться тут.</EmptyState>}
          {selectedRequest && <>
            <header className="correction-detail-header">
              <div><div className="correction-detail-badges"><CorrectionStatusBadge status={selectedRequest.status} /><RequestTypeBadge requestType={selectedRequest.requestType} /></div>
                <h2>Запит #{selectedRequest.id}</h2>
                <p>Створено {formatDateTime(selectedRequest.createdAt)} · Автор: {getEmployeeLabel(selectedRequest.createdByUser) || 'не вказано'}</p></div>
              {historyIdentity && <Link to={`/products/history?sku=${encodeURIComponent(historyIdentity)}`} className="btn btn-outline btn-compact-md">Історія товару</Link>}
            </header>

            {selectedRequest.status === 'in_progress' && <Notice tone={isOwnedClaim ? 'info' : 'warning'}>
              {isOwnedClaim ? 'Запит у роботі у вас.' : getEmployeeLabel(selectedRequest.claimedByUser)
                ? `Запит у роботі: ${getEmployeeLabel(selectedRequest.claimedByUser)}.`
                : 'Успадкований запит у роботі без визначеного працівника.'}
            </Notice>}

            <div className="correction-identity-comparison">
              <section><span>Зараз</span><div><strong>{selectedRequest.sourceArticle || 'Артикул недоступний'}</strong>
                <CopyAction compact value={selectedRequest.sourceArticle || ''} disabled={!selectedRequest.sourceArticle} buttonLabel="Скопіювати поточний артикул" /></div>
                <p>{formatUah(selectedRequest.oldPayload?.totalPriceUah)}</p></section>
              <ArrowRight size={18} aria-hidden="true" />
              <section><span>Після застосування</span><div><strong>{selectedRequest.proposedArticle || selectedRequest.sourceArticle || 'Артикул недоступний'}</strong>
                <CopyAction compact value={selectedRequest.proposedArticle || selectedRequest.sourceArticle || ''}
                  disabled={!selectedRequest.proposedArticle && !selectedRequest.sourceArticle} buttonLabel="Скопіювати результуючий артикул" /></div>
                <div><p>{formatUah(proposedPrice)}</p><CopyAction compact value={proposedPrice === null || proposedPrice === undefined ? '' : String(proposedPrice)}
                  disabled={proposedPrice === null || proposedPrice === undefined} buttonLabel="Скопіювати точну нову ціну" /></div></section>
            </div>

            <section className="correction-detail-section">
              <h3>{selectedRequest.requestType === 'price_change' ? 'Зміна ціни' : 'Зміни характеристик'}</h3>
              {selectedRequest.requestType === 'price_change'
                ? <dl className="correction-price-change"><div><dt>Поточна ціна</dt><dd>{formatUah(selectedRequest.oldPayload?.totalPriceUah)}</dd></div><div><dt>Запитана ціна</dt><dd>{formatUah(proposedPrice)}</dd></div></dl>
                : <RequestChanges config={config} request={selectedRequest} />}
              <p className="correction-pricing-line"><PricingDecision request={selectedRequest} /></p>
              {selectedRequest.comment && <blockquote>{selectedRequest.comment}</blockquote>}
            </section>

            {selectedRequest.refreshRequired && <Notice tone="warning">Розрахунок застарів. Оновіть його і повторно перевірте дані перед виконанням.</Notice>}
            {selectedRequest.delivery && <Notice tone={selectedRequest.delivery.route === 'normal' ? 'info' : 'warning'}>
              {selectedRequest.delivery.route === 'normal' ? 'Після зміни буде створено окреме зобов’язання першої доставки до Magento.'
                : ({ prior_exposure: 'Доставка наступника потребує узгодження попереднього експорту.', historical_ambiguity: 'Доставка очікуватиме перевірки історії експорту.', intentional_exclusion: 'Наступник успадкує виключення з доставки.', invalid_lineage: 'Доставка очікуватиме перевірки історії виправлень.' })[selectedRequest.delivery.holdReason] || 'Доставка потребує окремої перевірки.'}
              {selectedRequest.delivery.nameReviewRequired && ' Успадковані назви також потребують перевірки.'}
            </Notice>}

            <TechnicalDisclosure><dl className="technical-key-values">
              <div><dt>Внутрішній SKU джерела</dt><dd>{selectedRequest.sourceInternalSku || 'Недоступний'}</dd></div>
              <div><dt>Запропонований внутрішній SKU</dt><dd>{selectedRequest.proposedInternalSku || 'Недоступний'}</dd></div>
              <div><dt>Версія призначення</dt><dd>{selectedRequest.claimVersion}</dd></div>
            </dl></TechnicalDisclosure>

            <footer className="correction-detail-actions">
              {(selectedRequest.status === 'pending' || (selectedRequest.hasUnownedLegacyClaim && !selectedRequest.claimFingerprint)) && canClaim &&
                <Button onClick={() => claimRequest(selectedRequest)} busy={requestBusy}><Play size={15} aria-hidden="true" />Взяти в роботу</Button>}
              {selectedRequest.status === 'pending' && canReject && <Button variant="danger" onClick={() => updateStatus(selectedRequest, 'rejected')} busy={requestBusy}><XCircle size={15} aria-hidden="true" />Відхилити</Button>}
              {selectedRequest.status === 'in_progress' && isOwnedClaim && <>
                {canComplete && <Button onClick={() => refreshRequest(selectedRequest)} busy={requestBusy}><RefreshCw size={15} aria-hidden="true" />Оновити розрахунок</Button>}
                {canClaim && <Button onClick={() => releaseRequest(selectedRequest)} busy={requestBusy}><RotateCcw size={15} aria-hidden="true" />Повернути в чергу</Button>}
                {canReject && <Button variant="danger" onClick={() => updateStatus(selectedRequest, 'rejected')} busy={requestBusy}>Відхилити</Button>}
                {canComplete && <Button variant="primary" onClick={() => openCompletion(selectedRequest)} disabled={requestBusy || selectedRequest.refreshRequired}><CheckCircle2 size={16} aria-hidden="true" />Перевірити й застосувати</Button>}
              </>}
              {selectedRequest.status === 'in_progress' && !isOwnedClaim && canForceRelease && <Button variant="danger" onClick={() => setForceReleaseTarget(selectedRequest)} disabled={requestBusy}>Примусово повернути</Button>}
              {selectedRequest.status === 'rejected' && canReject && <Button onClick={() => updateStatus(selectedRequest, 'pending')} busy={requestBusy}><RotateCcw size={15} aria-hidden="true" />Повернути до черги</Button>}
            </footer>
          </>}
        </section>
      </div>
    </section>
  </main>

  {canComplete && <CompletionDialog busy={Boolean(completionTarget && busyId === completionTarget.id)} request={completionTarget}
    onCancel={closeCompletion} onConfirm={completeRequest} />}
  <ConfirmDialog open={Boolean(forceReleaseTarget)} title="Примусово повернути запит у чергу?"
    description={forceReleaseTarget ? `Запит #${forceReleaseTarget.id} зараз належить іншому працівнику.` : undefined}
    confirmLabel="Примусово повернути" tone="danger" busy={Boolean(forceReleaseTarget && busyId === forceReleaseTarget.id)}
    onClose={() => setForceReleaseTarget(null)} onConfirm={() => forceReleaseTarget && forceReleaseRequest(forceReleaseTarget)}>
    <Notice tone="warning">Переконайтеся, що інший працівник більше не працює з цим товаром. Дія змінить призначення запиту.</Notice>
  </ConfirmDialog>
  </div>;
}
