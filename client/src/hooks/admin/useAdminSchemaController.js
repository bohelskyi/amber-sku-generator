import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { getApiError } from '../../lib/http-error';

const idlePublishState = { loading: false, error: '', categoryCode: null, categoryName: '' };

export function useAdminSchemaController({ canPublishSchema, canViewCatalog, config, fetchConfig, onFeedback, selectedCat }) {
  const [schemaStatus, setSchemaStatus] = useState(null);
  const [schemaStatusError, setSchemaStatusError] = useState('');
  const [schemaPublishState, setSchemaPublishState] = useState(idlePublishState);
  const selectionEpoch = useRef(0);
  const activeCategoryCode = useRef(selectedCat?.code || null);
  const statusRequestId = useRef(0);

  const fetchSchemaStatus = (categoryCode, epoch = selectionEpoch.current) => {
    if (!categoryCode) return Promise.resolve(null);
    const requestId = ++statusRequestId.current;
    return api.get(`/admin/sku-schema/${categoryCode}`).then((response) => {
      if (requestId === statusRequestId.current
        && epoch === selectionEpoch.current
        && activeCategoryCode.current === categoryCode) {
        setSchemaStatus(response.data);
        setSchemaStatusError('');
      }
      return response.data;
    }).catch((error) => {
      if (requestId === statusRequestId.current
        && epoch === selectionEpoch.current
        && activeCategoryCode.current === categoryCode) setSchemaStatusError(getApiError(error));
      throw error;
    });
  };

  const selectCategory = (category) => {
    selectionEpoch.current += 1;
    activeCategoryCode.current = category?.code || null;
    statusRequestId.current += 1;
    setSchemaStatus(null);
    setSchemaStatusError('');
  };

  useEffect(() => {
    if (!canViewCatalog || !selectedCat?.code || !config) return undefined;
    fetchSchemaStatus(selectedCat.code, selectionEpoch.current).catch(() => {});
    return undefined;
    // Config changes intentionally revalidate the current schema projection.
  }, [canViewCatalog, config, selectedCat?.code]);

  const publishSkuSchema = () => {
    const categoryCode = selectedCat?.code;
    const categoryName = selectedCat?.name || categoryCode;
    const operationEpoch = selectionEpoch.current;
    if (!canPublishSchema || !categoryCode || !schemaStatus?.draftChanged || schemaPublishState.loading) return;
    setSchemaPublishState({ loading: true, error: '', categoryCode, categoryName });
    api.post(`/admin/sku-schema/${categoryCode}/publish`)
      .then(async () => {
        onFeedback?.({ tone: 'success', title: `Схему SKU для «${categoryName}» опубліковано` });
        const refreshes = await Promise.allSettled([
          fetchConfig(),
          fetchSchemaStatus(categoryCode, operationEpoch),
        ]);
        if (refreshes.some((result) => result.status === 'rejected')) {
          onFeedback?.({
            tone: 'warning',
            title: 'Схему SKU опубліковано, але дані не оновлено',
            message: 'Оновіть сторінку перед наступною зміною.',
          });
        }
      })
      .catch((error) => {
        const message = getApiError(error);
        setSchemaPublishState({ loading: false, error: message, categoryCode, categoryName });
        onFeedback?.({ tone: 'error', title: `Не вдалося опублікувати схему SKU для «${categoryName}»`, message });
      })
      .finally(() => {
        setSchemaPublishState((state) => state.categoryCode === categoryCode ? { ...state, loading: false } : state);
      });
  };

  const visiblePublishState = schemaPublishState.categoryCode === selectedCat?.code
    ? schemaPublishState
    : schemaPublishState.loading
      ? { ...schemaPublishState, otherCategory: true }
      : idlePublishState;

  return {
    fetchSchemaStatus,
    publishSkuSchema,
    retrySchemaStatus: () => fetchSchemaStatus(selectedCat?.code, selectionEpoch.current).catch(() => {}),
    schemaPublishState: visiblePublishState,
    schemaStatus,
    schemaStatusError,
    selectSchemaCategory: selectCategory,
  };
}
