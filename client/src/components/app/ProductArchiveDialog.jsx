import { useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';
import { ConfirmDialog, Notice } from '../ui';

export function ProductArchiveDialog({ article, internalSku, onArchived, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const archive = async () => {
    if (!internalSku || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await productsApi.archive(internalSku);
      const fallbackMessage = article
        ? `Товар ${article} пересено в архів.`
        : 'Товар пересено в архів. Артикул недоступний.';
      onArchived?.({ article, message: response.data?.message || fallbackMessage });
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
      <p className="text-sm text-slate-700">Товар <strong className="font-mono">{article || 'з недоступним артикулом'}</strong> буде виключено з поточної роботи та майбутнього експорту.</p>
      <p className="text-sm text-slate-600">Артикул, історія та резервування SKU залишаться збереженими.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {!internalSku && <Notice tone="error">Не вдалося визначити внутрішній SKU для команди.</Notice>}
    </div>
  </ConfirmDialog>;
}
