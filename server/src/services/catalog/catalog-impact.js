const pool = require('../../db/pool');
const { createHash } = require('node:crypto');
const { getRuleDependencies } = require('../../utils/rules');

async function getCatalogItemImpact(type, id, queryable = pool) {
  if (!['question', 'option'].includes(type)) throw Object.assign(new Error('Перегляд залежностей доступний для питань і варіантів.'), { statusCode: 400 });
  const result = await queryable.query(type === 'question'
    ? 'SELECT id, category_code, key, label, archived FROM questions WHERE id = $1'
    : `SELECT o.id, q.category_code, q.key, o.label, o.archived, o.value_id, o.question_id
       FROM options o JOIN questions q ON q.id=o.question_id WHERE o.id=$1`, [Number(id)]);
  const item = result.rows[0];
  if (!item) throw Object.assign(new Error('Елемент каталогу не знайдено.'), { statusCode: 404 });
  const counts = await queryable.query(`SELECT
    (SELECT COUNT(*)::int FROM products WHERE category=$1 AND details #> ARRAY['answers',$2] IS NOT NULL
      AND ($3::text IS NULL OR details #>> ARRAY['answers',$2]=$3)) AS products,
    (SELECT COUNT(*)::int FROM products WHERE category=$1) AS category_products,
    (SELECT COUNT(*)::int FROM sku_schema_questions sq JOIN sku_schema_versions sv ON sv.id=sq.schema_version_id
      WHERE sv.category_code=$1 AND sq.question_key=$2) AS published_schemas,
    (SELECT COUNT(*)::int FROM product_characteristic_versions cv WHERE cv.category_code=$1 AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(cv.snapshot->'questions') q WHERE q->>'key'=$2)) AS characteristic_versions,
    (SELECT COUNT(*)::int FROM magento_binding_options WHERE amber_group=$1 AND question_key=$2
      AND ($3::text IS NULL OR value_id::text=$3)) AS magento_bindings,
    (SELECT COUNT(*)::int FROM export_template_versions v WHERE EXISTS (
      SELECT 1 FROM jsonb_each(v.definition->'sources') s WHERE s.value->>'category'=$1 AND s.value->>'key'=$2)) AS published_templates,
    (SELECT COUNT(*)::int FROM export_template_drafts d WHERE EXISTS (
      SELECT 1 FROM jsonb_each(d.definition->'sources') s WHERE s.value->>'category'=$1 AND s.value->>'key'=$2)) AS template_drafts,
    (SELECT COUNT(*)::int FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1 AND q.key=$2) AS options`,
  [item.category_code, item.key, type === 'option' ? String(item.value_id) : null]);
  const rules = await queryable.query(`SELECT 'question' AS kind, id, visible_if_json AS rule, NULL::text AS axis_x_key, NULL::text AS axis_y_key
    FROM questions WHERE category_code=$1
    UNION ALL SELECT 'option', o.id, o.visible_if_json, NULL, NULL FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1
    UNION ALL SELECT 'option', o.id, o.hidden_if_json, NULL, NULL FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1
    UNION ALL SELECT 'scenario', id, match_json, axis_x_key, axis_y_key FROM price_scenarios WHERE category_code=$1
    UNION ALL SELECT 'modifier', id, COALESCE(match_json, '{}'::jsonb) || jsonb_build_object(trigger_key,trigger_val), NULL, NULL
      FROM price_modifiers WHERE category_code=$1 AND trigger_key IS NOT NULL
    UNION ALL SELECT 'modifier', id, match_json, NULL, NULL FROM price_modifiers WHERE category_code=$1 AND trigger_key IS NULL`, [item.category_code]);
  const dependencies = rules.rows.filter((row) => !(type === 'question' && row.kind === 'question' && Number(row.id) === Number(id))
    && (getRuleDependencies(row.rule).includes(item.key)
      || [row.axis_x_key, row.axis_y_key].some((axis) => String(axis || '').split('+').map((key) => key.trim()).includes(item.key))))
    .map((row) => ({ type: row.kind, id: Number(row.id) }));
  const affectedCounts = { ...counts.rows[0], rules: dependencies.length };
  const blocked = Number(affectedCounts.category_products) > 0 || Number(affectedCounts.published_schemas) > 0 || Number(affectedCounts.characteristic_versions) > 0
    || Number(affectedCounts.magento_bindings) > 0 || Number(affectedCounts.published_templates) > 0
    || Number(affectedCounts.template_drafts) > 0 || dependencies.length > 0;
  const impact = { type, id: Number(id), categoryCode: item.category_code, key: item.key, label: item.label,
    archived: Boolean(item.archived), affectedCounts, dependencies: dependencies.slice(0, 100),
    canDeleteLocal: !blocked, localDeleteOnly: true,
    reason: blocked ? 'Є історія або залежності. Архівуйте елемент, щоб зберегти призначення та ідентичність.' : null,
    remoteDeletionReason: 'Видалення в обох системах потребує окремої перевіреної дії Magento; ця команда видаляє лише невикористаний локальний елемент.',
    confirmation: `DELETE ${type}:${Number(id)}` };
  return { ...impact, impactHash: createHash('sha256').update(JSON.stringify(impact)).digest('hex') };
}

module.exports = { getCatalogItemImpact };
