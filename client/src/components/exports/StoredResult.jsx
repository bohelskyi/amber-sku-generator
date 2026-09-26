import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context';
import { exportsApi } from '../../api/exports-api';
import { StoredSnapshot } from './StoredSnapshot';
import { getApiError } from '../../lib/http-error';
import { downloadBlob } from '../../lib/download';

export function StoredResult({ id, stream = 'product', canCreate, onDenied }) {
  const { principalLifetime } = useAuth(); const alive = useRef(true); const accessible = useRef(true); const seenEpoch = useRef(null);
  const current = useCallback(() => alive.current && accessible.current && principalLifetime?.valid !== false, [principalLifetime]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [snapshot, setSnapshot] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const loading = useRef(false); const reading = useRef(false); const readTicket = useRef(0); const price = stream === 'price';
  const denied = useCallback(() => { if (!current()) return; accessible.current = false; setSnapshot(null); setError('Доступ до результату втрачено.'); onDenied?.(); }, [current, onDenied]);
  const read = useCallback(async () => {
    if (!current() || reading.current) return;
    reading.current = true;
    const ticket = ++readTicket.current;
    try {
      const { data } = await (price ? exportsApi.getPriceSnapshot(id) : exportsApi.getSnapshot(id)); if (!current() || ticket !== readTicket.current) return;
      if (seenEpoch.current !== null && seenEpoch.current !== data.accessEpoch) { denied(); return; }
      seenEpoch.current = data.accessEpoch; setSnapshot(data); setError('');
    } catch (e) { if (!current() || ticket !== readTicket.current) return; if ([401,403,404].includes(e.response?.status)) denied(); else setError(getApiError(e)); }
    finally { reading.current = false; }
  }, [id, current, denied, price]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void read(); }, 0); const focus = () => { if (!loading.current) void read(); };
    const timer = window.setInterval(() => { if (!document.hidden && !loading.current) void read(); }, 10000);
    window.addEventListener('focus', focus); return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [read]);
  const run = async (task) => {
    if (!current() || loading.current) return false; loading.current = true; setBusy(true); setError('');
    try { await task(); return current(); }
    catch (e) { if (current()) { if ([401,403,404].includes(e.response?.status)) denied(); else setError(getApiError(e)); } return false; }
    finally { loading.current = false; if (current()) setBusy(false); }
  };
  return <section className="card p-3 space-y-3">
    {error && <p role="alert">{error}</p>}
    {!snapshot ? <p role="status">{error ? 'Результат недоступний.' : 'Завантаження збереженого результату…'}</p> : <StoredSnapshot snapshot={snapshot} loading={busy} canConfirm={canCreate} onDenied={denied}
      onDownload={(group) => run(async () => {
        const response = await (price ? exportsApi.downloadPriceSnapshot(id) : exportsApi.downloadMagentoArtifact(id, group)); if (!current()) return;
        downloadBlob(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }), snapshot.artifacts.find((a) => a.groupCode === group)?.fileName || snapshot.fileName, { documentRef: document, urlApi: window.URL });
      })} onConfirm={() => run(async () => {
        if (!canCreate || !current()) return;
        await (price ? exportsApi.confirmPriceSnapshot(id) : exportsApi.confirmSnapshot(id, snapshot.accessEpoch)); if (current()) await read();
      })} />}
  </section>;
}
