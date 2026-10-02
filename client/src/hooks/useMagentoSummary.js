import { useCallback, useContext, useEffect, useState } from 'react';
import { AuthContext } from '../auth/auth-context.js';
import { api } from '../lib/api.js';

export function useMagentoSummary({ enabled = true, pollInterval = 0 } = {}) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [result, setResult] = useState({ owner: null, summary: null, error: false, loading: false });
  const [revision, setRevision] = useState(0);
  const allowed = enabled && permissions.includes('products.view');
  const active = allowed && principalLifetime?.valid !== false;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    let live = true; let reading = false; const controller = new AbortController();
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      setResult((current) => current.owner === principalLifetime
        ? { ...current, loading: true }
        : { owner: principalLifetime, summary: null, error: false, loading: true });
      try {
        const response = await api.get('/magento/summary', { signal: controller.signal });
        if (live && principalLifetime?.valid !== false) {
          setResult({ owner: principalLifetime, summary: response.data, error: false, loading: false });
        }
      } catch {
        if (live && !controller.signal.aborted) {
          setResult({ owner: principalLifetime, summary: null, error: true, loading: false });
        }
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = pollInterval > 0 ? window.setInterval(read, pollInterval) : null;
    return () => { live = false; controller.abort(); if (timer) window.clearInterval(timer); };
  }, [active, pollInterval, principalLifetime, revision]);

  const visible = active && result.owner === principalLifetime;
  return {
    summary: visible ? result.summary : null,
    error: visible && result.error,
    loading: visible && result.loading,
    refresh,
  };
}
