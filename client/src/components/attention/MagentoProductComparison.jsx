import { StatusBadge } from '../ui/index.js';
import { PRODUCT_FIELD_LABELS } from './sync-problem-presentation.js';
import './attention.css';

const actions = { preserve: 'Зберігається Magento', unchanged: 'Без змін', would_update: 'Заплановано оновлення',
  would_add: 'Заплановано додавання', blocked: 'Потребує виправлення', unresolved: 'Не визначено' };
const policies = { authoritative_create_update: 'Amber задає значення', initialize_create_only: 'Amber задає лише при створенні',
  magento_managed: 'Керується в Magento', preserve_by_safe_preview: 'Збережено до окремого рішення',
  preview_default: 'Правило керування ще не підтверджено', optional_create_policy_required: 'Потрібне рішення для створення' };
const warningText = {
  PRODUCT_ATTRIBUTE_SET_MISMATCH: 'Набір характеристик товару в Magento відрізняється від вибраного правилами. Це зауваження; можливість доставки визначена сервером окремо.',
  FIELD_INTENTIONALLY_PRESERVED: 'Поточне значення Magento зберігається відповідно до правил керування полем.',
  MAGENTO_ONLY_CATEGORIES_PRESERVED: 'Додаткові категорії Magento зберігаються; ця перевірка не пропонує їх видаляти.',
  APPROVED_LABEL_DIFFERENCE: 'Підписи значення відрізняються, але використовується підтверджена відповідність.',
  NUMERIC_FORMATTING_DIFFERENCE: 'Числове значення збігається, відрізняється лише формат запису.',
  LEGACY_REMOTE_ROUNDED_VALUE: 'У Magento збережене історичне округлене значення.',
  LABEL_DRIFT_REVIEW_REQUIRED: 'Підпис значення змінився; потрібна перевірка відповідності.',
};

function Value({ evidence }) {
  if (!evidence || evidence.state === 'unavailable') return <span className="sync-comparison-unknown">Немає достовірних даних</span>;
  if (evidence.state === 'product_absent') return <span>Товар ще не створено</span>;
  if (evidence.state === 'unresolved') return <span className="sync-comparison-unknown">Значення не визначено</span>;
  const values = Array.isArray(evidence.value) ? evidence.value : [evidence.value];
  if (!values.length || values.every((value) => value === null || value === undefined || value === '')) return <span>Не задано</span>;
  return <>{values.map((value, index) => <span className="sync-comparison-value" key={index}>{String(value)}</span>)}</>;
}

export default function MagentoProductComparison({ result }) {
  return <div className="sync-product-comparison">
    {result.comparisons?.length > 0 && <table>
      <caption>Дані товару та результат перевірки</caption>
      <thead><tr><th scope="col">Поле</th><th scope="col">Зараз у Magento</th><th scope="col">За правилами Amber</th><th scope="col">Що відбудеться</th></tr></thead>
      <tbody>{result.comparisons.map((row) => <tr key={row.target}>
        <th scope="row">{row.label || PRODUCT_FIELD_LABELS[row.target] || row.target}</th>
        <td data-label="Зараз у Magento"><Value evidence={row.current} /></td>
        <td data-label="За правилами Amber"><Value evidence={row.expected} /></td>
        <td data-label="Що відбудеться"><StatusBadge tone={row.severity === 'blocked' ? 'warning' : 'neutral'}>
          {row.severity === 'blocked' ? 'Потребує виправлення' : actions[row.action] || 'Потрібна перевірка'}</StatusBadge>
          {policies[row.policy] && <small>{policies[row.policy]}{Object.hasOwn(row, 'policyState') && row.policyState !== 'approved'
            && ['authoritative_create_update', 'initialize_create_only', 'magento_managed'].includes(row.policy) ? ' · правило не підтверджене' : ''}</small>}
        </td>
      </tr>)}</tbody>
    </table>}
    {result.warnings?.length > 0 && <section className="sync-comparison-warnings" aria-label="Зауваження до перевірки">
      <h4>Зауваження до перевірки</h4><ul>{result.warnings.map((warning, index) => <li key={index}>
        {warning.target && <strong>{PRODUCT_FIELD_LABELS[warning.target] || warning.target}: </strong>}
        {warningText[warning.code] || 'Додаткове зауваження до цього результату доступне в технічних деталях.'}
      </li>)}</ul>
    </section>}
  </div>;
}
