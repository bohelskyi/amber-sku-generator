import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { getApiError } from '../../lib/http-error';

export function useAdminSchemaController({ canViewCatalog, config, fetchConfig, selectedCat }) {
  const [schemaStatus, setSchemaStatus] = useState(null);
  const [schemaPublishState, setSchemaPublishState] = useState({ loading: false, error: '' });

  const fetchSchemaStatus = (categoryCode) => {
    if (!categoryCode) {
      setSchemaStatus(null);
      return Promise.resolve(null);
    }
    return api.get(`/admin/sku-schema/${categoryCode}`).then((response) => {
      setSchemaStatus(response.data);
      return response.data;
    });
  };

  useEffect(() => {
    if (!canViewCatalog || !selectedCat?.code || !config) return undefined;
    let cancelled = false;
    api.get(`/admin/sku-schema/${selectedCat.code}`).then((response) => {
      if (!cancelled) setSchemaStatus(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [canViewCatalog, config, selectedCat?.code]);

  const publishSkuSchema = () => {
    if (!selectedCat || !schemaStatus?.draftChanged || schemaPublishState.loading) return;
    setSchemaPublishState({ loading: true, error: '' });
    api.post(`/admin/sku-schema/${selectedCat.code}/publish`)
      .then(() => Promise.all([fetchConfig(), fetchSchemaStatus(selectedCat.code)]))
      .catch((error) => {
        setSchemaPublishState({ loading: false, error: getApiError(error) });
      })
      .finally(() => {
        setSchemaPublishState((state) => ({ ...state, loading: false }));
      });
  };

  const resetSchemaPublishState = () => {
    setSchemaPublishState({ loading: false, error: '' });
  };

  return {
    publishSkuSchema,
    resetSchemaPublishState,
    schemaPublishState,
    schemaStatus,
  };
}
