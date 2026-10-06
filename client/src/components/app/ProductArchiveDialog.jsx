import { useEffect, useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';
import { ConfirmDialog, Notice } from '../ui';

export function ProductArchiveDialog({ article, internalSku, lifecycleAvailable = false, onBusyChange, onArchived, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);

  const archive = async () => {
    if (!internalSku || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await productsApi.archive(internalSku);
      const fallbackMessage = article
        ? `Товар ${article} перенесено в архів.`
        : 'Товар перенесено в архів. Артикул недоступний.';
      const visibility = response.data?.visibilityIntent;
      const visibilityMessage = visibility?.status === 'queued' ? ' Приховування в Magento очікує перевірки.'
        : visibility?.status === 'blocked' ? ' Видимість у Magento ще не змінено: потрібна окрема перевірка.' : '';
      onArchived?.({ article, visibilityIntent: visibility, message: (response.data?.message || fallbackMessage) + visibilityMessage });
    } catch (requestError) {
      setError(getApiError(requestError));
    } finally {
      setBusy(false);
    }
  };

  return <ConfirmDialog open title="Архівувати товар?"
    description="Перевірте артикул перед підтвердженням."
    confirmLabel={busy ? 'Архівуємо…' : 'Архівувати товар'}
    confirmDisabled={!internalSku} tone="danger" busy={busy} onConfirm={archive} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4">
      <p className="text-sm text-slate-700">Товар <strong className="font-mono">{article || 'з недоступним артикулом'}</strong> буде виключено з поточної роботи в Amber.</p>
      {lifecycleAvailable && <p className="text-sm text-slate-600">Для Magento буде створено контрольовану заявку на приховування. Результат вважається підтвердженим лише після перевірки стану товару. Товар не видаляється.</p>}
      <p className="text-sm text-slate-600">Артикул, історія та резервування SKU залишаться збереженими.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {!internalSku && <Notice tone="error">Не вдалося визначити артикул для команди.</Notice>}
    </div>
  </ConfirmDialog>;
}
