import { useContext, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Notice } from './UiPrimitives.jsx';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';

export function ProductNameConflict({ productId, onSaved }) {
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
    {permissions.includes('exports.create') ? <button className="btn btn-outline text-xs" onClick={() => { setOpen(true); void read('amber'); }}>Вибрати актуальну назву</button>
      : <span className="text-xs text-amber-800">Узгодження назви потребує доступу до зміни назв.</span>}
    {open && <WorkspaceDialog title="Узгодження назви" busy={busy} onClose={() => setOpen(false)}>
      <h2 className="text-lg font-semibold">Виберіть актуальну назву</h2>
      <p className="text-sm">Порівняйте назви Amber і Magento та підтвердьте актуальну.</p>
      <fieldset disabled={busy} className="space-y-3">
        {['amber', 'magento'].map((side) => <label key={side} className="block rounded border border-slate-200 p-3">
          <input type="radio" name="name-authority" checked={choice === side} onChange={() => { void read(side); }} />{' '}{side === 'amber' ? 'Amber' : 'Magento'}
          {preview && <span className="mt-2 block break-words text-sm">UA: {preview[side].all}<br />EN: {preview[side].en || '—'}</span>}
        </label>)}
      </fieldset>
      {error && <Notice>{error}</Notice>}
      <div className="flex flex-wrap gap-2"><button className="btn btn-outline" disabled={busy} onClick={() => setOpen(false)}>Скасувати</button>
        <button className="btn btn-primary" disabled={busy || !preview} onClick={() => { void save(); }}>{busy ? 'Перевіряємо…' : 'Підтвердити вибір'}</button>
        {!preview && !busy && <button className="btn btn-outline" onClick={() => { void read(choice); }}>Переглянути ще раз</button>}
      </div>
    </WorkspaceDialog>}
  </>;
}
