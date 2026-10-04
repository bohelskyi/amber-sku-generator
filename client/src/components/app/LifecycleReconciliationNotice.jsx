import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { TechnicalDisclosure } from '../ui/index.js';

export function LifecycleReconciliationNotice({ problem, article, recoveryAvailable = false }) {
  const { permissions = [] } = useContext(AuthContext) || {};
  const issue = problem.eligibilityIssue;
  const canReconcile = permissions.includes('exports.reconcile');
  return <div className="space-y-2">
    <p>Товар збережено в Amber. Автоматичну доставку утримано до перевірки історії попередньої версії товару: наявних підтверджень недостатньо для безпечного рішення.</p>
    <p>Ця перешкода виникає до надсилання змін у Magento. Перевірка історії може потребувати окремого читання Magento; відкриття цієї сторінки його не виконує.</p>
    <p className="font-semibold">{canReconcile ? 'Потрібне контрольоване узгодження історії доставки' : 'Потрібне узгодження Адміністратора'}</p>
    <p>{canReconcile
      ? recoveryAvailable ? 'Відкрийте перевірку доставки нижче. Спочатку перевірте докази, потім окремо підтвердьте дозволене рішення.' : 'Відкрийте проблему товару, щоб перевірити докази й окремо підтвердити дозволене рішення щодо доставки.'
      : 'Передайте артикул Адміністратору або відповідальному оператору з дозволом на узгодження історії доставки.'}</p>
    {permissions.includes('history.view') && article && <Link className="underline" to={`/products/history?sku=${encodeURIComponent(article)}`}>Історія товару</Link>}
    <TechnicalDisclosure>
      <dl className="technical-key-values">
        <div><dt>Код</dt><dd>{problem.code}</dd></div>
        {issue && <>
          <div><dt>Маршрут доставки</dt><dd>{issue.lifecycleRoute}</dd></div>
          <div><dt>Причина утримання</dt><dd>{issue.holdReason}</dd></div>
          <div><dt>Причина історичної невизначеності</dt><dd>{issue.primaryReason || 'Не встановлено'}</dd></div>
          <div><dt>Класифікація підтверджень</dt><dd>{issue.classification || 'Не встановлено'}</dd></div>
          <div><dt>ID переобліку</dt><dd>{issue.sourceCorrectionId ?? 'Немає'}</dd></div>
          <div><dt>ID попередніх версій</dt><dd>{issue.ancestorProductIds.join(', ') || 'Немає'}</dd></div>
          <div><dt>Версія доставки</dt><dd>{issue.deliveryVersion}</dd></div>
        </>}
      </dl>
    </TechnicalDisclosure>
  </div>;
}
