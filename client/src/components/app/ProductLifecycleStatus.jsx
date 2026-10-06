import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Notice } from '../ui';

const reasons = {
  PRODUCT_REMOTE_IDENTITY_CHANGED: 'Зв’язок із товаром Magento змінився.',
  PRODUCT_REMOTE_IDENTITY_MISSING: 'Немає підтвердженого зв’язку з товаром Magento.',
  PRODUCT_SYNC_RECONCILIATION_REQUIRED: 'Спочатку потрібно перевірити незавершену доставку.',
  PRODUCT_VISIBILITY_PHOTOS_REQUIRED: 'Для показу потрібна підтверджена перевірка фотографій.',
  PHOTO_ACTIVATION_PROOF_REQUIRED: 'Для показу потрібні підтверджені фотографії.',
};

export function ProductLifecycleStatus({ productId }) {
  const auth = useAuth();
  const allowed = auth.permissions.includes('products.view');
  const owner = auth.principalLifetime;
  const principal = useRef(owner);
  useEffect(() => { principal.current = owner; }, [owner]);
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!allowed || !productId || owner?.valid === false) return undefined;
    const controller = new AbortController();
    let timer;
    const current = () => !controller.signal.aborted && principal.current === owner && owner?.valid !== false;
    async function read() {
      let repeat = false;
      try {
        const result = await api.get(`/products/${productId}/lifecycle`, { signal: controller.signal });
        if (!current()) return;
        if (Number(result.data?.productId) !== Number(productId)) throw new Error('Unexpected product receipt');
        setRecord({ owner, productId, data: result.data });
        setError('');
        repeat = ['queued', 'dispatched'].includes(result.data.visibility?.state);
      } catch {
        if (!current()) return;
        setError('Не вдалося оновити стан Magento. Попереднє підтвердження, якщо воно є, наведено нижче.');
        repeat = true;
      } finally {
        if (current() && repeat) timer = window.setTimeout(read, 5000);
      }
    }
    void read();
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [allowed, productId, owner, refresh]);
  if (!allowed) return null;
  const data = record?.owner === owner && record?.productId === productId ? record.data : null;
  const visibility = data?.visibility;
  const verifiedTime = visibility?.state === 'verified' ? visibility.hiddenAt || visibility.visibilityRestoredAt : null;
  return <section className="space-y-2 text-sm" aria-label="Підтвердження видимості Magento">
    {error && <Notice tone="warning">{error}</Notice>}
    {!data && !error && <p>Читаємо стан видимості Magento…</p>}
    {data && <>
      {visibility?.state === 'verified' && visibility.hiddenAt ? <p>Приховування в Magento підтверджено.</p>
        : visibility?.state === 'verified' && visibility.visibilityRestoredAt ? <p>Повернення попередньої видимості в Magento підтверджено.</p>
          : ['queued', 'dispatched'].includes(visibility?.state) ? <p>Видимість у Magento ще не підтверджена. Очікуємо перевірки результату.</p>
            : visibility?.state === 'blocked' ? <p>Видимість у Magento не підтверджена. {reasons[visibility.reasonCode] || 'Потрібна окрема перевірка доставки або зв’язку з товаром.'}</p>
              : <p>Підтвердження видимості Magento для цього архівування немає.</p>}
      {verifiedTime && Number.isFinite(Date.parse(verifiedTime)) && <p>Підтверджено: <time dateTime={verifiedTime}>{new Date(verifiedTime).toLocaleString('uk-UA')}</time></p>}
    </>}
    {error && <button type="button" className="btn btn-outline btn-compact-md" onClick={() => setRefresh(value => value + 1)}>Оновити стан</button>}
  </section>;
}
