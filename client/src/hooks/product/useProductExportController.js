import { useCallback, useEffect, useRef, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { downloadBlob } from '../../lib/download';
import { getApiError } from '../../lib/http-error';

export function useProductExportController({ enabled = true, canCreate = true, principalLifetime } = {}) {
  const [exportStatus, setExportStatus] = useState(null);
  const [exportFromSku, setExportFromSku] = useState('');
  const [exportToSku, setExportToSku] = useState('');
  const [exportError, setExportError] = useState('');
  const [isExportLoading, setIsExportLoading] = useState(false);
  const [exportPreview, setExportPreview] = useState(null);
  const [exportSnapshot, setExportSnapshot] = useState(null);
  const [priceExportStatus, setPriceExportStatus] = useState(null);
  const [priceExportError, setPriceExportError] = useState('');
  const [isPriceExportLoading, setIsPriceExportLoading] = useState(false);
  const [templateMode, setTemplateMode] = useState(false);
  const [templateSelection, setTemplateSelection] = useState({ mode: 'active' });
  const [pendingCreate, setPendingCreate] = useState(null);
  const previewEvidence = useRef(null);
  const pending = useRef(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const current = useCallback(() => alive.current && enabled && principalLifetime?.valid !== false, [enabled, principalLifetime]);
  const requested = useRef({ templateMode: false, selection: { mode: 'active' }, fromSku: '', toSku: '' });

  const invalidate = () => { generation.current++; previewEvidence.current = null; setExportPreview(null); };
  const updateTemplateMode = (value) => { if (!current()) return; requested.current.templateMode = value; setTemplateMode(value); invalidate(); };
  const updateTemplateSelection = (value) => { if (!current()) return; requested.current.selection = { ...value }; setTemplateSelection(value); invalidate(); };

  const updateExportFromSku = (value) => {
    if (!current()) return;
    requested.current.fromSku = value;
    setExportFromSku(value);
    invalidate();
  };

  const updateExportToSku = (value) => {
    if (!current()) return;
    requested.current.toSku = value;
    setExportToSku(value);
    invalidate();
  };

  const fetchExportStatus = useCallback(() => !current() ? Promise.resolve(null) : Promise.all([
    exportsApi.getStatus(),
    exportsApi.getPriceStatus(),
  ]).then(([productResponse, priceResponse]) => {
    if (!current()) return null;
    setExportStatus(productResponse.data);
    setPriceExportStatus(priceResponse.data);
    return productResponse.data;
  }), [current]);

  useEffect(() => {
    alive.current = true;
    if (enabled) fetchExportStatus().catch((error) => { if (current()) setExportError(getApiError(error)); });
    return () => { alive.current = false; };
  }, [enabled, fetchExportStatus, current]);

  useEffect(() => {
    if (!pendingCreate) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingCreate]);

  const getRangePayload = () => {
    const fromSku = requested.current.fromSku.trim().toUpperCase();
    const toSku = requested.current.toSku.trim().toUpperCase();
    if (!fromSku) {
      throw new Error('Вкажіть артикул, з якого починати експорт.');
    }
    return { fromSku, toSku: toSku || fromSku };
  };

  const handlePreviewExport = async (mode = 'new') => {
    if (!current() || pending.current || busy.current) return;
    const ticket = ++generation.current;
    busy.current = true;
    setIsExportLoading(true);
    setExportError('');
    setExportPreview(null);
    try {
      const intent = { ...(mode === 'new' ? { mode: 'new' } : getRangePayload()),
        ...(requested.current.templateMode ? { requestContract: 'template-v1', selection: { ...requested.current.selection } } : {}) };
      const response = await exportsApi.preview(intent);
      if (!current() || ticket !== generation.current) return;
      previewEvidence.current = { intent, response: response.data };
      setExportPreview(response.data);
      setExportSnapshot(null);
    } catch (error) {
      if (current() && ticket === generation.current) setExportError(getApiError(error));
    } finally {
      busy.current = false;
      if (current()) setIsExportLoading(false);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!current() || !canCreate || busy.current || exportSnapshot) return;
    if (!pending.current) {
      const evidence = previewEvidence.current;
      if (!evidence || evidence.response.errors?.length || !evidence.response.representedCount) return;
      const { intent, response } = evidence;
      if (intent.requestContract === 'template-v1' && !response.previewToken) return;
      const payload = intent.requestContract === 'template-v1'
        ? { ...intent, previewToken: response.previewToken }
        : response.mode === 'new' ? { mode: 'new', fromSku: response.range.fromSku, toSku: response.range.toSku } : intent;
      pending.current = { payload, idempotencyKey: globalThis.crypto?.randomUUID?.()
        || `export-${Date.now()}-${Math.random().toString(36).slice(2)}`, evidence: response };
      setPendingCreate(pending.current);
    }
    const operation = pending.current;
    busy.current = true;
    setIsExportLoading(true);
    setExportError('');
    try {
      const response = await exportsApi.createSnapshot(operation.payload, operation.idempotencyKey);
      if (!current()) return;
      setExportSnapshot({ ...response.data, capturedRange: operation.evidence.range });
      setExportPreview(operation.evidence);
      pending.current = null; setPendingCreate(null); previewEvidence.current = null;
    } catch (error) {
      if (!current()) return;
      const code = error.response?.data?.code;
      const definitive = ['NEW_EXPORT_RANGE_STALE', 'EXPORT_PREVIEW_STALE', 'EXPORT_PREVIEW_EXPIRED',
        'EXPORT_PREVIEW_REQUIRED', 'MAGENTO_NOT_READY'].includes(code);
      if (definitive) {
        pending.current = null; setPendingCreate(null); invalidate();
        setExportError(`${getApiError(error)} Оновіть перевірку явно перед новим створенням.`);
      } else {
        setExportError(`${getApiError(error)} Результат створення не підтверджено. Повторіть цю саму операцію; новий ключ не створюється.`);
      }
    } finally {
      busy.current = false;
      if (current()) setIsExportLoading(false);
    }
  };

  const handleDownloadMagentoArtifact = async (groupCode) => {
    if (!current() || !exportSnapshot?.id) return;
    setIsExportLoading(true);
    setExportError('');
    try {
      const response = await exportsApi.downloadMagentoArtifact(exportSnapshot.id, groupCode);
      if (!current()) return;
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      const manifest = exportSnapshot.artifacts?.find((item) => item.groupCode === groupCode);
      downloadBlob(blob, fileNameMatch?.[1] || manifest?.fileName || `magento-${groupCode}.csv`, {
        documentRef: document, urlApi: window.URL,
      });
    } catch (error) {
      if (!current()) return;
      if (error.response?.data instanceof Blob) {
        const errorText = await error.response.data.text();
        if (!current()) return;
        try {
          const parsed = JSON.parse(errorText);
          setExportError(parsed.error || 'Не вдалося виконати експорт.');
        } catch {
          setExportError('Не вдалося виконати експорт.');
        }
      } else {
        setExportError(getApiError(error));
      }
    } finally {
      if (current()) setIsExportLoading(false);
    }
  };

  const handlePriceExportCsv = async () => {
    if (!current() || !canCreate) return;
    setIsPriceExportLoading(true);
    setPriceExportError('');
    try {
      const key = globalThis.crypto?.randomUUID?.()
        || `price-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotResponse = await exportsApi.createPriceSnapshot(key);
      if (!current()) return;
      const snapshot = snapshotResponse.data;
      const response = await exportsApi.downloadPriceSnapshot(snapshot.id);
      if (!current()) return;
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      downloadBlob(
        blob,
        fileNameMatch?.[1] || snapshot.fileName || 'amber-price-export.csv',
        { documentRef: document, urlApi: window.URL }
      );
      await exportsApi.confirmPriceSnapshot(snapshot.id);
      if (!current()) return;
      await fetchExportStatus();
    } catch (error) {
      if (!current()) return;
      if (error.response?.data instanceof Blob) {
        const errorText = await error.response.data.text();
        if (!current()) return;
        try {
          setPriceExportError(JSON.parse(errorText).error || 'Не вдалося експортувати ціни.');
        } catch {
          setPriceExportError('Не вдалося експортувати ціни.');
        }
      } else {
        setPriceExportError(getApiError(error));
      }
    } finally {
      if (current()) setIsPriceExportLoading(false);
    }
  };

  const handleConfirmSnapshot = async () => {
    if (!current() || !canCreate || busy.current || !exportSnapshot?.id || exportSnapshot.status === 'confirmed') return;
    const snapshotId = exportSnapshot.id;
    busy.current = true;
    setIsExportLoading(true);
    setExportError('');
    try {
      await exportsApi.confirmSnapshot(snapshotId);
      if (!current()) return;
      setExportSnapshot((previous) => previous?.id === snapshotId ? { ...previous, status: 'confirmed' } : previous);
      await fetchExportStatus();
    } catch (error) {
      if (current()) setExportError(getApiError(error));
    } finally {
      busy.current = false;
      if (current()) setIsExportLoading(false);
    }
  };

  return {
    templateMode,
    setTemplateMode: updateTemplateMode,
    templateSelection,
    setTemplateSelection: updateTemplateSelection,
    pendingCreate,
    exportError,
    exportFromSku,
    exportPreview,
    exportSnapshot,
    exportStatus,
    exportToSku,
    fetchExportStatus,
    handlePreviewExport,
    handleCreateSnapshot,
    handleDownloadMagentoArtifact,
    handleConfirmSnapshot,
    handlePriceExportCsv,
    isExportLoading,
    isPriceExportLoading,
    priceExportError,
    priceExportStatus,
    setExportError,
    setExportFromSku: updateExportFromSku,
    setExportToSku: updateExportToSku,
    setPriceExportError,
  };
}
