import { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../auth/auth-context.js';
import { api } from '../lib/api.js';

export function useMagentoSummary() {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [summary, setSummary] = useState(null);
  const allowed = permissions.includes('products.view');
  useEffect(() => {
    if (!allowed || principalLifetime?.valid === false) return undefined;
    let live = true; const controller = new AbortController();
    const read = () => { if (!document.hidden) api.get('/magento/summary', { signal: controller.signal })
      .then(({ data }) => { if (live && principalLifetime?.valid !== false) setSummary(data); })
      .catch(() => { if (live) setSummary(null); }); };
    read(); const timer = window.setInterval(read, 15000);
    window.addEventListener('focus', read);
    return () => { live = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', read); };
  }, [allowed, principalLifetime]);
  return { summary: allowed ? summary : null };
}
