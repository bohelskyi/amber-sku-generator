import { sourceLabel } from '../../lib/export-template-presentation';
import { fieldsForSource } from '../../lib/export-template-attributes';
import { fieldLabels } from '../../lib/export-template-editor';

const requirements = {
  category: 'Потрібна наявна категорія каталогу.',
  unique_current_question: 'Ключ має відповідати одному поточному питанню.',
  current_non_sku_question: 'Потрібне поточне інформаційне питання поза SKU або затверджене історичне джерело.',
  historical_sku_or_current_non_sku_question: 'Потрібне питання в незмінній SKU-схемі або поточне питання поза SKU.',
  historical_sku_or_current_non_sku_value_ids: 'Потрібні семантичні ID в незмінній SKU-схемі або поточному питанні поза SKU. Поточні SKU-опції самі по собі цього не підтверджують.',
  captured_question: 'У визначенні має бути зафіксоване питання каталогу.',
  alias_ownership: 'Потрібне підтвердження ключа та категорії в указаній SKU-схемі.',
  alias_lineage: 'Потрібне підтвердження рівнозначності ключів; довільний опис не є доказом.',
};
const categories = { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' };

export function SourceDiagnostics({ diagnostics = [], definition, registry, canSave = false, onOpenSource, showHeading = true }) {
  if (!diagnostics.length) return null;
  const issues = diagnostics.map((diagnostic) => {
    const source = definition?.sources?.[diagnostic.sourceId];
    const category = diagnostic.category || source?.category;
    const key = diagnostic.key || source?.key;
    const dimension = (category === 'KL' && ['exact_size', 'pedant_size'].includes(key)) || (category === 'AR' && key === 'size');
    const readable = source ? sourceLabel(definition, diagnostic.sourceId, registry) : null;
    const label = dimension ? 'розмір' : readable && readable !== key && readable !== diagnostic.sourceId ? readable : 'Характеристика без підтвердженої назви';
    const title = categories[category] ? `${categories[category]} → ${label}` : label;
    return { title, entries: [diagnostic] };
  });
  const count = new Set(diagnostics.map((d) => d.sourceId)).size;
  const noun = count % 10 === 1 && count % 100 !== 11 ? 'джерело'
    : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'джерела' : 'джерел';
  return <div role="alert" className="danger-panel p-3 space-y-2">
    {showHeading && <p>Шаблон ще не готовий до публікації.</p>}
    <p>{canSave ? 'Чернетку можна зберегти. ' : ''}Перед публікацією потрібно перевірити {count} {noun}.</p>
    {issues.map(({ title, entries }, index) => <div key={index}><p className="font-semibold">{title}</p>
      <p>Джерело потрібно перевірити перед публікацією.</p>
      {onOpenSource && [...new Set(entries.map((d) => d.sourceId))].flatMap((id) => fieldsForSource(definition, id, true).map((field) => <button type="button" className="et-link et-issue-target" key={`${id}/${field.groupIndex}/${field.rowIndex}/${field.column}`} onClick={() => onOpenSource(id, field)}>
        {categories[definition.groups[field.groupIndex].route]} → {fieldLabels[field.column] || field.column} · {field.rowIndex === 1 ? 'EN' : 'Основний'} · {sourceLabel(definition, id, registry)}
      </button>))}
      <details><summary>Технічні подробиці</summary>{entries.map((d, index) => <div key={index} className="text-sm break-words space-y-1">
        <p>Джерело: {d.sourceId}{d.key ? ` · ключ: ${d.key}` : ''}</p>
        <p>{requirements[d.requirement] || 'Перевірте наявність джерела та підтвердження його семантичних значень.'}</p>
        {d.unresolvedValueIds?.length > 0 && <p>Непідтверджені value_id: {d.unresolvedValueIds.join(', ')}</p>}
        {d.currentValueIds && <p>Поточні value_id: {d.currentValueIds.join(', ') || 'немає'}</p>}
        {d.historicalValueIds && <p>Історичні value_id: {d.historicalValueIds.join(', ') || 'немає'}</p>}
        {d.aliasKey && <p>Ключ зіставлення: {d.aliasKey} · SKU-схема: {d.schemaId}</p>}
        <p>{d.code} · {d.message}</p>
      </div>)}</details>
    </div>)}
  </div>;
}
