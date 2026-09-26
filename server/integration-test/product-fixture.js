// Explicit synthetic inserts only. Runtime services never use this helper: their
// missing state must fail the deferred constraint. Keep old checkpoint SQL raw.
function insertProductFixture(queryable, sql, values = []) {
  const returning = /\bRETURNING\s+([\s\S]*?)\s*;?\s*$/i.exec(sql);
  const insert = returning ? sql.slice(0, returning.index) : sql.trim().replace(/;$/, '');
  return queryable.query(`WITH fixture AS (${insert} RETURNING *), lifecycle AS (
    INSERT INTO product_full_export_state(product_id, route, evidence)
    SELECT id, CASE WHEN status IN ('archived','corrected') THEN 'retired' ELSE 'normal' END,
      '{"origin":"ordinary_save","fixture":true}'::jsonb FROM fixture
  ) SELECT ${returning ? returning[1].replace(/;$/, '') : '*'} FROM fixture`, values);
}

module.exports = { insertProductFixture };
