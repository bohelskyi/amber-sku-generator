import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import { useAuth } from '../../auth/auth-context.js';

const labels = { approved: 'Підтверджено', not_applicable: 'Не застосовується', blocked: 'Рішення / обмеження', candidate: 'Потрібна перевірка', missing: 'Відсутня відповідність', ambiguous: 'Потрібно уточнити', drifted: 'Потрібна повторна перевірка' };
export default function MagentoCategoryDetail({ categories, canManage, canViewProducts, activeId }) {
  const { permissions } = useAuth();
  const { categoryCode } = useParams();
  const category = categories.find((item) => item.code === categoryCode);
  const [detail, setDetail] = useState(null); const [error, setError] = useState('');
  const [all, setAll] = useState(false); const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal, params: activeId ? { bindingRevisionId: activeId } : {} })
      .then(({ data }) => { if (!controller.signal.aborted) setDetail(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати відповідності категорії.'); });
    return () => controller.abort();
  }, [activeId, categoryCode]);
  if (!category) return <EmptyState>Категорію не знайдено.</EmptyState>;
  const values = detail?.categories.find((item) => item.code === categoryCode)?.values || [];
  const visible = all ? values : values.filter((value) => ['missing', 'candidate', 'ambiguous', 'drifted'].includes(value.state));
  const current = Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1));
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
      {detail && <>
        <button type="button" className="btn btn-outline btn-compact-md" aria-pressed={all} onClick={() => { setAll(!all); setPage(0); }}>{all ? 'Показати лише питання' : 'Показати всі відповідності'}</button>
        {!visible.length && <p className="text-sm">Немає невирішених відповідностей у цьому перегляді. Переглянуті відмови доступні серед усіх відповідностей.</p>}
        <div className="divide-y">{visible.slice(current * 50, (current + 1) * 50).map((value) => <article className="py-3" key={`${value.questionKey}:${value.valueId}`}>
          <p className="font-medium">{value.questionLabel}: {value.label}</p><p className="text-sm">{labels[value.state] || 'Потрібна перевірка'}</p>
          <MagentoDetails>{() => <><p>value_id: {value.valueId} · sku_code: {value.skuCode}</p>{value.mappings.map((mapping, index) => <p key={index}>{mapping.routeKey} · {mapping.attribute} · Magento ID {mapping.optionId || '—'} · {mapping.optionLabel}</p>)}</>}</MagentoDetails>
        </article>)}</div>
        {visible.length > 50 && <nav className="flex flex-wrap gap-3" aria-label="Сторінки відповідностей"><button className="btn btn-outline btn-compact-md" disabled={!current} onClick={() => setPage(current - 1)}>Назад</button><span>{current + 1} / {Math.ceil(visible.length / 50)}</span><button className="btn btn-outline btn-compact-md" disabled={(current + 1) * 50 >= visible.length} onClick={() => setPage(current + 1)}>Далі</button></nav>}
      </>}
    </section>
  </div>;
}
