import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  History,
  PackagePlus,
  RefreshCw,
  Search,
  Undo2,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatDateTime, formatDecimal, formatUah } from '../../lib/formatters';

const EVENT_META = {
  'product.created': { label: 'Товар створено', icon: PackagePlus, toneClass: 'text-emerald-700' },
  'correction_request.created': { label: 'Запит на виправлення створено', icon: ClipboardList, toneClass: 'text-slate-700' },
  'correction_request.claimed': { label: 'Запит взято в роботу', icon: ClipboardList, toneClass: 'text-blue-700' },
  'correction_request.released': { label: 'Запит повернуто в чергу', icon: ClipboardList, toneClass: 'text-slate-700' },
  'correction_request.force_released': { label: 'Запит примусово повернуто в чергу', icon: AlertTriangle, toneClass: 'text-amber-700' },
  'correction_request.rejected': { label: 'Запит відхилено', icon: AlertTriangle, toneClass: 'text-rose-700' },
  'correction_request.reopened': { label: 'Запит відкрито повторно', icon: ClipboardList, toneClass: 'text-blue-700' },
  'correction_request.completed': { label: 'Запит виконано', icon: CheckCircle2, toneClass: 'text-emerald-700' },
  'product.corrected': { label: 'Товар виправлено', icon: History, toneClass: 'text-amber-700' },
  'repricing.applied': { label: 'Ціну змінено переоцінкою', icon: History, toneClass: 'text-blue-700' },
  'repricing.rolled_back': { label: 'Переоцінку відкочено', icon: Undo2, toneClass: 'text-amber-700' },
  'product.archived': { label: 'Товар архівовано', icon: Archive, toneClass: 'text-slate-700' },
};

function getApiError(error) {
  return error.response?.data?.error || error.message || 'Невідома помилка';
}

function actorLabel(actor) {
  if (actor?.status === 'not_recorded') return 'Виконавця не записано';
  if (actor?.status === 'recorded_reference') return 'Виконавець записаний, історичне ім’я відсутнє';
  return actor?.displayName || actor?.preferredUsername || 'Ім’я виконавця не записано';
}

function timeLabel(event) {
  return event.timestampStatus === 'recorded' && event.occurredAt
    ? formatDateTime(event.occurredAt)
    : 'Час не записано';
}

function valueLabel(value) {
  if (!value || value.value === null || value.value === undefined) return 'Не вказано';
  return value.label || String(value.value);
}

