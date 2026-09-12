async function lockOptionWithUsage(client, optionId) {
  const result = await client.query(
    `SELECT o.id, o.question_id, o.value_id, o.sku_code, o.label,
            o.visible_if_json, o.hidden_if_json, o.archived,
            q.key AS question_key, q.category_code,
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
