import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListFilter, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, EmptyState, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { api } from '../lib/api.js';
import {
  AUDIT_DOMAINS,
  formatAuditDetailValue,
  getAuditActorLabel,
  getAuditDetailLabel,
  getAuditEventLabel,
  getAuditSubjectLabel,
} from '../lib/audit-viewer.js';
import { formatDateTime } from '../lib/formatters.js';

const EMPTY_FILTERS = Object.freeze({
  from: '', to: '', domain: '', eventKey: '', actorId: '', subjectType: '', subjectId: '',
});

function toIso(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function requestParams(filters, cursor) {
  return Object.fromEntries(Object.entries({
    from: toIso(filters.from),
    to: toIso(filters.to),
    domain: filters.domain || undefined,
    eventKey: filters.eventKey.trim() || undefined,
    actorId: filters.actorId || undefined,
    subjectType: filters.subjectType.trim() || undefined,
    subjectId: filters.subjectId.trim() || undefined,
    cursor: cursor || undefined,
  }).filter(([, value]) => value !== undefined));
}

function getErrorMessage(error) {
  return error?.response?.data?.error || error?.message || 'Не вдалося завантажити журнал аудиту.';
}

function AuditDetails({ details }) {
  const entries = Object.entries(details || {});
  if (!entries.length) return null;
  return (
    <details className="mt-4 border-t border-slate-100 pt-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#8a5f2b]">Деталі</summary>
      <dl className="mt-2 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="audit-detail-row">
            <dt className="font-medium text-slate-500">{getAuditDetailLabel(key)}</dt>
            <dd className="break-words text-slate-800">{formatAuditDetailValue(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function AuditEventCard({ event }) {
  return (
    <article className="audit-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge>{AUDIT_DOMAINS.find(([value]) => value === event.domain)?.[1] || event.domain}</StatusBadge>
            <span className="text-xs text-slate-500">{getAuditSubjectLabel(event.subject)}</span>
          </div>
          <h2 className="text-base font-semibold text-slate-900">{getAuditEventLabel(event.eventKey)}</h2>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{event.eventKey}</p>
        </div>
        <div className="shrink-0 border-t border-slate-100 pt-2 text-left text-xs leading-5 text-slate-500 sm:max-w-56 sm:border-0 sm:pt-0 sm:text-right">
          <time dateTime={event.occurredAt || undefined}>{event.occurredAt ? formatDateTime(event.occurredAt) : 'Час не записано'}</time>
          <div className="font-medium text-slate-600">{getAuditActorLabel(event.actor)}</div>
        </div>
      </div>
      <AuditDetails details={event.details} />
    </article>
  );
}

export default function AuditPage() {
  const auth = useAuth();
  const canViewAudit = auth.permissions.includes('audit.view');
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState({ hasMore: false, nextCursor: null });
  const [loading, setLoading] = useState(canViewAudit);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async ({ cursor = null, append = false } = {}) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/audit-events', { params: requestParams(filters, cursor) });
      const nextItems = Array.isArray(response.data?.items) ? response.data.items : [];
      setItems((current) => append ? [...current, ...nextItems] : nextItems);
      setPage(response.data?.page || { hasMore: false, nextCursor: null });
    } catch (requestError) {
      setError(getErrorMessage(requestError));
      if (!append) setItems([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filters]);

  useEffect(() => {
    if (!canViewAudit) return undefined;
    const timer = globalThis.setTimeout(() => { void load(); }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [canViewAudit, load]);

  const hasDraftChanges = useMemo(
    () => JSON.stringify(draftFilters) !== JSON.stringify(filters),
    [draftFilters, filters]
  );
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  if (!canViewAudit) {
    return <main className="app-page"><div className="mx-auto max-w-4xl px-4 py-8 sm:px-6"><div className="card p-5" role="alert">Недостатньо прав для перегляду аудиту.</div></div></main>;
  }

  const updateDraft = (key) => (event) => setDraftFilters((current) => ({
    ...current, [key]: event.target.value,
  }));
  const applyFilters = (event) => {
    event.preventDefault();
    setItems([]);
    setPage({ hasMore: false, nextCursor: null });
    setFilters({ ...draftFilters });
  };
  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setPage({ hasMore: false, nextCursor: null });
    if (filters === EMPTY_FILTERS) {
      void load();
    } else {
      setItems([]);
      setFilters(EMPTY_FILTERS);
    }
  };

  return (
    <main className="app-page">
      <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 pb-20 sm:px-6">
        <AppPageHeader
          eyebrow="Адміністрування"
          title="Глобальний аудит"
          description="Незмінний журнал безпеки та бізнес-дій з точним виконавцем і об’єктом."
        />

        <form className="card space-y-4 p-4 sm:p-5" onSubmit={applyFilters}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><ListFilter size={16} aria-hidden="true" />Фільтри</div>
            {activeFilterCount > 0 && <StatusBadge tone="info">Активних: {activeFilterCount}</StatusBadge>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-slate-600">Від<input aria-label="Від" className="input-sm mt-1" type="datetime-local" value={draftFilters.from} onChange={updateDraft('from')} /></label>
            <label className="text-xs font-medium text-slate-600">До<input aria-label="До" className="input-sm mt-1" type="datetime-local" value={draftFilters.to} onChange={updateDraft('to')} /></label>
            <label className="text-xs font-medium text-slate-600">Домен<select aria-label="Домен" className="input-sm mt-1" value={draftFilters.domain} onChange={updateDraft('domain')}><option value="">Усі домени</option>{AUDIT_DOMAINS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-xs font-medium text-slate-600">Ключ події<input aria-label="Ключ події" className="input-sm mt-1 font-mono" value={draftFilters.eventKey} onChange={updateDraft('eventKey')} placeholder="product.created" /></label>
            <label className="text-xs font-medium text-slate-600">ID виконавця<input aria-label="ID виконавця" className="input-sm mt-1" min="1" type="number" value={draftFilters.actorId} onChange={updateDraft('actorId')} /></label>
            <label className="text-xs font-medium text-slate-600">Тип об’єкта<input aria-label="Тип об’єкта" className="input-sm mt-1 font-mono" value={draftFilters.subjectType} onChange={updateDraft('subjectType')} placeholder="product" /></label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">ID об’єкта<input aria-label="ID об’єкта" className="input-sm mt-1 font-mono" value={draftFilters.subjectId} onChange={updateDraft('subjectId')} /></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={!hasDraftChanges && !error}>Застосувати</button>
            <button type="button" className="btn btn-outline gap-2" onClick={clearFilters}><RotateCcw size={15} />Очистити</button>
          </div>
        </form>

        {error && <Notice>{error}</Notice>}
        {loading ? (
          <LoadingState label="Завантаження аудиту" />
        ) : items.length === 0 && !error ? (
          <div className="card p-0"><EmptyState>Подій за вибраними фільтрами не знайдено.</EmptyState></div>
        ) : (
          <section className="space-y-3" aria-label="Події аудиту">
            {items.map((event, index) => <AuditEventCard key={`${event.occurredAt}:${event.eventKey}:${event.subject?.type}:${event.subject?.id}:${index}`} event={event} />)}
          </section>
        )}

        {page.hasMore && !loading && (
          <div className="flex justify-center"><button type="button" className="btn btn-outline" disabled={loadingMore} onClick={() => void load({ cursor: page.nextCursor, append: true })}>{loadingMore ? 'Завантаження…' : 'Завантажити ще'}</button></div>
        )}
      </div>
    </main>
  );
}
