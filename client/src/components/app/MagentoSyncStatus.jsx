const labels = {
  not_tracked: 'Не відстежується (історичний товар)',
  pending: 'Очікує синхронізації',
  syncing: 'Синхронізується',
  synced: 'Синхронізовано',
  needs_attention: 'Потребує уваги',
};

export function MagentoSyncStatus({ status }) {
  if (!status) return null;
  return <span className="mt-1 block font-sans text-xs text-slate-600">
    <span>Magento: {labels[status.state] || labels.needs_attention}</span>
    {status.state === 'needs_attention' && status.reason && <span className="mt-1 block text-amber-800">{status.reason}</span>}
  </span>;
}
