import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
export function RepricingSyncProgress({ batchId }) {
  const [status, setStatus] = useState(null); const [error, setError] = useState(false);
  useEffect(() => {
    let live = true; let timer; const controller = new AbortController();
    const read = () => {
      window.clearTimeout(timer);
      if (document.hidden) { timer = window.setTimeout(read, 10000); return; }
      api.get(`/admin/repricing/batches/${batchId}/sync-status`, { signal: controller.signal })
        .then(({ data }) => { if (live) { setStatus(data); setError(false);
          if (data.pending > 0 || data.needsAttention > 0) timer = window.setTimeout(read, data.pending > 0 ? 5000 : 15000); } })
        .catch(() => { if (live) { setError(true); timer = window.setTimeout(read, 15000); } });
    };
    read(); window.addEventListener('focus', read);
    return () => { live = false; controller.abort(); window.clearTimeout(timer); window.removeEventListener('focus', read); };
  }, [batchId]);
  if (error) return <p className="text-xs text-slate-500">Стан Magento тимчасово недоступний.</p>;
  if (!status) return <p className="text-xs text-slate-500">Завантажуємо стан Magento…</p>;
  if (status.status === 'rolled_back') return <p className="text-xs text-slate-500">Переоцінку відкочено. Поточний стан товарів доступний у списку проблем синхронізації.</p>;
  return <div className="text-sm" aria-live="polite"><strong>Magento</strong>
    <p>{status.synced} / {status.total} синхронізовано</p>
    <p>{status.pending} очікують · {status.needsAttention} потребують уваги</p>
    {status.notTracked > 0 && <p className="text-xs text-slate-500">Для {status.notTracked} товарів синхронізацію цієї переоцінки не відстежували.</p>}
  </div>;
}