function TimelineChanges({ changes }) {
  if (!changes?.length) return null;
  return (
    <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
      {changes.map((change) => (
        <div key={`${change.kind}:${change.fieldKey}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1.4fr)]">
          <span className="font-medium text-slate-600">
            {change.kind === 'weight' ? 'Вага' : (change.fieldLabel || change.fieldKey)}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-slate-700">
            <span>{change.kind === 'weight' && change.before.value !== null ? `${formatDecimal(change.before.value)} г` : valueLabel(change.before)}</span>
            <ArrowRight size={13} className="shrink-0 text-slate-400" />
            <strong className="font-semibold text-slate-900">
              {change.kind === 'weight' && change.after.value !== null ? `${formatDecimal(change.after.value)} г` : valueLabel(change.after)}
            </strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function PriceChange({ price }) {
  if (!price || (price.beforeUah === null && price.afterUah === null)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <span>Ціна:</span>
      <strong>{price.beforeUah === null ? 'Не записано' : formatUah(price.beforeUah)}</strong>
      <ArrowRight size={13} className="text-slate-400" />
      <strong>{price.afterUah === null ? 'Не записано' : formatUah(price.afterUah)}</strong>
    </div>
  );
}

function TimelineCard({ events }) {
  const correction = events.find((event) => event.type === 'product.corrected');
  const event = correction || events[events.length - 1];
  const meta = EVENT_META[event.type] || EVENT_META['correction_request.created'];
  const Icon = meta.icon;
  const correctionDetails = event.type === 'product.corrected';
  const proposal = events.find((item) => item.details?.latestProposal)?.details.latestProposal;
  const hasExpandable = correctionDetails || proposal;
  const title = correction && events.some((item) => item.type === 'correction_request.completed')
    ? 'Запит виконано та товар виправлено'
    : meta.label;

  return (
    <article className="relative rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <span className={`absolute -left-[2.15rem] top-5 flex h-8 w-8 items-center justify-center rounded-full border bg-white ${meta.toneClass}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <div className="mt-1 font-mono text-sm text-slate-600">{event.sku}</div>
        </div>
        <div className="text-right text-xs leading-5 text-slate-500">
          <div>{timeLabel(event)}</div>
          <div>{actorLabel(event.actor)}</div>
        </div>
      </div>

      {correctionDetails && (
        <div className="mt-4 space-y-3">
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-slate-200 px-3 py-2">
            <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold">{event.details.sourceSku}</span>
            <ArrowRight size={14} className="shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 break-all text-right font-mono text-sm font-semibold">{event.details.correctedSku}</span>
          </div>
          <PriceChange price={event.details.price} />
          {event.details.reason && <p className="text-sm text-slate-600">Причина: {event.details.reason}</p>}
        </div>
      )}
      {event.type.startsWith('repricing.') && (
        <div className="mt-4 space-y-2">
          <PriceChange price={event.details.price} />
          {event.details.scenarioName && <p className="text-xs text-slate-500">Матриця: {event.details.scenarioName}</p>}
        </div>
      )}

      {hasExpandable && (
        <details className="mt-4 border-t border-slate-100 pt-3">
          <summary className="cursor-pointer text-sm font-semibold text-[#8a5f2b]">Деталі</summary>
          <div className="mt-3 space-y-3">
            {proposal && (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3">
                <div className="text-xs font-semibold uppercase text-amber-800">Остання збережена пропозиція</div>
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 break-all font-mono">{proposal.sourceSku}</span>
                  <ArrowRight size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 break-all text-right font-mono">{proposal.proposedSku}</span>
                </div>
                {proposal.comment && <p className="text-sm text-slate-600">{proposal.comment}</p>}
                <TimelineChanges changes={proposal.changes} />
              </div>
            )}
            {correctionDetails && <TimelineChanges changes={event.changes} />}
          </div>
        </details>
      )}
    </article>
  );
}

function groupEvents(events) {
  const groups = [];
  const byKey = new Map();
  for (const event of events) {
    const key = event.groupKey || event.id;
    if (!byKey.has(key)) {
      const group = { key, events: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).events.push(event);
  }
  return groups;
}

export function ProductTimeline() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSku = searchParams.get('sku') || '';
  const [input, setInput] = useState(requestedSku);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!requestedSku) return undefined;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await api.get('/product-timeline', { params: { sku: requestedSku } });
        if (!cancelled) setData(response.data);
      } catch (requestError) {
        if (!cancelled) {
          setData(null);
          setError(getApiError(requestError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [requestedSku]);

  const groups = useMemo(() => groupEvents(data?.events || []), [data]);
  const submit = (event) => {
    event.preventDefault();
    const sku = input.trim().toUpperCase();
    if (!sku) {
      setError('Вкажіть артикул.');
      return;
    }
    setInput(sku);
    const next = new URLSearchParams(searchParams);
    next.set('sku', sku);
    next.delete('mode');
    setSearchParams(next);
  };

  return (
    <div className="app-page">
      <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-4 pb-20 sm:px-6 sm:py-6">
        <header className="console-header">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Журнал · Історія товару</h1>
            <p className="mt-1 text-xs text-slate-500">Повна бізнес-історія за поточним або історичним SKU.</p>
          </div>
          <Link to="/admin/corrections/history?mode=report" className="btn btn-outline">Звіт про виправлення</Link>
        </header>

        <form className="card flex flex-col gap-3 p-4 sm:flex-row" onSubmit={submit}>
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Точний SKU</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input className="input-sm pl-9 font-mono" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Введіть точний SKU" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={loading}>Показати історію</button>
        </form>

        {error && <div role="alert" className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><AlertTriangle size={18} /><span>{error}</span></div>}
        {loading && <div className="flex justify-center py-16"><RefreshCw size={24} className="animate-spin text-slate-500" /></div>}

        {!loading && requestedSku && data && (
          <>
            {data.lineage.integrity === 'warning' && (
              <section className="sticky top-16 z-20 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm">
                <div className="flex items-start gap-3 text-sm text-amber-900">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                  <div><strong>У збереженому ланцюжку є неузгодженості.</strong><ul className="mt-1 list-disc pl-5">{data.lineage.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul></div>
                </div>
              </section>
            )}

            <section className="card p-4 sm:p-5">
              <div className="mb-3 text-xs font-semibold uppercase text-slate-500">Ланцюжок SKU</div>
              <div className="flex flex-wrap items-center gap-2">
                {data.lineage.products.map((product, index) => (
                  <div key={product.sku} className="flex items-center gap-2">
                    {index > 0 && <ArrowRight size={15} className="text-slate-400" />}
                    <span className={`rounded-md border px-3 py-2 font-mono text-sm font-semibold ${product.sku === data.querySku ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                      {product.sku}
                      {product.sku === data.lineage.currentSku && <span className="ml-2 font-sans text-[10px] uppercase text-emerald-700">{product.status === 'active' ? 'актуальний' : 'останній'}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="ml-6 space-y-4 border-l-2 border-slate-200 pl-8">
              {groups.map((group) => <TimelineCard key={group.key} events={group.events} />)}
              {groups.length === 0 && <div className="py-10 text-sm text-slate-500">Історичні події не знайдено.</div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
