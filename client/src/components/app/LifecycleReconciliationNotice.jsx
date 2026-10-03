import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { TechnicalDisclosure } from '../ui/index.js';

export function LifecycleReconciliationNotice({ problem, article }) {
  const { permissions = [] } = useContext(AuthContext) || {};
  const issue = problem.eligibilityIssue;
  const canReconcile = permissions.includes('exports.reconcile');
  return <div className="space-y-2">
    <p>Товар збережено в Amber. Автоматичну доставку утримано до перевірки історії попередньої версії товару: наявних підтверджень недостатньо для безпечного рішення.</p>
    <p>Ця перешкода виникає до надсилання змін у Magento. Перевірка історії може потребувати окремого читання Magento; відкриття цієї сторінки його не виконує.</p>
    <p className="font-semibold">{canReconcile ? 'Потрібне контрольоване узгодження історії доставки' : 'Потрібне узгодження Адміністратора'}</p>
    <p>{canReconcile
      ? 'Перегляньте збережені підтвердження та узгодьте рішення за чинною процедурою. Зняття утримання в цьому інтерфейсі недоступне.'
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
      {canReconcile && <p className="mt-2 break-words">Процедура: docs/FULL_PRODUCT_CUTOVER_RUNBOOK.md, розділ «Historical ambiguity after recount». Читання підтверджень: server/scripts/full-product-cutover.js, action: review, productIds: поточний ID товару та ID попередніх версій. Свіжий результат перевірки потрібен перед окремим рішенням; review нічого не застосовує.</p>}
    </TechnicalDisclosure>
  </div>;
}
