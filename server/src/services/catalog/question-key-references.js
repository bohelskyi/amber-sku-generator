const RULE_UPDATE_TARGETS = Object.freeze({
  questionVisibility: Object.freeze({
    column: 'visible_if_json',
    sql: 'UPDATE questions SET visible_if_json = $1::jsonb WHERE id = $2',
  }),
  optionVisibility: Object.freeze({
    column: 'visible_if_json',
    sql: 'UPDATE options SET visible_if_json = $1::jsonb WHERE id = $2',
  }),
  optionHidden: Object.freeze({
    column: 'hidden_if_json',
    sql: 'UPDATE options SET hidden_if_json = $1::jsonb WHERE id = $2',
  }),
  modifierMatch: Object.freeze({
    column: 'match_json',
    sql: 'UPDATE price_modifiers SET match_json = $1::jsonb WHERE id = $2',
  }),
});

function renameJsonObjectKey(value, oldKey, newKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  return Object.entries(value).reduce((result, [key, item]) => {
    const isLogicalOperator = key === '$or' || key === '$and';
    const nextKey = !isLogicalOperator && key === oldKey ? newKey : key;
    result[nextKey] = isLogicalOperator && Array.isArray(item)
      ? item.map((branch) => renameJsonObjectKey(branch, oldKey, newKey))
      : item;
    return result;
  }, {});
}

function renameAxisKey(axisKey, oldKey, newKey) {
  if (!axisKey) return axisKey;
  return String(axisKey)
    .split('+')
    .map((key) => (key.trim() === oldKey ? newKey : key.trim()))
    .join('+');
}

async function rewriteRuleKeyForTarget(client, targetName, row, oldKey, newKey) {
  const target = RULE_UPDATE_TARGETS[targetName];
  if (!target) throw new TypeError('Unsupported catalog rule rewrite target');

  const currentRule = row[target.column];
  const nextRule = renameJsonObjectKey(currentRule, oldKey, newKey);
  if (JSON.stringify(nextRule) === JSON.stringify(currentRule)) return;

  await client.query(target.sql, [JSON.stringify(nextRule), row.id]);
}

async function rewriteQuestionKeyReferences(client, { categoryCode, oldKey, newKey }) {
  const questionRules = await client.query(
    `SELECT id, visible_if_json
     FROM questions
     WHERE category_code = $1
       AND visible_if_json IS NOT NULL`,
    [categoryCode]
  );
  for (const row of questionRules.rows) {
    await rewriteRuleKeyForTarget(
      client,
      'questionVisibility',
      row,
      oldKey,
      newKey
    );
  }

  const optionRules = await client.query(
    `SELECT o.id, o.visible_if_json, o.hidden_if_json
     FROM options o
     JOIN questions q ON q.id = o.question_id
     WHERE q.category_code = $1
       AND (o.visible_if_json IS NOT NULL OR o.hidden_if_json IS NOT NULL)`,
    [categoryCode]
  );
  for (const row of optionRules.rows) {
    await rewriteRuleKeyForTarget(client, 'optionVisibility', row, oldKey, newKey);
    await rewriteRuleKeyForTarget(client, 'optionHidden', row, oldKey, newKey);
  }

  const scenarios = await client.query(
    `SELECT id, match_json, axis_x_key, axis_y_key
     FROM price_scenarios
     WHERE category_code = $1
       AND (
         match_json IS NOT NULL
         OR axis_x_key = $2
         OR axis_y_key = $2
         OR axis_x_key LIKE $3
         OR axis_y_key LIKE $3
       )`,
    [categoryCode, oldKey, `%${oldKey}%`]
  );
  for (const row of scenarios.rows) {
    const nextMatchJson = renameJsonObjectKey(row.match_json, oldKey, newKey);
    await client.query(
      `UPDATE price_scenarios
       SET match_json = $1::jsonb,
           axis_x_key = $2,
           axis_y_key = $3
       WHERE id = $4`,
      [
        JSON.stringify(nextMatchJson || {}),
        renameAxisKey(row.axis_x_key, oldKey, newKey),
        renameAxisKey(row.axis_y_key, oldKey, newKey),
        row.id,
      ]
    );
  }

  const modifierRules = await client.query(
    `SELECT id, match_json
     FROM price_modifiers
     WHERE category_code = $1
       AND match_json IS NOT NULL`,
    [categoryCode]
  );
  for (const row of modifierRules.rows) {
    await rewriteRuleKeyForTarget(client, 'modifierMatch', row, oldKey, newKey);
  }

  await client.query(
    `UPDATE price_modifiers
     SET trigger_key = $1
     WHERE category_code = $2 AND trigger_key = $3`,
    [newKey, categoryCode, oldKey]
  );

  await client.query(
    `UPDATE products
     SET details = jsonb_set(
       details #- $1::text[],
       $2::text[],
       details #> $1::text[],
       true
     )
     WHERE category = $3
       AND details #> $1::text[] IS NOT NULL`,
    [['answers', oldKey], ['answers', newKey], categoryCode]
  );
}

module.exports = {
  renameJsonObjectKey,
  renameAxisKey,
  rewriteRuleKeyForTarget,
  rewriteQuestionKeyReferences,
};
