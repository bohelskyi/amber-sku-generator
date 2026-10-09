import { useContext, useEffect, useRef, useState } from 'react';
import { Pencil, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';
import { ProductMagentoNameReview } from './ProductMagentoNameReview.jsx';

export function RecountNameFields({ product, productId, mode, busy, onChange }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [current, setCurrent] = useState(null); const [draft, setDraft] = useState({ all: '', en: '' });
  const [editing, setEditing] = useState(false); const [error, setError] = useState(null);
  const [repairOpen, setRepairOpen] = useState(false); const [repairBusy, setRepairBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const ukrainianInputRef = useRef(null);
  useEffect(() => {
    if (editing) ukrainianInputRef.current?.focus();
  }, [editing]);
  const canRead = Boolean(productId && permissions.includes('products.decode'));
  useEffect(() => {
    if (!canRead || principalLifetime?.valid === false) return undefined;
    let live = true; const controller = new AbortController();
    api.get(`/product-names/${productId}`, { signal: controller.signal }).then(({ data }) => {
      if (live && principalLifetime?.valid !== false) { setCurrent(data); setDraft(data.names); setError(null); }
    }).catch((failure) => {
      if (!live || failure?.name === 'CanceledError') return;
      const code = failure?.response?.data?.code;
      const status = failure?.response?.status;
      const details = failure?.response?.data?.details;
      if (status === 422 && code === 'PRODUCT_NAMES_INVALID' && details?.nameConflict) {
        setError({ kind: 'controlled', message: 'Спочатку узгодьте назву в проблемах синхронізації.' });
      } else if (status === 422 && code === 'PRODUCT_NAMES_INVALID' && ['product_magento_name', 'effective_product_names'].includes(details?.repair)) {
        setError({ kind: 'missing-pair', message: 'Сервер не може сформувати чинну пару назв українською та англійською. Їх можна заповнити окремо від переобліку.' });
      } else if (status === 403) {
        setError({ kind: 'permission', message: 'Назви недоступні для вашого рівня доступу. Зміни характеристик залишаються доступними.' });
      } else if (status === 409) {
        setError({ kind: 'controlled', message: failure?.response?.data?.error || 'Стан назв контролюється окремо. Відкрийте актуальний товар.' });
      } else {
        setError({ kind: 'unexpected', message: 'Не вдалося завантажити назви через неочікувану помилку. Зміни характеристик залишаються доступними.' });
      }
    });
    return () => { live = false; controller.abort(); };
  }, [productId, product?.categoryCode, canRead, principalLifetime, reload]);
  if (!canRead) return null;
  const canEdit = mode !== 'request' && permissions.includes('products.recount') && onChange;
  const invalid = editing && [draft.all, draft.en].some((name) => !name.trim() || name.length > 1024
    || Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
  return <>
    {!current && !error && <p className="px-5 py-2 text-sm text-slate-500">Завантажуємо назви…</p>}
    {error && <div className="px-5 py-2 text-sm text-slate-600"><p>{error.message}</p>
      {error.kind === 'missing-pair' && (permissions.includes('exports.create')
        ? <button type="button" className="btn btn-outline mt-2" disabled={busy} onClick={() => setRepairOpen(true)}>Заповнити назви</button>
        : <p className="mt-1">Передайте заповнення оператору з дозволом на зміну назв для Magento.</p>)}</div>}
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
    {repairOpen && <WorkspaceDialog title="Заповнення назв для Magento" onClose={() => setRepairOpen(false)} busy={repairBusy}>
      <ProductMagentoNameReview product={{ ...product, productId }} onBusyChange={setRepairBusy}
        onClose={() => setRepairOpen(false)} onSaved={() => {
          setRepairOpen(false); setCurrent(null); setError(null); onChange?.(null); setReload((value) => value + 1);
        }} />
    </WorkspaceDialog>}
  </>;
}
