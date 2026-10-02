import { useContext, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Dialog, Notice } from '../ui';

export function ProductNameConflict({ productId, onSaved, available = true }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [open, setOpen] = useState(false); const [choice, setChoice] = useState('');
  const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const read = async (value) => {
    setChoice(value); setPreview(null); setError(''); setBusy(true);
    try { const { data } = await api.post('/magento/name-resolution/preview', { productId, choice: value });
      if (principalLifetime?.valid !== false) setPreview(data); }
    catch (failure) { setError(failure.response?.data?.error || 'Не вдалося перевірити назви.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try { await api.post('/magento/name-resolution/apply', { productId, choice, previewToken: preview.previewToken });
      if (principalLifetime?.valid !== false) { setOpen(false); onSaved?.(); } }
    catch (failure) { setPreview(null); setError(failure.response?.data?.error || 'Не вдалося узгодити назви.'); }
    finally { setBusy(false); }
  };
  return <>
    {available && (permissions.includes('exports.create') ? <button type="button" className="btn btn-outline text-xs" onClick={() => { setOpen(true); void read('amber'); }}>Вибрати актуальну назву</button>
      : <span className="text-xs text-amber-800">Узгодження назви потребує доступу до зміни назв.</span>)}
    <Dialog open={open} title="Виберіть актуальну назву"
      description="Порівняйте назви Amber і Magento. Збереження застосує вибране джерело."
      busy={busy} onClose={() => { if (!busy) setOpen(false); }} size="md"
      footer={<><button type="button" className="btn btn-outline" disabled={busy} onClick={() => setOpen(false)}>Скасувати</button>
        {!preview && !busy && <button type="button" className="btn btn-outline" onClick={() => { void read(choice || 'amber'); }}>Переглянути ще раз</button>}
        <button type="button" className="btn btn-primary" disabled={busy || !preview} onClick={() => { void save(); }}>{busy ? 'Перевіряємо…' : 'Підтвердити вибір'}</button></>}>
      <div className="space-y-4">
      <fieldset disabled={busy} className="space-y-3">
        {['amber', 'magento'].map((side) => <label key={side} className="block rounded border border-slate-200 p-3">
          <input type="radio" name="name-authority" checked={choice === side} onChange={() => { void read(side); }} />{' '}{side === 'amber' ? 'Amber' : 'Magento'}
          {preview && <span className="mt-2 block break-words text-sm">UA: {preview[side].all}<br />EN: {preview[side].en || '—'}</span>}
        </label>)}
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  </>;
}
