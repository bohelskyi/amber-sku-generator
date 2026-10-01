import { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';

export function useProductRecordsController({ onArchived, canViewHistory = true }) {
  const [history, setHistory] = useState([]);
  const [skuToDelete, setSkuToDelete] = useState('');
  const [historyError, setHistoryError] = useState('');

  const fetchHistory = useCallback(() => !canViewHistory ? Promise.resolve([]) : productsApi.getRecent().then((response) => {
    setHistory(response.data);
    setHistoryError('');
    return response.data;
  }).catch((error) => { setHistoryError(getApiError(error)); return []; }), [canViewHistory]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleDelete = (sku) => {
    if (!sku) return;
    if (!window.confirm(`Перенести ${sku} в архів?`)) return;

    productsApi.archive(sku)
      .then((response) => {
        alert(response.data.message);
        setSkuToDelete('');
        fetchHistory();
        onArchived();
      })
      .catch((error) => {
        alert(`ПОМИЛКА: ${getApiError(error)}`);
      });
  };

  return {
    fetchHistory,
    handleDelete,
    history,
    historyError,
    setSkuToDelete,
    skuToDelete,
  };
}
