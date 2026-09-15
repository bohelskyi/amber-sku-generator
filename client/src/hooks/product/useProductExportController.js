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
  const [priceExportStatus, setPriceExportStatus] = useState(null);
  const [priceExportError, setPriceExportError] = useState('');
  const [isPriceExportLoading, setIsPriceExportLoading] = useState(false);

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

  const handleExportCsv = async () => {
    const fromSku = exportFromSku.trim().toUpperCase();
    const toSku = exportToSku.trim().toUpperCase();

    if (!fromSku) {
      setExportError('Вкажіть артикул, з якого починати експорт.');
      return;
    }

    setIsExportLoading(true);
    setExportError('');

    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.()
        || `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const snapshotResponse = await exportsApi.createSnapshot({
        fromSku,
        ...(toSku ? { toSku } : {}),
      }, idempotencyKey);
      const snapshot = snapshotResponse.data;
      const response = await exportsApi.downloadSnapshot(snapshot.id);
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const fileNameMatch = response.headers['content-disposition']?.match(/filename="(.+)"/);
      const fileName = fileNameMatch?.[1] || snapshot.fileName || `amber-export-${fromSku}.csv`;

      downloadBlob(blob, fileName, { documentRef: document, urlApi: window.URL });
      await exportsApi.confirmSnapshot(snapshot.id);
      fetchExportStatus();
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

  return {
    exportError,
    exportFromSku,
    exportStatus,
    exportToSku,
    fetchExportStatus,
    handleExportCsv,
    handlePriceExportCsv,
    isExportLoading,
    isPriceExportLoading,
    priceExportError,
    priceExportStatus,
    setExportError,
    setExportFromSku,
    setExportToSku,
    setPriceExportError,
  };
}
