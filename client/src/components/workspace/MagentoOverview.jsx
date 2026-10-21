import { Link } from 'react-router-dom';
import { Button, Notice, StatusBadge, TechnicalDisclosure } from '../ui/index.js';
import MagentoStructureResult from './MagentoStructureResult.jsx';

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

export default function MagentoOverview({ integration, observation, checking, checkError, onCheck, canManage }) {
  if (!integration) return null;
  const operational = integration.operational;
  const published = integration.activePublication;
  const date = value => value ? new Date(value).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : 'Ще не перевірено';
  return <section className="store-connection" aria-label="Стан підключення магазину">
    <dl className="store-connection-facts">
      <div><dt>Магазин</dt><dd>{integration.storeHost || 'Magento'}</dd></div>
      <div><dt>Підключення</dt><dd>{integration.configured ? 'Налаштовано' : 'Не налаштовано'}</dd></div>
      <div><dt>Автоматичне передавання</dt><dd>{integration.delivery.state === 'enabled' ? 'Увімкнено' : integration.delivery.state === 'disabled' ? 'Вимкнено' : 'Стан невідомий'}</dd></div>
      <div><dt>Перевірка в цьому сеансі</dt><dd>{date(observation?.observedAt)}</dd></div>
    </dl>
    <div className="store-connection-check"><Button variant="primary" busy={checking} disabled={!integration.configured} onClick={onCheck}>Перевірити підключення</Button>
      <p>Перевіряє доступ до Magento та структуру магазину. Доставку товарів показано окремо.</p></div>
    {checkError && <Notice tone="error">{checkError}{observation && ' Остання успішна перевірка показана вище.'}</Notice>}
    {observation && !checkError && <Notice tone="success">Magento відповів · {date(observation.observedAt)}.</Notice>}
    <div className="store-connection-work">
      {operational.state === 'known' ? operational.count > 0
        ? <Link className="btn btn-outline btn-compact-md" to="/attention">Потребують уваги: {operational.count} товарів</Link>
        : <p>Зафіксованих проблем товарів немає.</p> : <p>Дані про проблеми товарів недоступні.</p>}
      <Link className="btn btn-outline btn-compact-md" to="/admin/catalog">Відкрити Каталог</Link>
      {canManage && integration.draftCount > 0 && <Link className="btn btn-outline btn-compact-md" to="/admin/magento/changes">Продовжити зміни ({integration.draftCount})</Link>}
    </div>
    {observation?.comparison && !checkError && <TechnicalDisclosure summary="Результат перевірки структури">{() => <MagentoStructureResult comparison={observation.comparison} activeId={published?.id} />}</TechnicalDisclosure>}
    <TechnicalDisclosure summary="Технічні дані підключення">{() => <dl className="store-connection-facts">
      <div><dt>Чинні правила</dt><dd>{published ? `Версія ${published.versionNumber} · ${date(published.publishedAt)}` : 'Ще не опубліковано'}</dd></div>
      <div><dt>Збережене спостереження структури</dt><dd>{date(integration.structureObservation?.observedAt)}</dd></div>
      <div><dt>Локальні дані оновлено</dt><dd>{date(integration.asOf)}</dd></div>
      <div><dt>Ідентифікатор правил</dt><dd>{published?.id || '—'}</dd></div>
    </dl>}</TechnicalDisclosure>
  </section>;
}
