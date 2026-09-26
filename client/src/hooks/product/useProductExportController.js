import { useCallback, useEffect, useRef, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { downloadBlob } from '../../lib/download';
import { getApiError } from '../../lib/http-error';
import { subscribeExportReviewChanged } from '../../lib/export-review-events';
import { createExportViewMemory } from '../../lib/export-view-memory';
import { usePriceExportController } from './usePriceExportController';

export function useProductExportController({ enabled = true, canCreate = true, principalLifetime } = {}) {
  const [exportStatus, setExportStatus] = useState(null);
  const [exportFromSku, setExportFromSku] = useState('');
  const [exportToSku, setExportToSku] = useState('');
  const [exportError, setExportError] = useState('');
  const [isExportLoading, setIsExportLoading] = useState(false);
  const [exportPreview, setExportPreview] = useState(null);
  const [exportSnapshot, setExportSnapshot] = useState(null);
  const [exportReviewStale, setExportReviewStale] = useState(false);
  const [exportProductChanged, setExportProductChanged] = useState(false);
  const [exportDisplayMemory] = useState(() => new Map());
  const [exportReviewView] = useState(createExportViewMemory);
  const [priceExportStatus, setPriceExportStatus] = useState(null);
  const [priceExportError, setPriceExportError] = useState('');
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
  const markExportReviewStale = useCallback((event) => { if (current()) { generation.current++; setExportReviewStale(true); if (event?.kind === 'product') setExportProductChanged(true); } }, [current]);
  useEffect(() => subscribeExportReviewChanged((event) => {
    if (!current()) return;
    markExportReviewStale();
    if (event?.kind === 'product') {
      setExportProductChanged(true);
      for (const view of exportDisplayMemory.values()) view.update({ productChanged: true });
    }
  }), [markExportReviewStale, current, exportDisplayMemory]);
  useEffect(() => {
    let live = true;
    const checkIdentity = async () => {
      const evidence = previewEvidence.current; const ticket = generation.current;
      if (!current() || !evidence || pending.current || busy.current || exportSnapshot) return;
      try {
        const response = await exportsApi.preview(evidence.intent);
        if (live && current() && ticket === generation.current && response.data.tableFingerprint !== evidence.response.tableFingerprint) markExportReviewStale();
      } catch { if (live && current() && ticket === generation.current) markExportReviewStale(); }
    };
    window.addEventListener('focus', checkIdentity);
    return () => { live = false; window.removeEventListener('focus', checkIdentity); };
  }, [current, exportSnapshot, markExportReviewStale]);

  const invalidate = () => { generation.current++; previewEvidence.current = null; exportReviewView.clear(); setExportProductChanged(false); setExportPreview(null); };
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
    setExportReviewStale(true);
    try {
      const intent = { ...(mode === 'new' ? { mode: 'new' } : getRangePayload()),
        ...(requested.current.templateMode ? { requestContract: 'template-v1', selection: { ...requested.current.selection } } : {}) };
      const response = await exportsApi.preview(intent);
      if (!current() || ticket !== generation.current) return;
      previewEvidence.current = { intent, response: response.data };
      setExportPreview(response.data);
      setExportReviewStale(false);
      setExportProductChanged(false);
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
      if (exportReviewStale) return;
      const evidence = previewEvidence.current;
      if (!evidence || evidence.response.errors?.length || !evidence.response.representedCount) return;
      const { intent, response } = evidence;
      if (intent.requestContract === 'template-v1' && !response.previewToken) return;
      const requestedPayload = intent.requestContract === 'template-v1'
        ? { ...intent, previewToken: response.previewToken }
        : response.mode === 'new' ? { mode: 'new', fromSku: response.range.fromSku, toSku: response.range.toSku } : intent;
      const payload = { ...requestedPayload, ...(intent.requestContract !== 'template-v1' && response.previewExpectation
        ? { previewExpectation: response.previewExpectation } : {}) };
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
      try {
        const stored = await exportsApi.getSnapshot(response.data.id);
        if (current() && stored.data?.id === response.data.id) setExportSnapshot({ ...stored.data, capturedRange: operation.evidence.range });
      } catch {
        if (current()) setExportError('Файли створено, але таблицю не вдалося завантажити.');
      }
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
      return true;
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
      return false;
    } finally {
      if (current()) setIsExportLoading(false);
    }
  };

  const priceWorkflow = usePriceExportController({ current, canCreate, onConfirmed: fetchExportStatus });
  const handlePriceExportCsv = priceWorkflow.create;

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
      const stored = await exportsApi.getSnapshot(snapshotId);
      if (current()) setExportSnapshot(stored.data);
      await fetchExportStatus();
    } catch (error) {
      if (current()) setExportError(getApiError(error));
    } finally {
      busy.current = false;
      if (current()) setIsExportLoading(false);
    }
  };

  return {
    exportProductChanged, exportReviewView, exportDisplayMemory,
    exportReviewStale, markExportReviewStale, priceWorkflow,
    startNewExport: () => { if (current() && !busy.current && !pending.current) { setExportSnapshot(null); invalidate(); setExportError(''); } },
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
    isPriceExportLoading: priceWorkflow.busy,
    priceExportError,
    priceExportStatus,
    setExportError,
    setExportFromSku: updateExportFromSku,
    setExportToSku: updateExportToSku,
    setPriceExportError,
  };
}
