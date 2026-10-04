import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { repairContext, withRepairContext } from '../../lib/magento-repair-context.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoMappingBrowser from './MagentoMappingBrowser.jsx';
import { useAuth } from '../../auth/auth-context.js';
import { IntegrationRulesTable } from '../export-templates/IntegrationRulesTable.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import MagentoCharacteristics from './MagentoCharacteristics.jsx';
import { placementRows, questionTargets } from './category-journeys.js';
import './category-journeys.css';

const ProductChecks = lazy(() => import('./MagentoProductChecks.jsx'));
const tabs = [['placement', 'Розміщення в магазині'], ['attributes', 'Характеристики'], ['products', 'Товари']];
const decisionLabels = { approved: 'Підключено', blocked: 'Потребує рішення', candidate: 'Потрібно підтвердити', missing: 'Категорії ще немає' };

export default function MagentoCategoryDetail({ categories, canManage, canViewProducts, activeId }) {
  const { permissions } = useAuth(); const navigate = useNavigate();
  const { categoryCode } = useParams(); const [params] = useSearchParams();
  const categorySummary = categories.find((item) => item.code === categoryCode);
  const [loaded, setDetail] = useState(null); const [error, setError] = useState('');
  const [rules, setRules] = useState(null); const [rulesError, setRulesError] = useState('');
  const detail = loaded?.categoryCode === categoryCode ? loaded.data : null;
  const freshCategory = detail?.categories?.find((item) => item.code === categoryCode);
  const category = categorySummary || (freshCategory ? { ...freshCategory, operational: { state: 'unavailable', count: null, reasons: [] } } : null);
  const definition = rules?.version === detail?.revision?.templateVersionId ? rules?.definition : null;
  const field = params.get('field') || '';
  const tab = tabs.some(([id]) => id === params.get('tab')) ? params.get('tab') : params.get('path') || field === 'categories' ? 'placement' : 'attributes';
  const context = { ...repairContext(params), category: categoryCode };
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal, params: activeId ? { bindingRevisionId: activeId } : {} })
      .then(({ data }) => { if (!controller.signal.aborted) { setDetail({ categoryCode, data }); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати відповідності категорії.'); });
    return () => controller.abort();
  }, [activeId, categoryCode]);
  const templateId = detail?.revision?.templateId; const templateVersion = detail?.revision?.templateVersionId;
  useEffect(() => {
    if (!templateId || !templateVersion) return undefined;
    const controller = new AbortController();
    api.get(`/admin/export-templates/${encodeURIComponent(templateId)}`, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      const version = data.versions?.find((item) => item.id === templateVersion);
      if (version) { setRules({ version: templateVersion, definition: version.definition }); setRulesError(''); }
      else setRulesError('Правила саме цієї публікації недоступні. Іншу версію не підставлено.');
    }).catch(() => { if (!controller.signal.aborted) setRulesError('Не вдалося прочитати поточні правила передачі.'); });
    return () => controller.abort();
  }, [templateId, templateVersion]);
  if (!category) return error ? <Notice>{error}</Notice> : !detail ? <LoadingState /> : <EmptyState>Категорію не знайдено.</EmptyState>;
  const currentCategory = detail?.categories?.find((item) => item.code === categoryCode);
  const values = currentCategory?.values || [];
  const categoryQuery = encodeURIComponent(category.code); const base = `/admin/magento/categories/${categoryQuery}`;
  const currentPath = `${base}?${params.toString()}`;
  const catalogPath = `/admin/catalog?category=${categoryQuery}&returnTo=${encodeURIComponent(currentPath)}`;
  const prepare = (intent, extra = {}) => withRepairContext(`/admin/magento/prepare?intent=${intent}`, context, extra);
  const stale = detail && Object.hasOwn(detail, 'currentPublishedId') && detail.currentPublishedId !== activeId;
  const associations = questionTargets(definition, detail?.revision, category.code);
  const placement = placementRows(detail?.revision, category.code);
  const groupIndex = definition?.groups?.findIndex((group) => group.route === categoryCode);
  const canEdit = canManage && !stale;
  const canCheckProducts = canManage && permissions.includes('exports.view');
  return <div className="space-y-5">
    <div className="category-journey-actions"><Link className="text-sm underline" to="/admin/magento/categories">До категорій</Link>{context.returnTo && <Link className="text-sm underline" to={context.returnTo}>Повернутися до проблеми товару</Link>}</div>
    <div className="category-journey-actions"><h2 className="text-xl font-semibold">{category.name}</h2>{category.operational.state !== 'known' ? <span>Стан доставки невідомий</span> : category.operational.count ? <Link className="underline" to={`/attention?category=${categoryQuery}`}>Потребують уваги: {category.operational.count} товарів</Link> : <span className="text-sm text-slate-600">Зафіксованих проблем немає</span>}</div>
    {stale && <Notice tone="warning">Поточні налаштування інтеграції змінилися. Оновіть стан, щоб відкрити чинні правила; нижче залишено попередні збережені відповідності.</Notice>}
    {error && <Notice>{error}</Notice>}{!detail && !error && <LoadingState />}
    <nav className="category-workspace-tabs" aria-label="Розділи категорії">{tabs.map(([id, label]) => <Link key={id} aria-current={tab === id ? 'page' : undefined} to={withRepairContext(`${base}?tab=${id}`, context)}>{label}</Link>)}</nav>
    {tab === 'placement' && <section className="space-y-3" aria-label="Розміщення категорії в магазині">
      <div className="category-journey-actions"><h3 className="font-semibold">Розділи магазину</h3>{canEdit && <Link className="btn btn-primary" to={prepare('subcategory')}>Додати підкатегорію</Link>}</div>
      {detail && !placement.length && <EmptyState>Розміщення цієї категорії ще не налаштовано.{canEdit && <Link className="block underline mt-2" to={prepare('category')}>Налаштувати розміщення</Link>}</EmptyState>}
      {placement.map((row) => <div className="category-placement-row space-y-2" key={row.path}>
        <h4>{row.path.split('/').join(' › ')}</h4>
        <p>{row.decisions.every((item) => item.reviewState === 'approved') ? 'Підключено' : row.decisions.some((item) => item.reviewState === 'blocked') ? 'Потребує рішення' : 'Потрібно перевірити підключення'}</p>
        {canEdit && <div className="category-journey-actions"><Link className="underline text-sm" to={prepare('rules', { field: 'categories', path: row.path })}>Змінити правило розміщення</Link><Link className="underline text-sm" to={prepare('subcategory', { field: 'categories', path: row.path })}>Додати підкатегорію тут</Link></div>}
        <MagentoDetails summary="Умови та збережені свідчення">{() => row.decisions.map((item, index) => <p key={index}>{item.routeKey} · {decisionLabels[item.reviewState] || 'Не підтверджено'} · Magento ID {item.categoryId || '—'}</p>)}</MagentoDetails>
      </div>)}
      {canEdit && <Link className="text-sm underline" to={`/admin/magento/categories/new?category=${categoryQuery}`}>Перевірити налаштування категорії</Link>}
    </section>}
    {tab === 'attributes' && <>
      <div className="category-journey-actions"><h3 className="font-semibold">Характеристики та значення</h3>{canEdit && <><Link className="btn btn-primary" to={prepare('attribute')}>Додати характеристику</Link><Link className="btn btn-outline" to={prepare('option')}>Додати значення</Link></>}{permissions.includes('catalog.view') && <Link className="underline text-sm" to={catalogPath}>Редагувати характеристики</Link>}</div>
      {rulesError && <Notice>{rulesError}</Notice>}
      {detail && <MagentoCharacteristics questions={detail.catalog?.questions?.[categoryCode]} values={values} targets={associations} definition={definition} revision={detail.revision}
        actionFor={canEdit ? (question, fields) => prepare(question.input_type === 'text' ? fields.length ? 'rules' : 'attribute' : 'option', { question: question.id, field: fields[0] || '' }) : undefined}
        catalogPath={permissions.includes('catalog.view') && permissions.includes('catalog.manage') ? catalogPath : undefined} />}
      <section className="space-y-3"><h3 className="font-semibold">Відповідності категорії</h3>
        {detail && <MagentoMappingBrowser key={`${activeId}:${categoryCode}:${field}`} values={values} field={field} targetsByQuestion={associations}
          catalogPath={permissions.includes('catalog.view') && permissions.includes('catalog.manage') ? catalogPath : undefined}
          actionFor={canEdit ? (value, fields) => prepare('mapping', { question: value.questionKey, value: value.valueId, field: fields.includes(field) || value.mappings.some((mapping) => mapping.attribute === field) ? field : value.mappings[0]?.attribute || fields[0] || '' }) : undefined}
          optionActionFor={canEdit ? (group) => prepare('option', { question: group.questionKey, field: group.targets[0] || '' }) : undefined} />}
      </section>
      {detail?.revision && !stale && <MagentoDetails summary="Правила передачі інших полів">{() => <div className="space-y-3">{rulesError ? <Notice>{rulesError}</Notice> : definition ? groupIndex >= 0
        ? <IntegrationRulesTable definition={definition} groupIndex={groupIndex} revision={detail.revision} readOnly onSelect={(column) => navigate(withRepairContext(`/admin/magento/rules/${encodeURIComponent(detail.revision.templateId)}?version=${encodeURIComponent(templateVersion)}`, context, { field: column }))} />
        : <p>Категорію ще не включено до чинних правил.</p> : templateId ? <LoadingState compact label="Читаємо правила цієї категорії…" /> : <p>Опублікованих правил ще немає.</p>}</div>}</MagentoDetails>}
      {activeId && ['export_templates.manage', 'export_templates.publish'].every((permission) => permissions.includes(permission)) && <Link className="text-sm underline" to={`${base}/labels`}>Порівняти підписи значень</Link>}
    </>}
    {tab === 'products' && <section className="space-y-4" aria-label="Товари категорії">
      <h3 className="font-semibold">Доставка товарів</h3>
      <p>{category.operational.state !== 'known' ? 'Дані про проблеми недоступні.' : category.operational.count ? `Потребують уваги: ${category.operational.count} товарів` : 'Зафіксованих проблем немає. Конкретний товар можна перевірити нижче.'}</p>
      {category.operational.reasons.map((reason) => <p key={reason.code}>{reason.message} · {reason.count}</p>)}
      {canViewProducts && <Link className="btn btn-outline" to={`/attention?category=${categoryQuery}`}>Відкрити проблеми товарів</Link>}
      {detail?.revision && !stale && canCheckProducts && <Suspense fallback={<LoadingState />}><ProductChecks revision={detail.revision} categoryCode={category.code} initialProductId={context.productId} /></Suspense>}
      {!canCheckProducts && <p className="text-sm text-slate-600">Перевірка конкретного товару потребує дозволів керування інтеграцією та перегляду даних експорту.</p>}
    </section>}
  </div>;
}
