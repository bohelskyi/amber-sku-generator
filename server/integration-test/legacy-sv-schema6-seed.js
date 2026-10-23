// Test-only copies of the current catalog and the independent frozen schema.
// Batch transport only: keep every explicit ID, row order and JSON/null encoding.
function insertRows(db, statement, rows, jsonColumns) {
  const values = [];
  const tuples = rows.map(row => `(${row.map((value, column) => {
    values.push(value);
    return `$${values.length}${jsonColumns.includes(column) ? '::jsonb' : ''}`;
  }).join(',')})`);
  return db.query(`${statement} VALUES ${tuples.join(',')}`, values);
}

async function seedCurrentSvCatalog(db, fixture) {
  await insertRows(db, `INSERT INTO questions
    (id,category_code,key,label,input_type,required,include_in_sku,sku_index,display_order,sku_separator,visible_if_json,archived,numeric_validation)`,
  fixture.currentQuestions.map(q => [
    q.id, 'SV', q.key, q.label, q.input_type, q.required, q.include_in_sku,
    q.sku_index, q.display_order, q.sku_separator,
    q.visible_if_json === null ? null : JSON.stringify(q.visible_if_json), q.archived,
    q.numeric_validation === null ? null : JSON.stringify(q.numeric_validation),
  ]), [10, 12]);
  await insertRows(db, `INSERT INTO options
    (id,question_id,value_id,sku_code,label,label_en,visible_if_json,hidden_if_json,archived)`,
  fixture.currentOptions.map(o => [
    o.id, o.question_id, o.value_id, o.sku_code, o.label, o.label_en,
    JSON.stringify(o.visible_if_json), JSON.stringify(o.hidden_if_json), o.archived,
  ]), [6, 7]);
}

// The caller inserts schema version 6 between the current and frozen phases.
async function seedFrozenSvSchema(db, fixture) {
  await insertRows(db, `INSERT INTO sku_schema_questions
    (id,schema_version_id,question_key,label,sku_index,display_order,required,sku_separator,visible_if_json)`,
  fixture.questions.map(q => [
    q.id, 6, q.question_key, q.label, q.sku_index, q.display_order,
    q.required, q.sku_separator, JSON.stringify(q.visible_if_json),
  ]), [8]);
  await insertRows(db, `INSERT INTO sku_schema_options
    (id,schema_question_id,value_id,sku_code,label,visible_if_json,hidden_if_json,archived)`,
  fixture.options.map(o => [
    o.id, o.schema_question_id, o.value_id, o.sku_code, o.label,
    JSON.stringify(o.visible_if_json), JSON.stringify(o.hidden_if_json), o.archived,
  ]), [5, 6]);
}

module.exports = { seedCurrentSvCatalog, seedFrozenSvSchema };
