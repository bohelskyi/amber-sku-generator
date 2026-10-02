import { useCallback, useEffect, useRef, useState } from 'react';
import { productsApi } from '../../api/products-api';
import { getApiError } from '../../lib/http-error';

const initialFilters = Object.freeze({ search: '', category: '', lifecycle: 'current' });

export function useProductRegister({ enabled = true, initialFilters: requestedInitialFilters, initialPage, refreshKey = 0 } = {}) {
  const [filters, setFilters] = useState(() => ({
    ...initialFilters,
    ...(requestedInitialFilters || {}),
  }));
  const [items, setItems] = useState([]);
  const [filterOptions, setFilterOptions] = useState({ categories: [] });
  const [pageInfo, setPageInfo] = useState({ hasMore: false, nextCursor: null });
  const [page, setPage] = useState(() => ({ cursor: null, index: 0, back: [], ...(initialPage || {}) }));
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const read = useCallback(async () => {
    if (!enabled) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const response = await productsApi.listRegister({
        ...filters,
        limit: 50,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
      if (currentRequest !== requestId.current) return;
      const data = response.data || {};
      setItems(data.items || []);
      setPageInfo(data.pageInfo || { hasMore: false, nextCursor: null });
      setFilterOptions(data.filterOptions || { categories: [] });
      setError('');
    } catch (requestError) {
      if (currentRequest !== requestId.current) return;
      setItems([]);
      setError(getApiError(requestError));
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
      }
    }
  }, [enabled, filters, page.cursor]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setTimeout(() => { void read(); }, 0);
    return () => { window.clearTimeout(timer); requestId.current += 1; };
  }, [enabled, read, refreshKey]);

  const updateFilters = useCallback((updater) => {
    setFilters((current) => typeof updater === 'function' ? updater(current) : updater);
    setPage({ cursor: null, index: 0, back: [] });
  }, []);

  return {
    error,
    filterOptions,
    filters,
    items,
    loading,
    backCursors: page.back,
    currentCursor: page.cursor,
    pageIndex: page.index,
    pageInfo,
    refresh: read,
    setFilters: updateFilters,
  };
}
