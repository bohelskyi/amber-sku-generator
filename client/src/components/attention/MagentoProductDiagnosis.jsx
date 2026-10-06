import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { Button, Notice, TechnicalDisclosure } from '../ui/index.js';
import MagentoProductComparison from './MagentoProductComparison.jsx';
import { nextAction, problemRepairUrl, problemTitle } from './sync-problem-presentation.js';

export default function MagentoProductDiagnosis({ product, returnTo, identityOnly = false, onTechnicalEvidence }) {
  const { permissions, principalLifetime } = useAuth();
  const allowed = permissions.includes('export_templates.manage') && permissions.includes('exports.view') && principalLifetime?.valid !== false;
  const [result, setResult] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const controller = useRef(null); const principal = useRef(principalLifetime);
  useEffect(() => { principal.current = principalLifetime; return () => controller.current?.abort(); }, [principalLifetime]);
  useEffect(() => { onTechnicalEvidence?.(allowed && result?.principalLifetime === principalLifetime ? result.data : null); }, [allowed, onTechnicalEvidence, principalLifetime, result]);
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
    {!identityOnly && <h3>Дані товару в Magento</h3>}
    <p className="sync-problem-guidance">{identityOnly ? 'Прочитаємо поточний товар і покажемо, чи збігається він із раніше підтвердженим. Ця перевірка нічого не змінює.' : 'Покажемо поточні значення, очікувані зміни та перешкоди. Перевірка лише читає Magento і не запускає синхронізацію.'}</p>
    <Button variant={identityOnly ? 'primary' : 'secondary'} size="compactMd" busy={busy} onClick={inspect}>{identityOnly ? 'Перевірити ідентичність товару Magento' : 'Перевірити дані та очікувані зміни'}</Button>
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
      {current.identity && <dl className="sync-verified-facts"><div><dt>Раніше підтверджений товар Magento</dt><dd>{current.identity.confirmedMagentoId ? `№${current.identity.confirmedMagentoId}` : 'Підтвердженої ідентичності немає'}</dd></div>
        <div><dt>Товар за цим артикулом зараз</dt><dd>{current.identity.observedMagentoId ? `№${current.identity.observedMagentoId}` : current.identity.state === 'absent' ? 'Не знайдено в Magento' : 'Даних недостатньо'}</dd></div></dl>}
      {identityOnly && current.blockers?.some((problem) => (problem.diagnosticCode || problem.code) === 'NAME_REMOTE_IDENTITY_CHANGED') && <Notice tone="warning">Зв’язок не збігається. Передайте артикул і дані перевірки відповідальному за інтеграцію. Вибір назви або повторне надсилання не відновлюють цей зв’язок.</Notice>}
      {!identityOnly && <MagentoProductComparison result={current} />}
      {!onTechnicalEvidence && <TechnicalDisclosure summary="Спостереження Magento для підтримки"><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(current, null, 2)}</pre></TechnicalDisclosure>}
    </>}
  </section>;
}
