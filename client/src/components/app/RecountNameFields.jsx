import { useContext, useEffect, useRef, useState } from 'react';
import { Pencil, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';

export function RecountNameFields({ productId, mode, busy, onChange }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [current, setCurrent] = useState(null); const [draft, setDraft] = useState({ all: '', en: '' });
  const [editing, setEditing] = useState(false); const [error, setError] = useState('');
  const ukrainianInputRef = useRef(null);
  useEffect(() => {
    if (editing) ukrainianInputRef.current?.focus();
  }, [editing]);
  const canRead = Boolean(productId && permissions.includes('products.decode'));
  useEffect(() => {
    if (!canRead || principalLifetime?.valid === false) return undefined;
    let live = true; const controller = new AbortController();
    api.get(`/product-names/${productId}`, { signal: controller.signal }).then(({ data }) => {
      if (live && principalLifetime?.valid !== false) { setCurrent(data); setDraft(data.names); }
    }).catch(() => { if (live) setError('Не вдалося завантажити назви. Зміни характеристик залишаються доступними.'); });
    return () => { live = false; controller.abort(); };
  }, [productId, canRead, principalLifetime]);
  if (!canRead) return null;
  const canEdit = mode !== 'request' && permissions.includes('products.recount') && permissions.includes('exports.create') && onChange;
  const invalid = editing && [draft.all, draft.en].some((name) => !name.trim() || name.length > 1024
    || Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
  return <>
    {!current && !error && <p className="px-5 py-2 text-sm text-slate-500">Завантажуємо назви…</p>}
    {error && <p className="px-5 py-2 text-sm text-slate-600">{error}</p>}
    {current && [['all', 'Назва товару українською'], ['en', 'Назва товару англійською']].map(([field, label]) => <div key={field}
      className={`builder-field-row ${invalid ? 'is-invalid' : ''}`}><div className="builder-field-label flex flex-wrap items-baseline gap-x-2 gap-y-1"><label htmlFor={`recount-name-${field}`}>{label}</label>
        {field === 'all' && canEdit && !current.nameConflict && <button type="button"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-slate-500 underline hover:text-slate-800"
          disabled={busy} aria-controls="recount-name-all recount-name-en"
          title={editing ? 'Скасувати зміни обох назв' : 'Змінити українську та англійську назви'}
          onClick={() => {
            if (editing) { setDraft({ ...current.names }); onChange(null); }
            setEditing(!editing);
          }}>
          {editing ? <Undo2 size={13} aria-hidden="true" /> : <Pencil size={13} aria-hidden="true" />}
          {editing ? 'Скасувати' : 'Змінити'}
        </button>}
      </div>
      <div className="min-w-0"><input ref={field === 'all' ? ukrainianInputRef : undefined} id={`recount-name-${field}`} className={`input ${!editing || !canEdit || current.nameConflict ? 'input-readonly' : ''}`} value={draft[field]} maxLength={1024}
        readOnly={!editing || !canEdit || current.nameConflict} disabled={busy} aria-invalid={invalid || undefined}
        onChange={(event) => {
          const next = { ...draft, [field]: event.target.value }; setDraft(next);
          onChange(next.all === current.names.all && next.en === current.names.en ? null : next);
        }} /></div></div>)}
    {current?.nameConflict && <p className="px-5 pb-3 text-sm text-amber-800">Спочатку узгодьте назву. <Link className="underline" to="/sync-problems">Проблеми синхронізації</Link></p>}
    {invalid && <p role="alert" className="builder-field-error px-5">Введіть обидві назви без переносів рядка (до 1024 символів).</p>}
  </>;
}
