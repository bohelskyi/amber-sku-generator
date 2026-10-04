import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Button, Notice, TechnicalDisclosure } from '../ui/index.js';
import MagentoProductComparison from './MagentoProductComparison.jsx';
import { nextAction, problemRepairUrl, problemTitle } from './sync-problem-presentation.js';

export default function MagentoProductDiagnosis({ product, returnTo }) {
  const { permissions, principalLifetime } = useAuth();
  const allowed = permissions.includes('export_templates.manage') && permissions.includes('exports.view') && principalLifetime?.valid !== false;
  const [result, setResult] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const controller = useRef(null); const principal = useRef(principalLifetime);
  useEffect(() => { principal.current = principalLifetime; return () => controller.current?.abort(); }, [principalLifetime]);
  async function inspect() {
    if (controller.current || !allowed) return;
    const request = new AbortController(); controller.current = request; setBusy(true); setError(''); setResult(null);
    try {
      const { data } = await api.post('/admin/magento-integration/product-preview', { productId: product.productId }, { signal: request.signal });
      if (Number(data.productId) !== Number(product.productId) || data.article !== product.article) throw new Error('Wrong product evidence');
      if (!request.signal.aborted && principal.current === principalLifetime && principalLifetime?.valid !== false) setResult({ data, principalLifetime });
    } catch (failure) {
      if (!request.signal.aborted && principal.current === principalLifetime) setError(failure.response?.data?.error || 'Не вдалося отримати підтверджені дані цього товару. Повторіть перевірку.');
    } finally {
      if (controller.current === request) controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  if (!allowed) return null;
  const current = result && result.principalLifetime === principalLifetime ? result.data : null;
  return <section className="sync-live-diagnosis" aria-label="Перевірка даних товару в Magento">
    <h3>Дані товару в Magento</h3>
    <p className="sync-problem-guidance">Порівняйте поточні категорії та характеристики з правилами Amber. Перевірка лише читає Magento.</p>
    <Button size="compactMd" busy={busy} onClick={inspect}>Перевірити категорії та характеристики</Button>
    {error && <Notice tone="error">{error}</Notice>}
    {current && <>
      <Notice tone={current.sendable ? 'info' : 'warning'}>{current.sendable
        ? 'Перешкод для підготовленої доставки не виявлено. Ця перевірка не надсилала змін.'
        : 'Перевірка виявила перешкоди для доставки.'}</Notice>
      {current.observedAt && <p className="sync-problem-guidance">Перевірено: {new Date(current.observedAt).toLocaleString('uk-UA')}</p>}
      {current.blockers?.length > 0 && <ul className="sync-diagnostic-problems">{current.blockers.map((problem, index) => <li key={index}>
        <strong>{problemTitle(problem)}</strong>
        {problem.expectedValue !== null && problem.expectedValue !== undefined && <p>Значення за правилом: {String(problem.expectedValue)}</p>}
        {permissions.includes('export_templates.view') && ['integration_configuration', 'integration_preparation'].includes(problem.resolution)
          && <Link className="btn btn-outline btn-compact-md" to={problemRepairUrl(problem, product, returnTo)}>{nextAction(problem)}</Link>}
      </li>)}</ul>}
      <MagentoProductComparison result={current} />
      <TechnicalDisclosure><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(current, null, 2)}</pre></TechnicalDisclosure>
    </>}
  </section>;
}
