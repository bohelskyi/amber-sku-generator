import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Notice } from '../app/UiPrimitives.jsx';

// Remote GET-only planning precedes local authoring. Creation has a separate
// exact binding preview, explicit apply and permanent dispatch receipt.
export default function MagentoCategoryPlan({ categoryCode, categories, parentPath, name, onVerified }) {
  const [proof, setProof] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const sequence = useRef(0); const flight = useRef(false); const controller = useRef(null);
  useEffect(() => () => { ++sequence.current; controller.current?.abort(); }, []);
  const parents = (categories || []).filter((node) => node.comparable && node.normalizedPath === parentPath);
  async function check() {
    if (flight.current || !categoryCode || parents.length !== 1 || !name) return;
    flight.current = true; const ticket = ++sequence.current; setBusy(true); setError(''); setProof(null); onVerified(null);
    controller.current = new AbortController();
    try {
      const command = { categoryCode, parentId: Number(parents[0].categoryId), name };
      const { data } = await api.post('/admin/magento-integration/categories/plan', command, { signal: controller.current.signal });
      if (ticket !== sequence.current) return;
      if (data.categoryCode !== categoryCode || data.parentId !== command.parentId || data.path !== `${parentPath}/${name}`
        || !['would_create', 'existing'].includes(data.status) || data.magentoWriteAttempted !== false) throw Error('Повторно перевірте точний шлях.');
      setProof(data); onVerified(data.status === 'would_create' ? data : null);
    } catch (cause) { if (ticket === sequence.current) setError(cause.response?.data?.error || cause.message || 'Не вдалося перевірити шлях магазину.'); }
    finally { if (ticket === sequence.current) { flight.current = false; setBusy(false); } }
  }
  return <section className="space-y-2" aria-label="План нової категорії Magento">
    <p className="text-sm">Код типу товару в Manager: <strong>{categoryCode || 'не обрано'}</strong>. Новий розділ Magento визначається батьком і назвою.</p>
    <button type="button" className="btn btn-outline" disabled={busy || !categoryCode || parents.length !== 1 || !name} onClick={check}>{busy ? 'Перевіряємо шлях…' : 'Перевірити шлях і вплив'}</button>
    {error && <Notice tone="error">{error}</Notice>}
    {proof && <Notice title={proof.status === 'existing' ? 'Розділ уже існує' : 'План створення перевірено'}>
      <p>{proof.path.split('/').join(' › ')} · parent ID {proof.parentId}{proof.categoryId && ` · розділ ID ${proof.categoryId}`}.</p>
      <p>{proof.status === 'existing' ? 'Оберіть цей наявний розділ. Повторне створення не потрібне.' : 'Окреме підтвердження створить один активний розділ, прихований з меню.'} Саме створення змінює 0 товарів і не застосовує прив’язку.</p>
      <p>Чинних товарів цього типу: {proof.impact.activeProductUpperBound}. Точний вплив нового правила й перелік товарів перевіряються перед окремим застосуванням пакета.</p>
    </Notice>}
  </section>;
}
