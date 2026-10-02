import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { exportsApi } from '../../api/exports-api.js';
import { getApiError } from '../../lib/http-error.js';
import { LoadingState, Notice } from './UiPrimitives.jsx';
import { TechnicalDisclosure } from '../ui';

export function ProductMagentoNameReview({ product, onClose, onSaved, onBusyChange, translationSuggestionAvailable = false }) {
  const { principalLifetime } = useContext(AuthContext) || {};
  const alive = useRef(false);
  const generation = useRef(0);
  const id = useId();
  const [loaded, setLoaded] = useState(null);
  const [subjects, setSubjects] = useState({ subjectUa: '', subjectEn: '' });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);
  const [stale, setStale] = useState(false);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const current = useCallback((value) => alive.current && value === generation.current && principalLifetime?.valid !== false, [principalLifetime]);

  useEffect(() => {
    alive.current = true;
    const value = ++generation.current;
    exportsApi.previewMagentoName({ productId: product.productId }).then(({ data }) => {
      if (!current(value)) return;
      setLoaded(data); setSubjects({ subjectUa: data.subjectUa || '', subjectEn: data.subjectEn || '' });
    }).catch((failure) => { if (current(value)) setError(getApiError(failure)); })
      .finally(() => { if (current(value)) setBusy(false); });
    return () => { alive.current = false; generation.current += 1; };
  }, [product.productId, principalLifetime, reload, current]);

  const edit = (key, text) => {
    generation.current += 1;
    setSubjects((value) => ({ ...value, [key]: text })); setPreview(null); setError('');
  };
  const report = (failure) => {
    setError(getApiError(failure));
    if (failure.response?.status === 409 || failure.response?.data?.code === 'STALE_MAGENTO_NAME') {
      setStale(true); setPreview(null);
    }
  };
  const unchanged = loaded && subjects.subjectUa === loaded.subjectUa && subjects.subjectEn === loaded.subjectEn;
  const perform = async (action) => {
    if (busy || stale || !loaded) return;
    const value = generation.current;
    setBusy(true); setError('');
    try {
      if (action === 'suggest') {
        const { data } = await exportsApi.suggestMagentoName({ productId: product.productId, subjectUa: subjects.subjectUa.trim() });
        if (current(value)) edit('subjectEn', data.subjectEn);
      } else if (action === 'preview') {
        const { data } = await exportsApi.previewMagentoName({ productId: product.productId, ...subjects });
        if (current(value)) setPreview({ ...data, submittedSubjects: { ...subjects } });
      } else {
        const evidence = action === 'unchanged' ? loaded : preview;
        if (!evidence?.previewToken || (action === 'unchanged' && !unchanged)) return;
        await exportsApi.applyMagentoName({ productId: product.productId,
          ...(action === 'unchanged' ? subjects : evidence.submittedSubjects),
          previewToken: evidence.previewToken, ...(action === 'unchanged' ? { confirmUnchanged: true } : {}) });
        if (current(value)) onSaved();
      }
    } catch (failure) { if (current(value)) report(failure); }
    finally { if (alive.current && principalLifetime?.valid !== false) setBusy(false); }
  };

  return <div className="space-y-4">
    <h2 className="text-lg font-semibold">Назви для Magento · {product.publicSku || 'Артикул недоступний'}</h2>
    {!product.publicSku && product.sku && <TechnicalDisclosure summary="Технічна ідентичність">
      <p className="break-all font-mono text-xs">Внутрішній SKU: {product.sku}</p>
    </TechnicalDisclosure>}
    {loaded?.reviewRequired && <Notice tone="warning">Потрібна перевірка успадкованих назв</Notice>}
    <p className="text-sm text-slate-600">Перевірте українську й англійську назви. Підтвердження збереже рішення та дозволить повторно перевірити готовність до синхронізації.</p>
    {!loaded && busy && <LoadingState label="Читаємо поточні назви…" />}
    <label className="block text-sm" htmlFor={`${id}-ua`}>Українська назва
      <input id={`${id}-ua`} className="input mt-1" value={subjects.subjectUa} maxLength={200}
        disabled={!loaded || busy || stale} onChange={(event) => edit('subjectUa', event.target.value)} /></label>
    <label className="block text-sm" htmlFor={`${id}-en`}>Англійська назва (EN)
      <input id={`${id}-en`} className="input mt-1" value={subjects.subjectEn} maxLength={200}
        disabled={!loaded || busy || stale} onChange={(event) => edit('subjectEn', event.target.value)} /></label>
    {translationSuggestionAvailable && <button type="button" className="btn btn-outline" disabled={busy || stale || !loaded || !subjects.subjectUa.trim()}
      onClick={() => perform('suggest')}>Запропонувати переклад</button>}
    {preview && <Notice><strong>Попередній перегляд</strong><p>UA: {preview.nameUa}</p><p>EN: {preview.nameEn}</p></Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {stale && <Notice tone="warning">Товар змінився під час перевірки. Завантажте актуальні назви й перевірте їх заново.</Notice>}
    <div className="flex flex-wrap gap-2">
      {loaded?.canConfirmUnchanged && unchanged && !stale && <button type="button" className="btn btn-primary" disabled={busy}
        onClick={() => perform('unchanged')}>Підтвердити без змін</button>}
      {!unchanged && loaded && !preview && !stale && <button type="button" className="btn btn-primary"
        disabled={busy || !subjects.subjectUa.trim() || !subjects.subjectEn.trim()} onClick={() => perform('preview')}>Переглянути зміни</button>}
      {preview && <button type="button" className="btn btn-primary" disabled={busy || stale} onClick={() => perform('apply')}>Зберегти назви</button>}
      {(error || stale) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setLoaded(null); setPreview(null); setError(''); setStale(false); setBusy(true); setReload((value) => value + 1); }}>Завантажити актуальні назви</button>}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>Закрити</button>
    </div>
    {busy && <p role="status" className="text-sm">Обробляємо…</p>}
  </div>;
}
