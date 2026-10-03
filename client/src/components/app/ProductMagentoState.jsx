import { useContext, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { MagentoSyncStatus } from './MagentoSyncStatus.jsx';
import { ProductMagentoAttention } from './ProductMagentoAttention.jsx';
import { ProductNameConflict } from './ProductNameConflict.jsx';
import { LifecycleReconciliationNotice } from './LifecycleReconciliationNotice.jsx';

export function ProductMagentoState({ product, onRepairCharacteristics, onSaved }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const productId = product.productId;
  const [readState, setReadState] = useState({ productId: null, principalLifetime: null, current: null, error: '' });
  const [refresh, setRefresh] = useState(0);
  const readGeneration = useRef(0);
  const canRead = permissions.includes('products.view') && productId && principalLifetime?.valid !== false;
  const isCurrentRead = canRead
    && readState.productId === productId
    && readState.principalLifetime === principalLifetime;
  const current = isCurrentRead && !readState.error ? readState.current : null;
  const error = isCurrentRead ? readState.error : '';
  const waiting = ['pending', 'syncing'].includes(current?.state);
  useEffect(() => {
    if (!canRead) return undefined;
    const generation = readGeneration.current + 1;
    readGeneration.current = generation;
    let live = true; const controller = new AbortController();
    api.get(`/magento/product-status/${productId}`, { signal: controller.signal })
      .then(({ data }) => {
        if (live && readGeneration.current === generation && principalLifetime?.valid !== false) {
          setReadState({ productId, principalLifetime, current: data, error: '' });
        }
      })
      .catch((requestError) => {
        if (live && readGeneration.current === generation && requestError?.name !== 'CanceledError') {
          setReadState({
            productId,
            principalLifetime,
            current: null,
            error: 'Стан тимчасово недоступний',
          });
        }
      });
    return () => { live = false; controller.abort(); };
  }, [canRead, productId, refresh, principalLifetime]);
  useEffect(() => {
    if (!canRead) return undefined;
    const update = () => { if (!document.hidden) setRefresh((value) => value + 1); };
    const timer = window.setInterval(update, waiting ? 5000 : 15000); window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [canRead, waiting]);
  if (!canRead) return null;
  const hasReadinessProblem = current?.problems?.some((problem) => problem.code === 'PRODUCT_EVALUATION_NOT_READY');
  const lifecycleProblem = current?.problems?.find((problem) => problem.resolution === 'lifecycle_reconciliation');
  return <div className="product-sync-state px-4 py-2" aria-live="polite">
    <MagentoSyncStatus status={hasReadinessProblem || lifecycleProblem ? { ...current, reason: null } : current} />
    {current?.state === 'needs_attention' && <Link className="text-xs underline" to="/sync-problems">Переглянути проблему</Link>}
    {lifecycleProblem && <section className="mt-2"><h3 className="font-semibold">{lifecycleProblem.message}</h3>
      <LifecycleReconciliationNotice problem={lifecycleProblem} article={product.publicSku} /></section>}
    <ProductMagentoAttention key={`readiness-${productId}`} product={{ ...product, nameConflict: Boolean(current?.nameConflict) }} problems={current?.problems || []}
      onRepairCharacteristics={onRepairCharacteristics}
      onSaved={() => { setRefresh((value) => value + 1); onSaved?.(); }} />
    <ProductNameConflict key={productId} productId={productId} available={Boolean(current?.nameConflict)} onSaved={() => { setRefresh((value) => value + 1); onSaved?.(); }} />
    <button className="sync-refresh" type="button" aria-label="Оновити стан Magento" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
    {error && <span className="text-xs text-slate-500">{error}</span>}
  </div>;
}
