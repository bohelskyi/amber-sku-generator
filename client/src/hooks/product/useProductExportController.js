import { useEffect, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { downloadBlob } from '../../lib/download';
import { getApiError } from '../../lib/http-error';

export function useProductExportController() {
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

  const updateExportFromSku = (value) => {
    setExportFromSku(value);
    setExportPreview((previous) => previous?.mode === 'manual' ? null : previous);
  };

  const updateExportToSku = (value) => {
    setExportToSku(value);
    setExportPreview((previous) => previous?.mode === 'manual' ? null : previous);
  };

  const fetchExportStatus = () => Promise.all([
    exportsApi.getStatus(),
    exportsApi.getPriceStatus(),
  ]).then(([productResponse, priceResponse]) => {
    setExportStatus(productResponse.data);
    setPriceExportStatus(priceResponse.data);
    return productResponse.data;
  });

  useEffect(() => {
    fetchExportStatus();
  }, []);

  const getRangePayload = () => {
    const fromSku = exportFromSku.trim().toUpperCase();
    const toSku = exportToSku.trim().toUpperCase();
    if (!fromSku) {
      throw new Error('Вкажіть артикул, з якого починати експорт.');
    }
    return { fromSku, toSku: toSku || fromSku };
  };

  const handlePreviewExport = async (mode = 'new') => {
    setIsExportLoading(true);
    setExportError('');
    setExportPreview(null);
    try {
      const response = await exportsApi.preview(
        mode === 'new' ? { mode: 'new' } : getRangePayload()
      );
      setExportPreview(response.data);
      setExportSnapshot(null);
    } catch (error) {
      setExportError(getApiError(error));
    } finally {
      setIsExportLoading(false);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!exportPreview || exportPreview.errors?.length || !exportPreview.representedCount) return;
    setIsExportLoading(true);
    setExportError('');
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.()
        || `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = exportPreview.mode === 'new'
        ? { mode: 'new', fromSku: exportPreview.range.fromSku,
          toSku: exportPreview.range.toSku }
        : getRangePayload();
      const response = await exportsApi.createSnapshot(payload, idempotencyKey);
      setExportSnapshot(response.data);
    } catch (error) {
      if (error.response?.data?.code === 'NEW_EXPORT_RANGE_STALE') {
        setExportPreview(null);
        await fetchExportStatus().catch(() => {});
      }
      if (error.response?.data?.errors) {
        setExportPreview((previous) => ({
          ...(previous || {}),
          errors: error.response.data.errors,
          readyCount: Math.max(0,
            Number(previous?.representedCount || 0) - error.response.data.errors.length),
        }));
      }
      setExportError(getApiError(error));
    } finally {
      setIsExportLoading(false);
    }
  };

  const handleDownloadMagentoArtifact = async (groupCode) => {
    if (!exportSnapshot?.id) return;
    setIsExportLoading(true);
    setExportError('');
    try {
      const response = await exportsApi.downloadMagentoArtifact(exportSnapshot.id, groupCode);
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      const manifest = exportSnapshot.artifacts?.find((item) => item.groupCode === groupCode);
      downloadBlob(blob, fileNameMatch?.[1] || manifest?.fileName || `magento-${groupCode}.csv`, {
        documentRef: document, urlApi: window.URL,
      });
    } catch (error) {
      if (error.response?.data instanceof Blob) {
        const errorText = await error.response.data.text();
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
      setIsExportLoading(false);
    }
  };

  const handlePriceExportCsv = async () => {
    setIsPriceExportLoading(true);
    setPriceExportError('');
    try {
      const key = globalThis.crypto?.randomUUID?.()
        || `price-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotResponse = await exportsApi.createPriceSnapshot(key);
      const snapshot = snapshotResponse.data;
      const response = await exportsApi.downloadPriceSnapshot(snapshot.id);
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      downloadBlob(
        blob,
        fileNameMatch?.[1] || snapshot.fileName || 'amber-price-export.csv',
        { documentRef: document, urlApi: window.URL }
      );
      await exportsApi.confirmPriceSnapshot(snapshot.id);
      await fetchExportStatus();
    } catch (error) {
      if (error.response?.data instanceof Blob) {
        const errorText = await error.response.data.text();
        try {
          setPriceExportError(JSON.parse(errorText).error || 'Не вдалося експортувати ціни.');
        } catch {
          setPriceExportError('Не вдалося експортувати ціни.');
        }
      } else {
        setPriceExportError(getApiError(error));
      }
    } finally {
      setIsPriceExportLoading(false);
    }
  };

  const handleConfirmSnapshot = async () => {
    if (!exportSnapshot?.id || exportSnapshot.status === 'confirmed') return;
    setIsExportLoading(true);
    setExportError('');
    try {
      await exportsApi.confirmSnapshot(exportSnapshot.id);
      setExportSnapshot((previous) => ({ ...previous, status: 'confirmed' }));
      await fetchExportStatus();
    } catch (error) {
      setExportError(getApiError(error));
    } finally {
      setIsExportLoading(false);
    }
  };

  return {
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
