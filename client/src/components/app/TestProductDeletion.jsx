import { useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';

export function TestProductDeletion({ product, onDeleted, onClose }) {
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  async function check() {
    setBusy(true); setError('');
    try { setPreview((await productsApi.previewTestDeletion(product.id)).data); }
    catch (e) { setError(getApiError(e)); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const { data } = await productsApi.applyTestDeletion({ productId: product.id,
        previewHash: preview.previewHash, confirmation });
      if (data.state === 'finalized') { onDeleted(data); onClose(); }
      else setUncertain(true);
    } catch (e) { setError(getApiError(e)); }
    finally { setBusy(false); }
  }
  return <WorkspaceDialog title="Видалити тестовий товар" busy={busy} onClose={onClose}>
      <h2 id="test-delete-title" className="text-lg font-semibold">Видалити тестовий товар</h2>
      <p className="mt-3">Артикул: <strong className="font-mono">{product.public_sku || 'недоступний'}</strong></p>
      <p className="mt-3">Товар буде назавжди видалено з Magento. Amber збереже технічний запис і журнал аудиту.
        Внутрішній SKU і публічний артикул ніколи не використовуватимуться повторно.</p>
      <p className="mt-3">Для проданого товару або товару з робочою історією використайте звичайне архівування.</p>
      {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
      {uncertain && <p role="status" className="mt-3">Результат видалення ще не підтверджено. Товар заблоковано для змін.
        Повторна перевірка лише читає Magento та не надсилає DELETE повторно.</p>}
      {preview && <label className="mt-4 block">Введіть точно {preview.publicSku}
        <input autoFocus className="input mt-2" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} />
      </label>}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>Закрити</button>
        {!preview ? <button type="button" className="btn btn-danger" disabled={busy} onClick={check}>Перевірити можливість видалення</button>
          : <button type="button" className="btn btn-danger" disabled={busy || confirmation !== preview.publicSku} onClick={apply}>
            {busy ? 'Перевірка…' : uncertain || preview.state !== 'preview' ? 'Перевірити результат видалення' : 'Назавжди видалити з Magento'}
          </button>}
      </div>
  </WorkspaceDialog>;
}
