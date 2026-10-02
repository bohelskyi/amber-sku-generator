import { PageHeader } from '../ui/index.js';

export function AdminHeader({ mode = 'catalog' }) {
  const isCatalog = mode === 'catalog';
  return <PageHeader
    breadcrumbs={[{ label: 'Налаштування', to: '/settings' }, { label: isCatalog ? 'Каталог' : 'Ціноутворення' }]}
    eyebrow="Конфігурація"
    title={isCatalog ? 'Каталог' : 'Ціноутворення'}
    description={isCatalog
      ? 'Категорії, питання, варіанти та публікація схем внутрішнього SKU.'
      : 'Цінові сценарії, матриці та модифікатори для кожної категорії.'}
  />;
}
