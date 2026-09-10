import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardX, ListFilter, RefreshCw, RotateCcw, ScrollText } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
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
    <details className="mt-3 border-t border-slate-100 pt-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#8a5f2b]">Деталі</summary>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[minmax(160px,0.5fr)_minmax(0,1fr)]">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
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
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{getAuditEventLabel(event.eventKey)}</h2>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{event.eventKey}</p>
          <p className="mt-2 text-sm text-slate-700">{getAuditSubjectLabel(event.subject)}</p>
        </div>
        <div className="shrink-0 text-left text-xs leading-5 text-slate-500 sm:text-right">
          <div>{event.occurredAt ? formatDateTime(event.occurredAt) : 'Час не записано'}</div>
          <div>{getAuditActorLabel(event.actor)}</div>
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

  if (!canViewAudit) {
    return <main className="app-page"><div className="mx-auto max-w-4xl px-4 py-8 sm:px-6"><div className="card" role="alert">Недостатньо прав для перегляду аудиту.</div></div></main>;
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
        <header className="card flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Адміністрування</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">Глобальний аудит</h1>
            <p className="mt-1 text-sm text-slate-500">Незмінний журнал безпеки та бізнес-дій.</p>
          </div>
          <ScrollText size={32} className="text-amber-600" aria-hidden="true" />
        </header>

        <form className="card space-y-4" onSubmit={applyFilters}>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><ListFilter size={16} />Фільтри</div>
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

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16" role="status"><RefreshCw size={24} className="animate-spin text-slate-500" /><span className="sr-only">Завантаження аудиту</span></div>
        ) : items.length === 0 && !error ? (
          <div className="card flex flex-col items-center gap-2 py-12 text-center text-sm text-slate-500"><ClipboardX size={28} /><span>Подій за вибраними фільтрами не знайдено.</span></div>
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
