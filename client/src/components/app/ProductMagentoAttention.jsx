import { useContext, useState } from 'react';
import { AuthContext } from '../../auth/auth-context.js';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';
import { ProductMagentoNameReview } from './ProductMagentoNameReview.jsx';
import { Notice } from './UiPrimitives.jsx';

export function ProductMagentoAttention({ product, onSaved }) {
  const { permissions = [] } = useContext(AuthContext) || {};
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!product?.magentoNameReviewRequired || product.status !== 'active' || product.categoryCode !== 'SV') return null;
  return <>
    <Notice tone="warning"><p className="font-semibold">Потрібно перевірити назву для Magento</p>
      <p>Успадковані назви потребують підтвердження. Після перевірки сервер повторно оцінить готовність товару до синхронізації.</p>
      {permissions.includes('exports.create')
        ? <button type="button" className="btn btn-primary mt-2" onClick={() => setOpen(true)}>Перевірити назви</button>
        : <p>Зверніться до користувача з дозволом на перевірку назв для Magento.</p>}
    </Notice>
    {open && <WorkspaceDialog title="Перевірка назв для Magento" onClose={() => setOpen(false)} busy={busy}>
      <ProductMagentoNameReview product={product} onBusyChange={setBusy} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved?.(); }} />
    </WorkspaceDialog>}
  </>;
}
