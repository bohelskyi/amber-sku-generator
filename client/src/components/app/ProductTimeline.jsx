import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  History,
  PackagePlus,
  Search,
  Undo2,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatDateTime, formatDecimal, formatUah } from '../../lib/formatters';
import { AppPageHeader, EmptyState, LoadingState, Notice, StatusBadge } from './UiPrimitives.jsx';

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
  'product.price_changed': { label: 'Ціну товару змінено', icon: History, toneClass: 'text-blue-700' },
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
    <div className="timeline-change-list divide-y divide-slate-100">
      {changes.map((change) => (
        <div key={`${change.kind}:${change.fieldKey}`} className="grid gap-1 py-2 text-sm sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1.4fr)]">
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

const CONFIGURATION_SOURCE_LABELS = {
  product_created: 'Створення товару',
  direct_recount: 'Прямий переоблік',
  correction_request: 'Виконаний запит на виправлення',
  legacy_correction: 'Застосоване виправлення',
};

function schemaVersionLabel(schema, prefix = 'Схема') {
  return schema?.version ? `${prefix} V${schema.version}` : `${prefix} не записана`;
}

function sameSchemaVersion(first, second) {
  if (!first && !second) return true;
  if (!first || !second) return false;
  return Number(first.id) === Number(second.id)
    && Number(first.version) === Number(second.version)
    && String(first.marker || '') === String(second.marker || '');
}

function ConfigurationFields({ fields, showPrevious = false }) {
  if (!fields?.length) {
    return <div className="rounded-md bg-slate-50 px-3 py-3 text-sm text-slate-500">Характеристики не записані.</div>;
  }
  return (
    <div className="timeline-configuration-fields divide-y divide-slate-100">
      {fields.map((field) => (
        <div
          key={field.key}
          data-testid={`configuration-field-${field.key}`}
          data-changed={field.changed ? 'true' : 'false'}
          className={`grid gap-1 px-2 py-2 text-sm sm:grid-cols-[minmax(140px,0.8fr)_minmax(0,1.4fr)] ${field.changed ? 'bg-amber-50/70' : ''}`}
        >
          <span className="font-medium text-slate-600">{field.fieldLabel || field.key}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-slate-700">
            {showPrevious && field.changed && field.previous && (
              <>
                <span>{valueLabel(field.previous)}</span>
                <ArrowRight size={13} className="shrink-0 text-slate-400" />
              </>
            )}
            <strong className="font-semibold text-slate-900">{valueLabel(field.value)}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function ConfigurationEvolution({ evolution }) {
  const [mode, setMode] = useState('changes');
  if (!evolution) return null;

  return (
    <section className="card p-4 sm:p-5" role="region" aria-labelledby="configuration-evolution-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="configuration-evolution-title" className="text-base font-semibold text-slate-900">
            Еволюція характеристик
          </h2>
          <p className="mt-1 text-sm text-slate-500">Підтверджені стани конфігурації та зміни між ними.</p>
        </div>
        {evolution.status !== 'unavailable' && (
          <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1" aria-label="Режим відображення характеристик">
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === 'changes' ? 'bg-white text-slate-900' : 'text-slate-500'}`}
              aria-pressed={mode === 'changes'}
              onClick={() => setMode('changes')}
            >
              Лише зміни
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === 'full' ? 'bg-white text-slate-900' : 'text-slate-500'}`}
              aria-pressed={mode === 'full'}
              onClick={() => setMode('full')}
            >
              Повний стан
            </button>
          </div>
        )}
      </div>

      {evolution.warnings?.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900" role="status">
          <ul className="list-disc space-y-1 pl-5">
            {evolution.warnings.map((item) => <li key={item.code}>{item.message}</li>)}
          </ul>
        </div>
      )}

      {evolution.status === 'unavailable' ? (
        !evolution.warnings?.length && (
          <div className="mt-4 rounded-md bg-slate-50 px-3 py-3 text-sm text-slate-500">
            Історичні конфігурації неможливо надійно відновити.
          </div>
        )
      ) : (
        <div className="relative mt-5 space-y-4 pl-7">
          <div aria-hidden="true" className="absolute bottom-4 left-[9px] top-4 w-px bg-slate-200" />
          {evolution.snapshots.map((snapshot) => {
            const currentSchemaDiffers = snapshot.isCurrent
              && !sameSchemaVersion(snapshot.establishingSchemaVersion, snapshot.currentSchemaVersion);
            const currentSkuDiffers = snapshot.isCurrent
              && snapshot.currentSku
              && snapshot.currentSku !== snapshot.establishingSku;
            return (
              <article
                key={snapshot.id}
                data-testid="configuration-snapshot"
                className="timeline-snapshot relative border-t border-slate-200 py-4"
              >
                <span aria-hidden="true" className={`absolute -left-[25px] top-5 h-3 w-3 rounded-full border-2 border-white ring-1 ${snapshot.isCurrent ? 'bg-amber-500 ring-amber-300' : 'bg-slate-400 ring-slate-200'}`} />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-900">Конфігурація {snapshot.ordinal}</h3>
                      {snapshot.isInitial && <StatusBadge>Початковий</StatusBadge>}
                      {snapshot.isCurrent && (
                        <StatusBadge tone={snapshot.productStatus === 'archived' ? 'neutral' : 'success'}>
                          {snapshot.productStatus === 'archived' ? 'Останній' : 'Поточний'}
                        </StatusBadge>
                      )}
                      {snapshot.completeness !== 'complete' && <StatusBadge tone="warning">Неповні дані</StatusBadge>}
                    </div>
                    <div className="mt-1 break-all font-mono text-sm font-semibold text-slate-800">
                      {snapshot.establishingSku}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {CONFIGURATION_SOURCE_LABELS[snapshot.source] || 'Джерело не записано'} ·{' '}
                      {snapshot.timestampStatus === 'recorded' && snapshot.occurredAt
                        ? formatDateTime(snapshot.occurredAt)
                        : 'Час не записано'}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-slate-500">
                    {schemaVersionLabel(snapshot.establishingSchemaVersion)}
                  </span>
                </div>

                {(currentSkuDiffers || currentSchemaDiffers) && (
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                    {currentSkuDiffers && (
                      <span>Поточний SKU: <strong className="font-mono">{snapshot.currentSku}</strong></span>
                    )}
                    {currentSchemaDiffers && (
                      <span>{schemaVersionLabel(snapshot.currentSchemaVersion, 'Поточна схема:')}</span>
                    )}
                  </div>
                )}

                <div className="mt-4">
                  {mode === 'changes' && !snapshot.isInitial
                    ? <TimelineChanges changes={snapshot.changes} />
                    : <ConfigurationFields fields={snapshot.fields} showPrevious={mode === 'full'} />}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PriceChange({ price }) {
  if (!price || (price.beforeUah === null && price.afterUah === null)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-sm text-slate-700">
      <span>Ціна:</span>
      <strong>{price.beforeUah === null ? 'Не записано' : formatUah(price.beforeUah)}</strong>
      <ArrowRight size={13} className="text-slate-400" />
      <strong>{price.afterUah === null ? 'Не записано' : formatUah(price.afterUah)}</strong>
    </div>
  );
}

function SkuTransition({ sourceSku, targetSku, className = '', strong = false }) {
  const skuClassName = `break-all font-mono ${strong ? 'font-semibold' : ''}`;
  return (
    <div data-testid="sku-transition" className={`flex min-w-0 flex-wrap items-center justify-start gap-2 ${className}`}>
      <span className={skuClassName}>{sourceSku}</span>
      <ArrowRight size={strong ? 14 : 13} className="shrink-0 text-slate-400" />
      <span className={skuClassName}>{targetSku}</span>
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
    <article className="timeline-card">
      <span className={`timeline-marker ${meta.toneClass}`}>
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
          <SkuTransition
            sourceSku={event.details.sourceSku}
            targetSku={event.details.correctedSku}
            className="text-sm"
            strong
          />
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
      {event.type === 'product.price_changed' && (
        <div className="mt-4 space-y-2">
          <PriceChange price={event.details.price} />
          {event.details.pricingDecision?.mode === 'manual_uah' && (
            <p className="text-xs text-slate-500">
              Введено вручну: {formatUah(event.details.pricingDecision.manualPriceUah)} · маркетингове округлення{' '}
              {event.details.pricingDecision.marketingRoundingEnabled ? 'увімкнено' : 'вимкнено'}
            </p>
          )}
        </div>
      )}

      {hasExpandable && (
        <details className="mt-4 border-t border-slate-100 pt-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700 hover:text-slate-900">Деталі</summary>
          <div className="mt-3 space-y-3">
            {proposal && (
              <div className="space-y-2 border-l-2 border-amber-300 pl-3">
                <div className="text-xs font-semibold uppercase text-amber-800">Остання збережена пропозиція</div>
                <SkuTransition sourceSku={proposal.sourceSku} targetSku={proposal.proposedSku} className="text-sm" />
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
        <AppPageHeader
          eyebrow="Журнал"
          title="Історія товару"
          description="Повна бізнес-історія за поточним або історичним SKU."
          actions={<Link to="/admin/corrections/history?mode=report" className="btn btn-outline">Звіт про виправлення</Link>}
        />

        <form className="card flex flex-col gap-3 p-4 sm:flex-row" onSubmit={submit}>
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Точний SKU</span>
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input className="input-sm pl-9 font-mono" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Введіть точний SKU" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={loading}>Показати історію</button>
        </form>

        {error && <Notice>{error}</Notice>}
        {loading && <LoadingState label="Завантажуємо історію товару…" />}
        {!loading && !requestedSku && (
          <div className="card p-0"><EmptyState>Введіть точний SKU, щоб переглянути весь ланцюжок товару.</EmptyState></div>
        )}

        {!loading && requestedSku && data && (
          <>
            {data.lineage.integrity === 'warning' && (
              <div className="sticky top-[calc(var(--workspace-nav-height)+0.5rem)] z-20">
                <Notice tone="warning"><strong>У збереженому ланцюжку є неузгодженості.</strong><ul className="mt-1 list-disc pl-5">{data.lineage.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul></Notice>
              </div>
            )}

            <section className="card p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ланцюжок SKU</div>
                <StatusBadge>{data.lineage.products.length} версій · {groups.length} подій</StatusBadge>
              </div>
              <div className="lineage-scroll" tabIndex={data.lineage.products.length > 3 ? 0 : undefined} aria-label="Ланцюжок версій SKU">
                <div className="lineage-track">
                {data.lineage.products.map((product, index) => (
                  <div key={product.sku} className="lineage-node">
                    {index > 0 && <ArrowRight size={15} className="text-slate-400" />}
                    <span className={`lineage-sku ${product.sku === data.querySku ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                      <span className="break-all">{product.sku}</span>
                      {product.sku === data.lineage.currentSku && <span className="mt-1 font-sans text-[10px] uppercase text-emerald-700">{product.status === 'active' ? 'актуальний' : 'останній'}</span>}
                    </span>
                  </div>
                ))}
                </div>
              </div>
            </section>

            <ConfigurationEvolution evolution={data.configurationEvolution} />

            <section className="timeline-list" aria-label="Хронологія подій">
              {groups.map((group) => <TimelineCard key={group.key} events={group.events} />)}
              {groups.length === 0 && <EmptyState compact>Історичні події не знайдено.</EmptyState>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
