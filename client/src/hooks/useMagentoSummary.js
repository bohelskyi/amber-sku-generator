import { useCallback, useContext, useEffect, useState } from 'react';
import { AuthContext } from '../auth/auth-context.js';
import { api } from '../lib/api.js';

export function useMagentoSummary({ enabled = true, pollInterval = 0 } = {}) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const allowed = enabled && permissions.includes('products.view');
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!allowed || principalLifetime?.valid === false) {
      setSummary(null); setError(false); setLoading(false); return undefined;
    }
    let live = true; let reading = false; const controller = new AbortController();
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true; setLoading(true);
      try {
        const response = await api.get('/magento/summary', { signal: controller.signal });
        if (live && principalLifetime?.valid !== false) { setSummary(response.data); setError(false); }
      } catch {
        if (live && !controller.signal.aborted) { setSummary(null); setError(true); }
      } finally {
        reading = false; if (live) setLoading(false);
      }
    };
    void read();
    const timer = pollInterval > 0 ? window.setInterval(read, pollInterval) : null;
    return () => { live = false; controller.abort(); if (timer) window.clearInterval(timer); };
  }, [allowed, pollInterval, principalLifetime, revision]);

  return { summary: allowed ? summary : null, error: allowed && error, loading: allowed && loading, refresh };
}
