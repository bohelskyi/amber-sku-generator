import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { EmptyState, SectionHeader, StatusBadge } from '../ui/index.js';

export function CategoryCard({ category }) {
  const operational = category.operational;
  const lifecycle = operational.reasons?.some((reason) => reason.resolution === 'lifecycle_reconciliation');
  const destination = lifecycle ? `/sync-problems?category=${encodeURIComponent(category.code)}`
    : `/admin/magento/categories/${encodeURIComponent(category.code)}`;
  return <article className="magento-category-card">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="font-semibold"><Link to={destination}>{category.name}</Link></h3>
      {operational.count > 0 && <StatusBadge tone="warning">Потребують уваги: {operational.count}</StatusBadge>}
    </div>
    {operational.reasons?.slice(0, 2).map((reason) => <p key={reason.code} className="mt-2 text-sm">{reason.message}</p>)}
    {category.preparation.needed && <p className="mt-2 text-sm text-slate-600">{category.preparation.reasons[0]?.message || 'Потрібна підготовка перед використанням'}</p>}
    {!operational.count && !category.preparation.needed && <p className="mt-2 text-sm text-slate-600">{operational.state === 'known' ? 'Додаткових дій зараз не потрібно' : 'Операційні дані недоступні'}</p>}
    <Link className="mt-3 inline-block text-sm font-medium underline" to={destination}>{lifecycle ? 'Переглянути проблеми товарів' : 'Переглянути категорію'}</Link>
  </article>;
}

export default function MagentoOverview({ categories, all = false, canManage }) {
  const { permissions } = useAuth(); const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const operational = categories.filter((category) => category.operational.count > 0);
  const preparation = categories.filter((category) => category.preparation.needed && !category.operational.count);
  const found = categories.filter((category) => `${category.name} ${category.code}`.toLocaleLowerCase('uk').includes(query.toLocaleLowerCase('uk'))
    && (filter === 'all' || filter === 'attention' && category.operational.count > 0 || filter === 'preparation' && category.preparation.needed));
  return <div className="space-y-5">
    <SectionHeader title={all ? 'Категорії' : 'Потребують уваги'}
      actions={<Link className="btn btn-outline btn-compact-md" to={all ? '/admin/magento' : '/admin/magento/categories'}>{all ? 'До огляду' : 'Усі категорії'}</Link>} />
    {all ? <>
      <p className="text-sm text-slate-600">Розміщення в магазині, характеристики та стан товарів кожної категорії.</p>
      <div className="magento-category-actions"><label>Пошук категорії<input type="search" className="input" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label>Показати<select className="input" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Усі категорії</option><option value="attention">З проблемами доставки</option><option value="preparation">Потребують підготовки</option></select></label>{permissions.includes('catalog.manage') && <Link className="btn btn-outline" to="/admin/magento/categories/new">Додати категорію</Link>}<Link className="text-sm underline" to="/admin/magento/rules">Усі набори правил і версії</Link></div>
      <div className="magento-category-list">{found.map((category) => <div className="magento-category-row" key={category.code}><div><Link className="font-semibold underline" to={`/admin/magento/categories/${encodeURIComponent(category.code)}`}>{category.name}</Link><p className="text-sm text-slate-600">{category.code}</p></div><div><p>{category.operational.state !== 'known' ? 'Дані доставки недоступні' : category.operational.count ? `Потребують уваги: ${category.operational.count} товарів` : 'Зафіксованих проблем немає'}</p><small>{category.preparation.needed ? category.preparation.reasons[0]?.message || 'Потрібна підготовка' : 'Невирішених структурних питань немає'}</small></div><Link className="btn btn-outline" to={`/admin/magento/categories/${encodeURIComponent(category.code)}`}>Відкрити категорію</Link></div>)}</div>
      {!found.length && <EmptyState>Категорій за цим фільтром немає.</EmptyState>}
    </> : <>
      {operational.length > 0 && <section aria-labelledby="magento-operational-title"><h3 id="magento-operational-title" className="mb-3 font-semibold">Проблеми поточної доставки</h3>
        <div className="magento-category-grid">{operational.map((category) => <CategoryCard key={category.code} category={category} />)}</div>
      </section>}
      {canManage && <section className="magento-start-guide" aria-label="Робота з інтеграцією"><h3 className="font-semibold">Що потрібно зробити?</h3><div>{permissions.includes('catalog.manage') && <Link to="/admin/magento/categories/new">Додати категорію товарів</Link>}<Link to="/admin/magento/categories">Змінити розміщення або характеристики</Link><Link to="/admin/magento/changes">Продовжити підготовлені зміни</Link></div></section>}
      {preparation.length > 0 && <section aria-labelledby="magento-preparation-title"><h3 id="magento-preparation-title" className="mb-2 font-semibold">Підготовка перед використанням</h3>
        <p className="mb-3 text-sm text-slate-600">Ці питання стосуються майбутніх змін відповідностей і самі по собі не означають збій поточної доставки.</p>
        <div className="magento-category-grid">{preparation.map((category) => <CategoryCard key={category.code} category={category} />)}</div>
      </section>}
      {!operational.length && !preparation.length && <EmptyState>{categories.some((category) => category.operational.state !== 'known') ? 'Питань підготовки немає. Дані про поточні проблеми недоступні.' : 'Додаткових дій зараз не потрібно.'}</EmptyState>}
      {canManage && preparation.length > 0 && <Link className="btn btn-primary" to="/admin/magento/prepare">Підготувати зміни інтеграції</Link>}
    </>}
  </div>;
}
