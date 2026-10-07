import { useContext, useEffect, useId, useRef, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { getApiError } from '../../lib/http-error.js';
import { Notice } from './UiPrimitives.jsx';

const valid = name => typeof name === 'string' && name.trim() && name.length <= 1024 && !Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function EffectiveProductNameReview({ product, initial, onClose, onSaved, onBusyChange }) {
  const { principalLifetime } = useContext(AuthContext) || {};
  const id = useId(); const generation = useRef(0); const alive = useRef(true);
  const [loaded, setLoaded] = useState(initial); const [names, setNames] = useState(initial.names || { all: '', en: '' });
  const [review, setReview] = useState(null); const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [stale, setStale] = useState(false); const [editing, setEditing] = useState(!initial.readiness?.ready);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const current = value => alive.current && value === generation.current && principalLifetime?.valid !== false;
  const perform = async action => {
    if (busy || principalLifetime?.valid === false) return;
    const value = ++generation.current; setBusy(true); setError('');
    try {
      if (action === 'reload') {
        const { data } = await api.get(`/product-names/${product.productId}/readiness`);
        if (!current(value)) return;
        if (!data.readiness) { setStale(true); setError('Правила назв змінилися. Закрийте форму й відкрийте її знову.'); return; }
        setLoaded(data); setNames(data.names || { all: '', en: '' }); setReview(null); setRemote(null); setStale(false); setEditing(!data.readiness.ready);
      } else if (action === 'remote') {
        const { data } = await api.post('/magento/name-resolution/preview', { productId: product.productId, choice: 'magento', intent: 'complete' });
        if (current(value)) { setRemote(data); setReview(null); }
      } else {
        if (stale) return;
        if (action === 'import' && remote) await api.post('/magento/name-resolution/apply', {
          productId: product.productId, choice: 'magento', intent: 'complete', previewToken: remote.previewToken });
        else if (action === 'save' && review) await api.post('/product-names/save', {
          productId: product.productId, names: review, previewToken: loaded.previewToken });
        else return;
        if (current(value)) onSaved?.();
      }
    } catch (failure) {
      if (current(value)) { setError(getApiError(failure)); setReview(null); setRemote(null); if (failure.response?.status === 409) setStale(true); }
    } finally { if (alive.current && principalLifetime?.valid !== false) setBusy(false); }
  };
  return <div className="space-y-4">
    <h2 className="text-lg font-semibold">Повні назви · {initial.publicSku || loaded.readiness?.article || product.publicSku || 'Артикул недоступний'}</h2>
    {loaded.readiness?.ready && <Notice>Поточні назви: {loaded.readiness.source === 'template' ? 'сформовані опублікованим шаблоном' : 'збережена повна пара UA/EN'}.</Notice>}
    {!loaded.readiness?.ready && <p className="text-sm text-slate-600">Шаблон не сформував повну пару UA/EN. Введіть повні назви або перегляньте назви цього товару в Magento.</p>}
    {loaded.nameConflict && <Notice tone="warning">Спочатку узгодьте конфлікт назв у проблемах синхронізації.</Notice>}
    {['all', 'en'].map(field => <label key={field} className="block text-sm" htmlFor={`${id}-${field}`}>
      {field === 'all' ? 'Повна назва українською' : 'Повна назва англійською (EN)'}
      <input id={`${id}-${field}`} className="input mt-1" maxLength={1024} value={names[field]}
        readOnly={!editing} disabled={busy || stale || loaded.nameConflict} onChange={event => {
          generation.current += 1; setNames(previous => ({ ...previous, [field]: event.target.value })); setReview(null); setRemote(null); setError('');
        }} /></label>)}
    {!editing && !loaded.nameConflict && <button type="button" className="btn btn-outline" disabled={busy || stale} onClick={() => setEditing(true)}>Змінити повні назви</button>}
    {review && <Notice><strong>Перевірте повні назви перед збереженням</strong><p>UA: {review.all}</p><p>EN: {review.en}</p></Notice>}
    {remote && <Notice><strong>Перевірені назви Magento</strong><p>UA: {remote.magento.all}</p><p>EN: {remote.magento.en}</p><p>Імпорт збереже саме цю повну пару для цього товару.</p></Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="flex flex-wrap gap-2">
      {editing && !review && !remote && <button type="button" className="btn btn-primary" disabled={busy || stale || loaded.nameConflict || !valid(names.all) || !valid(names.en)} onClick={() => setReview({ ...names })}>Переглянути зміни</button>}
      {review && <button type="button" className="btn btn-primary" disabled={busy || stale} onClick={() => perform('save')}>Зберегти повні назви</button>}
      {!loaded.readiness?.ready && !loaded.nameConflict && !remote && <button type="button" className="btn btn-outline" disabled={busy || stale} onClick={() => perform('remote')}>Перевірити назви в Magento</button>}
      {remote && <button type="button" className="btn btn-primary" disabled={busy || stale} onClick={() => perform('import')}>Імпортувати перевірені назви</button>}
      {(error || stale) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => perform('reload')}>Оновити перевірку</button>}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>Закрити</button>
    </div>
    {busy && <p role="status" className="text-sm">Перевіряємо…</p>}
  </div>;
}
