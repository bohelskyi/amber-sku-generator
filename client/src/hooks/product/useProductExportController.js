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

  const fetchExportStatus = () => exportsApi.getStatus().then((response) => {
    setExportStatus(response.data);
    return response.data;
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

  return {
    exportError,
    exportFromSku,
    exportStatus,
    exportToSku,
    fetchExportStatus,
    handleExportCsv,
    isExportLoading,
    setExportError,
    setExportFromSku,
    setExportToSku,
  };
}
