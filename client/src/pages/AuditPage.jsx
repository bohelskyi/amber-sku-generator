import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListFilter, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, EmptyState, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { Drawer, Pagination, TechnicalDisclosure } from '../components/ui/index.js';
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

function getAuditActionLabel(eventKey) {
  const label = getAuditEventLabel(eventKey);
  return label === `Подія: ${eventKey}` ? 'Невідома подія' : label;
}

function AuditDetails({ details }) {
  const entries = Object.entries(details || {});
  if (!entries.length) return null;
  return (
    <section aria-labelledby="audit-event-data" className="space-y-2">
      <h3 id="audit-event-data" className="text-sm font-semibold text-slate-900">Дані події</h3>
      <dl className="text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="audit-detail-row">
            <dt className="font-medium text-slate-500">{getAuditDetailLabel(key)}</dt>
            <dd className="break-words text-slate-800">{formatAuditDetailValue(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
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
  const [error, setError] = useState('');
  const [cursorHistory, setCursorHistory] = useState([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const requestId = useRef(0);
  const [selectedEvent, setSelectedEvent] = useState(null);

  const load = useCallback(async (cursor = null) => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/audit-events', { params: requestParams(filters, cursor) });
      if (currentRequestId !== requestId.current) return false;
      const nextItems = Array.isArray(response.data?.items) ? response.data.items : [];
      setItems(nextItems);
      setSelectedEvent(null);
      setPage(response.data?.page || { hasMore: false, nextCursor: null });
      return true;
    } catch (requestError) {
      if (currentRequestId !== requestId.current) return false;
      setError(getErrorMessage(requestError));
      setItems([]);
      return false;
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
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
    setCursorHistory([null]);
    setPageIndex(0);
    setFilters({ ...draftFilters });
  };
  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setPage({ hasMore: false, nextCursor: null });
    setCursorHistory([null]);
    setPageIndex(0);
    if (filters === EMPTY_FILTERS) {
      void load(null);
    } else {
      setItems([]);
      setFilters(EMPTY_FILTERS);
    }
  };
  const showNextPage = async () => {
    const nextCursor = page.nextCursor;
    if (!nextCursor || !await load(nextCursor)) return;
    setCursorHistory((current) => [...current.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((current) => current + 1);
  };
  const showPreviousPage = async () => {
    if (pageIndex <= 0) return;
    const previousIndex = pageIndex - 1;
    if (!await load(cursorHistory[previousIndex])) return;
    setPageIndex(previousIndex);
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-medium text-slate-600">Від<input aria-label="Від" className="input-sm mt-1" type="datetime-local" value={draftFilters.from} onChange={updateDraft('from')} /></label>
            <label className="text-xs font-medium text-slate-600">До<input aria-label="До" className="input-sm mt-1" type="datetime-local" value={draftFilters.to} onChange={updateDraft('to')} /></label>
            <label className="text-xs font-medium text-slate-600">Домен<select aria-label="Домен" className="input-sm mt-1" value={draftFilters.domain} onChange={updateDraft('domain')}><option value="">Усі домени</option>{AUDIT_DOMAINS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <details className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">Розширені фільтри</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-xs font-medium text-slate-600">Ключ події<input aria-label="Ключ події" className="input-sm mt-1 font-mono" value={draftFilters.eventKey} onChange={updateDraft('eventKey')} placeholder="product.created" /></label>
              <label className="text-xs font-medium text-slate-600">ID виконавця<input aria-label="ID виконавця" className="input-sm mt-1" min="1" type="number" value={draftFilters.actorId} onChange={updateDraft('actorId')} /></label>
              <label className="text-xs font-medium text-slate-600">Тип об’єкта<input aria-label="Тип об’єкта" className="input-sm mt-1 font-mono" value={draftFilters.subjectType} onChange={updateDraft('subjectType')} placeholder="product" /></label>
              <label className="text-xs font-medium text-slate-600">ID об’єкта<input aria-label="ID об’єкта" className="input-sm mt-1 font-mono" value={draftFilters.subjectId} onChange={updateDraft('subjectId')} /></label>
            </div>
          </details>
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
        ) : <section className="card overflow-hidden p-0" aria-label="Події аудиту">
          <div className="overflow-x-auto"><table className="dense-table w-full min-w-[720px] border-collapse text-left">
            <thead><tr className="table-head border-b border-slate-200"><th className="table-cell">Час</th><th className="table-cell">Дія</th><th className="table-cell">Виконавець</th><th className="table-cell">Об’єкт</th><th className="table-cell"><span className="sr-only">Деталі</span></th></tr></thead>
            <tbody>{items.map((event, index) => <tr key={`${event.occurredAt}:${event.eventKey}:${event.subject?.type}:${event.subject?.id}:${index}`} className="border-b border-slate-100 last:border-0">
              <td className="table-cell whitespace-nowrap text-xs text-slate-600"><time dateTime={event.occurredAt || undefined}>{event.occurredAt ? formatDateTime(event.occurredAt) : 'Час не записано'}</time></td>
              <td className="table-cell"><span className="font-medium text-slate-900">{getAuditActionLabel(event.eventKey)}</span><span className="mt-1 block"><StatusBadge>{AUDIT_DOMAINS.find(([value]) => value === event.domain)?.[1] || 'Інший домен'}</StatusBadge></span></td>
              <td className="table-cell text-sm text-slate-700">{getAuditActorLabel(event.actor)}</td>
              <td className="table-cell text-sm text-slate-700">{getAuditSubjectLabel(event.subject)}</td>
              <td className="table-cell text-right"><button type="button" className="btn btn-outline btn-compact-md" aria-label={`Відкрити деталі: ${getAuditActionLabel(event.eventKey)}`} onClick={() => setSelectedEvent(event)}>Відкрити</button></td>
            </tr>)}</tbody>
          </table></div>
        </section>}

        {!loading && <Pagination
          hasPrevious={pageIndex > 0}
          hasNext={Boolean(page.hasMore && page.nextCursor)}
          onPrevious={() => void showPreviousPage()}
          onNext={() => void showNextPage()}
          summary={`Сторінка ${pageIndex + 1}`}
        />}
      </div>
      <Drawer open={Boolean(selectedEvent)} title={selectedEvent ? getAuditActionLabel(selectedEvent.eventKey) : 'Подія аудиту'}
        description={selectedEvent ? getAuditSubjectLabel(selectedEvent.subject) : undefined} side="right" onClose={() => setSelectedEvent(null)}>
        {selectedEvent && <div className="space-y-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Час</dt><dd className="mt-1 text-slate-800">{selectedEvent.occurredAt ? formatDateTime(selectedEvent.occurredAt) : 'Час не записано'}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Домен</dt><dd className="mt-1"><StatusBadge>{AUDIT_DOMAINS.find(([value]) => value === selectedEvent.domain)?.[1] || 'Інший домен'}</StatusBadge></dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Виконавець</dt><dd className="mt-1 text-slate-800">{getAuditActorLabel(selectedEvent.actor)}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Об’єкт</dt><dd className="mt-1 text-slate-800">{getAuditSubjectLabel(selectedEvent.subject)}</dd></div>
          </dl>
          <AuditDetails details={selectedEvent.details} />
          <TechnicalDisclosure summary="Технічні деталі"><dl className="text-sm"><div className="audit-detail-row"><dt>Ключ події</dt><dd className="break-all font-mono">{selectedEvent.eventKey}</dd></div><div className="audit-detail-row"><dt>Ключ домену</dt><dd className="break-all font-mono">{selectedEvent.domain}</dd></div></dl></TechnicalDisclosure>
        </div>}
      </Drawer>
    </main>
  );
}
