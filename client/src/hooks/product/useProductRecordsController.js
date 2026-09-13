import { useEffect, useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';

export function useProductRecordsController({ onArchived }) {
  const [history, setHistory] = useState([]);
  const [skuToDelete, setSkuToDelete] = useState('');

  const fetchHistory = () => productsApi.getRecent().then((response) => {
    setHistory(response.data);
    return response.data;
  });

  useEffect(() => {
    fetchHistory();
  }, []);

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
    setSkuToDelete,
    skuToDelete,
  };
}
