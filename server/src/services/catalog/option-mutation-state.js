async function lockOptionWithUsage(client, optionId) {
  const result = await client.query(
    `SELECT o.id, o.question_id, o.value_id, o.sku_code, o.label, o.label_en,
            o.visible_if_json, o.hidden_if_json, o.archived,
            q.key AS question_key, q.category_code,
            (SELECT COUNT(*)::int FROM product_characteristic_versions cv WHERE cv.category_code=q.category_code AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(cv.snapshot->'questions') sq,
                jsonb_array_elements(sq->'options') so
              WHERE sq->>'key'=q.key AND so->>'value_id'=o.value_id::text)) AS characteristic_count,
            (SELECT COUNT(*)::int FROM sku_schema_options so
             JOIN sku_schema_questions sq ON sq.id=so.schema_question_id
             JOIN sku_schema_versions sv ON sv.id=sq.schema_version_id
             WHERE sv.category_code=q.category_code AND sq.question_key=q.key AND so.value_id=o.value_id) AS schema_count,
            (
              SELECT COUNT(*)::int
              FROM products p
              WHERE p.category = q.category_code
                AND p.details #>> ARRAY['answers', q.key] = o.value_id::text
            ) AS product_count
     FROM options o
     JOIN questions q ON q.id = o.question_id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [Number(optionId)]
  );
  return result.rows[0] || null;
}

module.exports = {
  lockOptionWithUsage,
};
