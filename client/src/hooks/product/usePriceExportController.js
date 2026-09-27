import { useCallback, useEffect, useRef, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { downloadBlob } from '../../lib/download';
import { getApiError } from '../../lib/http-error';

export function usePriceExportController({ current, canCreate, onConfirmed }) {
  const [review, setReview] = useState(null); const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false);
  const operation = useRef(null); const working = useRef(false); const [changed, setChanged] = useState(false);
  const capturedReview = useRef(null); const storedRead = useRef(null);
  const [compared, setCompared] = useState(false);
  const snapshotId = snapshot?.id;
  const readArtifact = useCallback(async () => {
    if (!current() || !snapshotId) throw new Error('Результат недоступний.');
    if (storedRead.current?.id !== snapshotId) {
      const id = snapshotId;
      const promise = exportsApi.readPriceArtifact(id).then(({ data }) => {
        if (!current() || storedRead.current?.id !== id) throw new Error('Результат недоступний.');
        setChanged(capturedReview.current !== null && data !== capturedReview.current);
        setCompared(true);
        return data;
      }).catch((cause) => { if (storedRead.current?.id === id) storedRead.current = null; throw cause; });
      storedRead.current = { id, promise };
    }
    return storedRead.current.promise;
  }, [current, snapshotId]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  const run = useCallback(async (task) => {
    if (!current() || working.current) return false;
    working.current = true; setBusy(true); setError('');
    try { await task(); return current(); }
    catch (cause) { if (current()) setError(getApiError(cause)); return false; }
    finally { working.current = false; if (current()) setBusy(false); }
  }, [current]);
  const check = () => run(async () => {
    if (snapshot || operation.current) return;
    const response = await exportsApi.previewPrices(); if (current()) setReview(response.data);
  });
  const create = () => run(async () => {
    if (!canCreate || snapshot || (!operation.current && !review?.rowCount)) return;
    if (!operation.current) operation.current = { key: crypto.randomUUID(), csv: review.csvContent };
    setPending(true);
    const original = operation.current;
    let response;
    try { response = await exportsApi.createPriceSnapshot(original.key); }
    catch (cause) {
      if (current() && cause.response?.data?.code === 'NO_PENDING_PRICE_EXPORTS') {
        operation.current = null; setPending(false); setReview(null);
      }
      throw cause;
    }
    if (!current()) return;
    const captured = { ...response.data, stream: 'price', artifacts: [{ groupCode: 'prices', fileName: response.data.fileName, rowCount: response.data.rowCount }] };
    capturedReview.current = original.csv;
    setSnapshot(captured); operation.current = null; setPending(false);
    try {
      const metadata = await exportsApi.getPriceSnapshot(captured.id); if (!current()) return;
      setSnapshot(metadata.data);
    } catch { if (current()) setError('Файли створено, але таблицю не вдалося завантажити.'); }
  });
  const download = () => run(async () => {
    const response = await exportsApi.downloadPriceSnapshot(snapshot.id); if (!current()) return;
    downloadBlob(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }), snapshot.fileName, { documentRef: document, urlApi: window.URL });
  });
  const confirm = () => run(async () => {
    if (!canCreate || !snapshot || snapshot.status === 'confirmed') return;
    await exportsApi.confirmPriceSnapshot(snapshot.id); if (!current()) return;
    setSnapshot((s) => ({ ...s, status: 'confirmed' }));
    const metadata = await exportsApi.getPriceSnapshot(snapshot.id); if (!current()) return;
    setSnapshot((s) => ({ ...metadata.data, artifacts: s.artifacts })); await onConfirmed();
  });
  const reset = () => { if (working.current || operation.current || !current()) return; storedRead.current = null; capturedReview.current = null; setSnapshot(null); setReview(null); setChanged(false); setCompared(false); setError(''); };
  return { review, snapshot, error, busy, pending, changed, compared, check, create, download, confirm, reset, readArtifact };
}
