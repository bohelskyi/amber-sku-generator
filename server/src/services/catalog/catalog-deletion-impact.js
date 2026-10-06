const c = require('../magento/binding-contract');

function mentions(value,key) {
  if (typeof value === 'string') return value === key || value.includes(`answers.${key}`) || value.includes(`.${key}=`);
  if (Array.isArray(value)) return value.some(item => mentions(item,key));
  return !!value && typeof value === 'object' && Object.entries(value).some(([name,item]) => name === key || mentions(item,key));
}
async function readImpact(db,command) {
  const question = (await db.query('SELECT * FROM questions WHERE id=$1',[command.questionId])).rows[0];
  if (!question) throw c.error(404,'CATALOG_DELETE_LOCAL_NOT_FOUND','Характеристику не знайдено.');
  const options = (await db.query('SELECT * FROM options WHERE question_id=$1 ORDER BY id',[question.id])).rows;
  const selected = command.type === 'option' ? options.filter(item => String(item.id) === command.optionId) : options;
  if (command.type === 'option' && selected.length !== 1) throw c.error(404,'CATALOG_DELETE_LOCAL_NOT_FOUND','Варіант цієї характеристики не знайдено.');
  const products = (await db.query(`SELECT id,full_sku,status,details FROM products WHERE category=$1 ORDER BY id LIMIT 101`,[question.category_code])).rows;
  // All category products conservatively block deletion, including archived history.
  // Existing used-option protection is never weakened by this separate workflow.
  const pricing = (await db.query(`SELECT 'scenario' AS type,id,to_jsonb(s) AS data FROM price_scenarios s WHERE category_code=$1
    UNION ALL SELECT 'modifier',id,to_jsonb(m) FROM price_modifiers m WHERE category_code=$1 ORDER BY type,id`,[question.category_code])).rows;
  const rules = (await db.query(`SELECT 'question' AS type,id,to_jsonb(q) AS data FROM questions q
    UNION ALL SELECT 'option',id,to_jsonb(o) FROM options o ORDER BY type,id`)).rows
    .filter(item => !(item.type === 'question' && String(item.id) === String(question.id))
      && !selected.some(option => item.type === 'option' && String(item.id) === String(option.id))
      && (mentions(item.data.visible_if_json,question.key) || mentions(item.data.hidden_if_json,question.key)));
  const templates = (await db.query(`SELECT template_id AS id,'draft' AS state,definition FROM export_template_drafts
    UNION ALL SELECT v.id,'active',v.definition FROM export_template_versions v
    WHERE EXISTS(SELECT 1 FROM export_template_activation a WHERE a.template_version_id=v.id)
      OR EXISTS(SELECT 1 FROM magento_binding_revisions r WHERE r.template_version_id=v.id AND
        (r.state='draft' OR r.version_number=(SELECT max(x.version_number) FROM magento_binding_revisions x WHERE x.installation_key=r.installation_key AND x.state='published')))
    ORDER BY id`)).rows.filter(row => mentions(row.definition,question.key));
  // Drafts and the latest publication for every installation are operational.
  // Superseded immutable publications/observations are historical evidence.
  const bindings = (await db.query(`SELECT DISTINCT r.id,r.installation_key,r.state,r.revision,b.route_key,b.binding_key,b.attribute_code
    FROM magento_binding_revisions r JOIN magento_binding_attributes b ON b.revision_id=r.id
    WHERE r.origin_hash=$1 AND b.attribute_code=$2 AND (r.state='draft' OR r.version_number=(SELECT max(x.version_number)
      FROM magento_binding_revisions x WHERE x.installation_key=r.installation_key AND x.state='published'))
    ORDER BY r.id,b.route_key,b.binding_key`,[command.originHash,command.target.attributeCode])).rows;
  const mappings = (await db.query(`SELECT revision_id,binding_key,amber_group,question_key,value_id,option_id,source_kind
    FROM magento_binding_options o JOIN magento_binding_revisions r ON r.id=o.revision_id
    WHERE r.origin_hash=$3 AND attribute_code=$1 AND ($2::text IS NULL OR option_id=$2)
      AND (r.state='draft' OR r.version_number=(SELECT max(x.version_number) FROM magento_binding_revisions x WHERE x.installation_key=r.installation_key AND x.state='published'))
    ORDER BY revision_id,binding_key,source_key`,[command.target.attributeCode,command.target.optionId,command.originHash])).rows;
  const sharedMappings = mappings.filter(row => row.source_kind !== 'semantic' || row.amber_group !== question.category_code || row.question_key !== question.key
    || (command.type === 'option' && String(row.value_id) !== String(selected[0].value_id)));
  const schemas = (await db.query(`SELECT v.id,v.version,s.question_key FROM sku_schema_versions v
    JOIN sku_schema_questions s ON s.schema_version_id=v.id WHERE v.category_code=$1 AND s.question_key=$2 ORDER BY v.id`,[question.category_code,question.key])).rows;
  const blockers = [];
  for (const [items,code] of [[products,'LOCAL_PRODUCTS_DEPEND_ON_CATEGORY'],[pricing,'LOCAL_PRICING_REVIEW_REQUIRED'],[rules,'LOCAL_RULES_DEPEND_ON_QUESTION'],
    [templates,'ACTIVE_TEMPLATE_DEPENDENCY'],[bindings,'BINDING_DEPENDENCY'],[sharedMappings,'SHARED_REMOTE_RESOURCE']]) if (items.length) blockers.push(code);
  if (products.length > 100) blockers.push('LOCAL_SCOPE_LIMIT');
  return {question,selectedOptions:selected,products:products.map(({id,full_sku,status}) => ({id,sku:full_sku,status})),pricing,rules,templates:templates.map(({id,state})=>({id,state})),
    bindings,mappings,sharedMappings,historicalSchemas:schemas,blockers};
}
module.exports = { mentions, readImpact };
