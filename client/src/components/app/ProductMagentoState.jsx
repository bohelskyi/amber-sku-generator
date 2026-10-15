import { useContext, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { MagentoSyncStatus } from './MagentoSyncStatus.jsx';
import { ProductMagentoNameReview } from './ProductMagentoNameReview.jsx';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';
import { attentionProblemGroups, problemTitle } from '../attention/sync-problem-presentation.js';

export function ProductMagentoState({ product, onSaved }) {
  const { permissions = [], principalLifetime } = useContext(AuthContext) || {};
  const productId = product.productId;
  const [readState, setReadState] = useState({ productId: null, principalLifetime: null, current: null, error: '' });
  const [refresh, setRefresh] = useState(0);
  const [reviewOwner, setReviewOwner] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
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
  const mainProblem = attentionProblemGroups(current?.problems || [])[0]?.problem;
  const inheritedReview = product.status === 'active' && product.categoryCode === 'SV'
    && product.magentoNameReviewRequired === true && !mainProblem && !current?.nameConflict;
  const canReviewNames = inheritedReview && permissions.includes('exports.create');
  const reviewOpen = reviewOwner?.productId === productId && reviewOwner?.principalLifetime === principalLifetime
    && product.status === 'active' && permissions.includes('exports.create');
  const needsAttention = current?.state === 'needs_attention';
  const reason = inheritedReview ? 'Успадковані назви потребують підтвердження.' : needsAttention ? mainProblem ? problemTitle(mainProblem)
    : current.reason || (current.nameConflict ? 'Потрібно узгодити назву товару.' : 'Причину ще не визначено. Перегляньте стан товару.') : null;
  return <div className="product-sync-state px-4 py-2" aria-live="polite">
    <div className="product-sync-summary">
      {inheritedReview ? <p className="text-sm font-semibold text-amber-900">Потрібна перевірка назв</p>
        : current && <MagentoSyncStatus status={{ ...current, reason: null }} />}
      {reason && <p className="text-sm text-amber-900">{reason}</p>}
      {!current && <p className="text-sm text-slate-600">{error || 'Читаємо стан Magento…'}</p>}
    </div>
    {inheritedReview ? canReviewNames
      ? <button type="button" className="btn btn-outline btn-compact" onClick={() => setReviewOwner({ productId, principalLifetime })}>Перевірити назви</button>
      : <p className="text-sm">Передайте перевірку назв оператору з дозволом на їх зміну.</p>
      : needsAttention && <Link className="btn btn-outline btn-compact" to={`/attention?problem=${encodeURIComponent(productId)}`}>Переглянути проблему</Link>}
    <button className="sync-refresh" type="button" aria-label="Оновити стан Magento" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
    {reviewOpen && <WorkspaceDialog title="Перевірка назв для Magento" onClose={() => setReviewOwner(null)} busy={reviewBusy}>
      <ProductMagentoNameReview product={product} onBusyChange={setReviewBusy} onClose={() => setReviewOwner(null)}
        onSaved={() => { setReviewOwner(null); setRefresh((value) => value + 1); onSaved?.(); }} />
    </WorkspaceDialog>}
  </div>;
}
