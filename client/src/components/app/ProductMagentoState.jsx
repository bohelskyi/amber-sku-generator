import { useContext, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { MagentoSyncStatus } from './MagentoSyncStatus.jsx';
import { ProductNameConflict } from './ProductNameConflict.jsx';

export function ProductMagentoState({ product, onSaved }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const [current, setCurrent] = useState(null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const canRead = permissions.includes('products.view') && product.productId;
  const waiting = ['pending', 'syncing'].includes(current?.state);
  useEffect(() => {
    if (!canRead || principalLifetime?.valid === false) return undefined;
    let live = true; const controller = new AbortController();
    api.get(`/magento/product-status/${product.productId}`, { signal: controller.signal })
      .then(({ data }) => { if (live && principalLifetime?.valid !== false) { setCurrent(data); setError(''); } })
      .catch(() => { if (live) setError('Стан тимчасово недоступний'); });
    return () => { live = false; controller.abort(); };
  }, [canRead, product.productId, product, refresh, principalLifetime]);
  useEffect(() => {
    if (!canRead) return undefined;
    const update = () => { if (!document.hidden) setRefresh((value) => value + 1); };
    const timer = window.setInterval(update, waiting ? 5000 : 15000); window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [canRead, waiting]);
  if (!canRead) return null;
  return <div className="product-sync-state px-4 py-2" aria-live="polite">
    <MagentoSyncStatus status={current} />
    {current?.state === 'needs_attention' && <Link className="text-xs underline" to="/sync-problems">Переглянути проблему</Link>}
    {current?.nameConflict && <ProductNameConflict productId={product.productId} onSaved={() => { setRefresh((value) => value + 1); onSaved?.(); }} />}
    <button className="sync-refresh" type="button" aria-label="Оновити стан Magento" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
    {error && <span className="text-xs text-slate-500">{error}</span>}
  </div>;
}
