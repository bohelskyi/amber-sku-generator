import { StatusBadge } from './UiPrimitives.jsx';
const labels = {
  not_tracked: 'Синхронізацію ще не відстежуємо',
  pending: 'Очікує синхронізації',
  syncing: 'Синхронізується',
  synced: 'Синхронізовано',
  needs_attention: 'Потребує уваги',
  unknown: 'Стан невідомий',
};

export function MagentoSyncStatus({ status }) {
  if (!status) return null;
  return <span className="inline-flex flex-wrap items-center gap-2 font-sans text-xs">
    <StatusBadge tone={status.state === 'synced' ? 'success' : status.state === 'needs_attention' ? 'warning' : 'neutral'}>Magento: {labels[status.state] || labels.unknown}</StatusBadge>
    {status.state === 'synced' && status.confirmedAt && Number.isFinite(Date.parse(status.confirmedAt)) && <time dateTime={status.confirmedAt}>Підтверджено {new Date(status.confirmedAt).toLocaleString('uk-UA')}</time>}
    {status.state === 'needs_attention' && status.reason && <span className="text-amber-800">{status.reason}</span>}
  </span>;
}
