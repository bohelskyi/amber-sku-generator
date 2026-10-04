import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fieldsForSource } from '../../lib/export-template-attributes.js';
import { fieldLabels } from '../../lib/export-template-editor.js';
import { sourceLabel } from '../../lib/export-template-presentation.js';
import { withRepairContext } from '../../lib/magento-repair-context.js';
import { Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import { problemTitle } from '../attention/sync-problem-presentation.js';

const categoryNames = { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' };
const reasons = {
  REPRESENTATIVE_CREATE_REQUIRED: 'Потрібен перевірений приклад нового товару. Відкрийте «Приклад на товарі».',
  AFFECTED_CURRENT_PREVIEW_BLOCKED: 'Один із товарів, які зміняться, не пройшов перевірку. Відкрийте саме цей товар нижче.',
  RECONCILIATION_REQUIRED: 'Раніше відправлену зміну ще не підтверджено. Спочатку перевірте цей товар у Magento.',
  BINDING_REVIEW_REQUIRED: 'Цю відповідність ще потрібно підтвердити у підготовці.',
  ENABLED_ROUTE_REQUIRED: 'У підготовці немає жодної підключеної категорії. Виберіть і підтвердьте набір атрибутів Magento.',
  ATTRIBUTE_SET_MISSING: 'Вибраного набору атрибутів немає у збереженій структурі Magento. Перевірте набір для цієї категорії.',
  ATTRIBUTE_SET_ID_REQUIRED: 'Для цієї категорії ще не вибрано набір атрибутів Magento.',
  ATTRIBUTE_BINDING_REQUIRED: 'Правило використовує поле без прив’язки до Magento. Перевірте підключення цього поля.',
  ATTRIBUTE_MISSING: 'Вибраного поля немає у збереженій структурі Magento. Перевірте його підключення.',
  ATTRIBUTE_IDENTITY_REQUIRED: 'Для цього правила ще не вибрано поле Magento.',
  ATTRIBUTE_NOT_IN_EXPECTED_SET: 'Поле не входить до вибраного набору атрибутів Magento. Перевірте набір і поле.',
  OPTION_BINDING_REQUIRED: 'Одне зі значень характеристики не має відповідності Magento. Виберіть її в редакторі поля.',
  OPTION_ID_REQUIRED: 'Для цього значення ще не вибрано відповідність Magento.',
  OPTION_ID_MISSING: 'Вибраного значення немає у збереженій структурі Magento. Виберіть наявне значення.',
  SEMANTIC_IDENTITY_UNRESOLVED: 'Правило використовує значення характеристики, яке не підтверджене в каталозі. Перевірте джерело та значення цього поля.',
  FIELD_POLICY_REQUIRED: 'Для поля ще не вибрано спосіб передавання. Виберіть його явно у перевірці відповідностей.',
  SEMANTIC_OUTPUT_DOMAIN_UNRESOLVED: 'Правило списку не дає підтвердженої відповідності значень. Перевірте правило цього поля.',
  DYNAMIC_DOMAIN_BINDING_REQUIRED: 'Правило списку може повертати значення без прив’язки до Magento. Перевірте правило та відповідності поля.',
  ROUTE_IDENTITY_INVALID: 'Відповідність категорії не належить цьому шаблону. Потрібна повторна підготовка від чинної інтеграції.',
  ROUTE_EVIDENCE_MISMATCH: 'Набір атрибутів у відповідності не збігається з правилом категорії. Перевірте правило та повторно підготуйте зміни.',
  ATTRIBUTE_CONTEXT_INVALID: 'Відповідність поля не належить цьому правилу. Перевірте правило та повторно підготуйте зміни.',
  MAPPING_STRATEGY_INVALID: 'Спосіб прив’язки не відповідає правилу поля. Перевірте правило та повторно підготуйте зміни.',
  ATTRIBUTE_TARGET_MISMATCH: 'Правило і прив’язка використовують різні поля Magento. Перевірте підключення поля.',
  OPTION_SOURCE_INVALID: 'Відповідність значення не належить цьому правилу. Перевірте правило та повторно підготуйте зміни.',
  STORE_SCOPE_INVALID: 'Вибраної мови або вітрини немає серед активних у Magento. Перевірте налаштування мови.',
  FIELD_POLICY_STATE_INVALID: 'Підтверджений спосіб передавання суперечить стану поля. Перевірте його поведінку.',
};
const sourceReasons = {
  category: 'Категорії, на яку посилається правило, немає в каталозі менеджера.',
  unique_current_question: 'У каталозі кілька характеристик з однаковим ключем. Потрібно визначити правильну характеристику.',
  current_non_sku_question: 'Правило посилається на інформаційну характеристику, яку не знайдено в каталозі. Перевірте джерело поля.',
  historical_sku_or_current_non_sku_question: 'Характеристику з цього правила не підтверджено в каталозі або історії SKU. Перевірте джерело поля.',
  historical_sku_or_current_non_sku_value_ids: 'Правило використовує значення, яких немає серед підтверджених значень характеристики. Перевірте джерело та відповідності поля.',
  captured_question: 'У шаблоні немає зафіксованої характеристики, потрібної цьому правилу. Перевірте джерело поля.',
  alias_ownership: 'Не підтверджено, що старий ключ характеристики належить указаній категорії та версії SKU.',
  alias_lineage: 'Не підтверджено, що старий і новий ключі означають ту саму характеристику. Довільного пояснення для цього недостатньо.',
};

// Resolve context from the exact draft and server diagnostics, never from labels
// or the product attention queue. A field link keeps both draft and publication.
export default function MagentoPublicationProblems({ review, revision, currentPublishedId, definition, registry, categories = [], repairContext, compact, onExample }) {
  const [copied, setCopied] = useState(false); const [copyError, setCopyError] = useState(false);
  if (!review.blockers.length) return null;
  const categoryName = (code) => categories.find((item) => item.code === code)?.name || categoryNames[code] || code;
  const fieldName = (field) => revision.schema?.attributes.find((item) => item.attribute_code === field)?.default_frontend_label || fieldLabels[field] || field;
  const fieldLink = ({ category, field, rowId, routeKey }) => {
    if (!category) return null;
    const params = new URLSearchParams({ binding: revision.id });
    if (currentPublishedId) params.set('source', currentPublishedId);
    if (field) params.set('field', field);
    if (rowId) params.set('language', rowId);
    if (routeKey) params.set('route', routeKey);
    return withRepairContext(`/admin/magento/categories/${encodeURIComponent(category)}?${params}`, repairContext, { category, field, path: '', question: '', value: '' });
  };
  const items = review.blockers.map((blocker) => {
    const attribute = revision.bindings?.attributes?.find((item) => item.bindingKey === blocker.bindingKey);
    const source = definition?.sources?.[blocker.sourceId];
    const product = review.checked.find((item) => item.kind === 'current' && item.productId === blocker.productId);
    const routeKey = blocker.routeKey || attribute?.routeKey || product?.routeKey;
    const category = blocker.category || source?.category || product?.group || routeKey?.split(/[.:]/)[0];
    const target = attribute?.target || blocker.target;
    const integrationIssues = product?.blockers?.filter((item) => ['integration_configuration', 'integration_preparation'].includes(item.resolution)) || [];
    const productFields = integrationIssues.flatMap((issue) => revision.bindings?.attributes?.filter((item) => item.routeKey === routeKey && item.target === (issue.target || issue.field))
      .map((item) => ({ category, field: item.target, rowId: item.rowId, routeKey })) || []);
    const fields = blocker.sourceId && definition ? fieldsForSource(definition, blocker.sourceId, true).map((field) => ({
      category: definition.groups[field.groupIndex].route, field: field.column,
      rowId: definition.groups[field.groupIndex].rows[field.rowIndex].id,
    })) : target && category ? [{ category, field: target, rowId: attribute?.rowId, routeKey }] : [...new Map(productFields.map((field) => [JSON.stringify(field), field])).values()];
    const article = product?.article || review.affected.find((item) => item.productId === blocker.productId)?.article;
    const value = revision.bindings?.options?.find((item) => item.bindingKey === blocker.bindingKey && item.sourceKey === blocker.sourceKey)?.evaluatedOutput;
    const sourceName = source ? sourceLabel(definition, blocker.sourceId, registry) : blocker.key;
    const context = [category && categoryName(category), target && fieldName(target), sourceName,
      (blocker.storeCode || attribute?.rowId) && (blocker.storeCode === 'en' || attribute?.rowId === 'english' ? 'EN' : 'UA'),
      value && `значення «${value}»`, blocker.path].filter(Boolean).join(' → ');
    const isSource = blocker.code.startsWith('SOURCE_REFERENCE_');
    const productNeedsAttention = !product?.blockers?.length || integrationIssues.length !== product.blockers.length;
    const reason = blocker.code === 'AFFECTED_CURRENT_PREVIEW_BLOCKED' && fields.length
      ? 'Перевірка товару виявила проблему в підготовленому правилі. Виправте вказане поле цієї підготовки.'
      : reasons[blocker.code] || (isSource ? sourceReasons[blocker.requirement] || 'Джерело характеристики не пройшло перевірку. Перевірте правило поля.'
      : 'Перевірка налаштувань не пройдена. Точну причину наведено в деталях нижче; її можна скопіювати для виправлення.');
    return { blocker, category, fields, context, reason, article, product, productNeedsAttention };
  });
  const report = JSON.stringify({ bindingRevisionId: revision.id, expectedRevision: revision.revision, expectedCurrentId: currentPublishedId,
    blockers: review.blockers, checked: review.checked.filter((item) => review.blockers.some((blocker) => blocker.productId && blocker.productId === item.productId)),
  }, null, 2);
  return <section aria-label="Що блокує застосування" className="space-y-3"><Notice tone="warning">
    <p className="font-semibold">Зміни ще не застосовано. Що потрібно виправити:</p>
    <ul className="space-y-3">{items.map(({ blocker, category, fields, context, reason, article, product, productNeedsAttention }, index) => <li key={index}>
      {context && <p className="font-semibold break-words">{context}</p>}
      <p>{reason}{!compact && blocker.routeKey ? ` · ${blocker.routeKey}` : ''}</p>
      {blocker.unresolvedValueIds?.length > 0 && <p>Непідтверджені значення: {blocker.unresolvedValueIds.join(', ')}.</p>}
      {blocker.productId && <><p>Товар: {article || `№${blocker.productId}`}.</p>
        {product?.blockers?.length > 0 && <ul>{product.blockers.map((item, i) => <li key={i}>{typeof item === 'string' ? reasons[item] || item : problemTitle(item)}</li>)}</ul>}
        {(productNeedsAttention || !fields.length) && <Link className="underline" to={`/attention?problem=${encodeURIComponent(blocker.productId)}`}>Відкрити проблему цього товару</Link>}
      </>}
      {blocker.code === 'REPRESENTATIVE_CREATE_REQUIRED' && onExample && category && <button type="button" className="btn btn-outline btn-compact-md" onClick={() => onExample(category)}>Перевірити приклад нового товару: {categoryName(category)}</button>}
      {fields.map((field, fieldIndex) => <p key={fieldIndex}><Link className="underline" to={fieldLink(field)}>Перевірити поле: {categoryName(field.category)} → {fieldName(field.field)} · {field.rowId === 'english' ? 'EN' : 'UA'}</Link></p>)}
      {!fields.length && category && !blocker.productId && blocker.code !== 'REPRESENTATIVE_CREATE_REQUIRED' && <Link className="underline" to={fieldLink({ category })}>Перевірити налаштування: {categoryName(category)}</Link>}
      <MagentoDetails summary="Точна причина перевірки">{() => <pre className="text-xs whitespace-pre-wrap break-words">{JSON.stringify(blocker, null, 2)}</pre>}</MagentoDetails>
    </li>)}</ul>
    <p className="mt-3 text-sm">Після виправлення поверніться до застосування й повторіть перевірку впливу на товари.</p>
  </Notice>
    <button type="button" className="btn btn-outline btn-compact-md" onClick={async () => {
      try { await navigator.clipboard.writeText(report); setCopied(true); setCopyError(false); }
      catch { setCopyError(true); }
    }}>Копіювати причини блокування</button>
    {copied && <p role="status">Причини блокування скопійовано.</p>}
    {copyError && <label className="block text-sm">Скопіюйте цей звіт вручну<textarea className="input" rows={8} readOnly value={report} /></label>}
  </section>;
}
