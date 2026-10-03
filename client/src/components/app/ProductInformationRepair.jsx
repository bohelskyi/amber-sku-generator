import { useContext, useEffect, useId, useRef, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Notice } from './UiPrimitives.jsx';

export function ProductInformationRepair({ product, onClose, onSaved, onBusyChange }) {
  const { principalLifetime } = useContext(AuthContext) || {};
  const id = useId();
  const alive = useRef(false);
  const generation = useRef(0);
  const [size, setSize] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; onBusyChange?.(false); };
  }, [product.productId, principalLifetime, onBusyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const current = (value) => alive.current && value === generation.current && principalLifetime?.valid !== false;
  const changeSize = (value) => { generation.current += 1; setSize(value); setPreview(null); setError(''); };
  const review = async () => {
    if (busy || !size.trim()) return;
    const value = generation.current;
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/product-information/preview', {
        productId: product.productId,
        answersPatch: { size: size.trim() },
      });
      if (current(value)) setPreview({ ...data,
        reviewedSize: data.changes?.find((change) => change.key === 'size')?.after ?? size.trim() });
    } catch (failure) { if (current(value)) setError(failure?.response?.data?.error || failure.message); }
    finally { if (current(value)) setBusy(false); }
  };
  const apply = async () => {
    if (busy || !preview?.previewToken) return;
    const value = generation.current;
    setBusy(true); setError('');
    try {
      await api.post('/product-information/apply', {
        productId: product.productId,
        answersPatch: { size: preview.reviewedSize },
        previewToken: preview.previewToken,
        reason: 'Доповнення даних для синхронізації Magento',
      });
      if (current(value)) onSaved?.();
    } catch (failure) {
      if (current(value)) { setPreview(null); setError(failure?.response?.data?.error || failure.message); }
    } finally { if (current(value)) setBusy(false); }
  };
  return <div className="space-y-4">
    <h2 className="text-lg font-semibold">Розмір товару · {product.publicSku || 'Артикул недоступний'}</h2>
    <p className="text-sm text-slate-600">Ця дія доповнить лише інформаційне поле розміру. Артикул, ціна та історія переобліку не зміняться.</p>
    <label className="block text-sm" htmlFor={`${id}-size`}>Розмір
      <input id={`${id}-size`} className="input mt-1" value={size} maxLength={500} disabled={busy}
        onChange={(event) => changeSize(event.target.value)} /></label>
    {preview && <Notice><strong>Попередній перегляд</strong><p>Розмір: {preview.reviewedSize}</p></Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="flex flex-wrap gap-2">
      {!preview && <button type="button" className="btn btn-primary" disabled={busy || !size.trim()} onClick={review}>Переглянути зміну</button>}
      {preview && <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>Зберегти розмір</button>}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>Закрити</button>
    </div>
    {busy && <p role="status" className="text-sm">Обробляємо…</p>}
  </div>;
}
