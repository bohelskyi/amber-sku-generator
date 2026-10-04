import { Link } from 'react-router-dom';
import { Notice } from '../app/UiPrimitives.jsx';

export default function MagentoStructureResult({ comparison, activeId }) {
  if (!comparison) return null;
  if (comparison.state === 'stale' || comparison.bindingRevisionId && comparison.bindingRevisionId !== activeId) {
    return <Notice tone="warning">Підключення змінилося. Перевірте структуру ще раз перед висновками.</Notice>;
  }
  if (comparison.state === 'unavailable') return <Notice>{comparison.reason}</Notice>;
  return <section className="space-y-3" aria-label="Результат перевірки структури" aria-live="polite">
    <p className="font-medium">{comparison.state === 'checked' ? 'У перевірених налаштуваннях розбіжностей не знайдено.' : `Потрібно переглянути: ${comparison.findings.length} налаштувань.`}</p>
    <p className="text-sm text-slate-600">Перевірено підключень: {comparison.routesChecked}; атрибутів: {comparison.attributesChecked}. Доставку товарів ця перевірка не підтверджує.</p>
    <ul className="divide-y">{comparison.findings.map((item, index) => {
      const params = new URLSearchParams({ tab: item.path ? 'placement' : 'attributes' });
      if (item.field) params.set('field', item.field);
      if (item.path) params.set('path', item.path);
      return <li key={index} className="space-y-2 py-3 text-sm"><p><strong>{item.label || item.path?.replaceAll('/', ' → ') || 'Структура магазину'}</strong> · {item.message}</p>
        {item.categoryCode && <Link className="underline" to={`/admin/magento/categories/${encodeURIComponent(item.categoryCode)}?${params}`}>Переглянути налаштування</Link>}
      </li>;
    })}</ul>
  </section>;
}
