import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoMappingBrowser from './MagentoMappingBrowser.jsx';
import { useAuth } from '../../auth/auth-context.js';

export default function MagentoCategoryDetail({ categories, canManage, canViewProducts, activeId }) {
  const { permissions } = useAuth();
  const { categoryCode } = useParams();
  const category = categories.find((item) => item.code === categoryCode);
  const [detail, setDetail] = useState(null); const [error, setError] = useState('');
  const [params] = useSearchParams();
  const field = params.get('field') || '';
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal, params: activeId ? { bindingRevisionId: activeId } : {} })
      .then(({ data }) => { if (!controller.signal.aborted) setDetail(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати відповідності категорії.'); });
    return () => controller.abort();
  }, [activeId, categoryCode]);
  if (!category) return <EmptyState>Категорію не знайдено.</EmptyState>;
  const values = detail?.categories.find((item) => item.code === categoryCode)?.values || [];
  return <div className="space-y-5">
    <Link className="text-sm underline" to="/admin/magento">До огляду</Link>
    <h2 className="text-xl font-semibold">{category.name}</h2>
    <section className="card space-y-3 p-5"><h3 className="font-semibold">Поточна доставка</h3>
      <p>{category.operational.state !== 'known' ? 'Дані про операційні проблеми недоступні.' : category.operational.count ? `Потребують уваги: ${category.operational.count} товарів` : 'Зафіксованих проблем немає'}</p>
      {category.operational.reasons.map((reason) => <p key={reason.code} className="text-sm">{reason.message} · {reason.count}</p>)}
      {canViewProducts && category.operational.count > 0 && <Link className="btn btn-outline btn-compact-md" to={`/sync-problems?category=${encodeURIComponent(category.code)}`}>Переглянути проблеми товарів</Link>}
    </section>
    <section className="card space-y-3 p-5"><h3 className="font-semibold">Підготовка майбутніх змін</h3>
      {category.preparation.needed ? category.preparation.reasons.map((reason) => <p key={reason.code}>{reason.message}{reason.count > 1 ? ` · ${reason.count}` : ''}</p>) : <p>Невирішених структурних питань не виявлено.</p>}
      <p className="text-sm text-slate-600">Вплив на конкретні товари не перевірено. Структурні відповідності не є підтвердженням доставки.</p>
      {canManage && <Link className="btn btn-primary btn-compact-md" to={`/admin/magento/prepare?category=${encodeURIComponent(category.code)}`}>Підготувати зміни інтеграції</Link>}
      {activeId && ['export_templates.manage', 'export_templates.publish'].every((permission) => permissions.includes(permission)) && <Link className="block text-sm underline" to={`/admin/magento/categories/${encodeURIComponent(category.code)}/labels`}>Порівняти підписи значень без змін</Link>}
    </section>
    <section className="card space-y-3 p-5"><h3 className="font-semibold">Відповідності категорії</h3>
      {error && <Notice>{error}</Notice>}{!detail && !error && <LoadingState />}
      {detail && <MagentoMappingBrowser key={`${activeId}:${categoryCode}:${field}`} values={values} field={field} />}
    </section>
  </div>;
}
