import { Link } from 'react-router-dom';
import { Notice } from '../app/UiPrimitives.jsx';

export default function RetiredCatalogNotice({ availability, categoryCode }) {
  if (!availability?.publicationBlocked) return null;
  const resources = [...new Map(availability.resources.map((resource) => [`${resource.attributeId}:${resource.optionId || ''}`, resource])).values()];
  return <Notice tone="warning" title="Чернетку збережено для історії">
    <p>Ця чернетка посилається на вже видалені тестові ресурси Magento. Її не можна застосувати; підтвердження зі старого спостереження більше не означають готовність.</p>
    {resources.slice(0, 20).map((resource) => <p key={`${resource.attributeId}:${resource.optionId || ''}`}>{resource.attributeCode} · ID {resource.attributeId}{resource.optionId && ` · варіант ${resource.optionId}`}</p>)}
    <Link className="underline" to={`/admin/magento/prepare${categoryCode ? `?category=${encodeURIComponent(categoryCode)}` : ''}`}>Підготувати нову зміну від чинної публікації</Link>
  </Notice>;
}
