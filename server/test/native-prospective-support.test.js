const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { loadProspectiveSupportInput } = require('../src/services/export-templates/support-inputs');
const { readCharacteristicConfiguration } = require('../src/services/product/characteristic-config');
const { upgradeColumns } = require('../src/services/export-templates/column-contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');

function definition() {
  const d = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
  d.evaluatorVersion = 'magento-declarative-5'; d.sourceContractVersion = 'public-product-characteristics-v1';
  return compileDefinition(d);
}
function database(category, key, value) {
  const queries = [];
  const question = { id: 1, key, label: key, input_type: 'options', required: 1, options: [{ value_id: value }] };
  return { queries, question, async query(sql) {
    queries.push(sql); assert.match(sql, /^SELECT to_jsonb\(c\)/);
    return { rows: [{ category: { code: category, requires_weight: 0 }, questions: [question] }] };
  } };
}
test('NM/AR prospective semantics use fresh live read evidence without allocating an immutable version or SKU', async () => {
  const compiled = definition();
  for (const [category, key, value] of [['NM', 'extra', 1], ['AR', 'size', 28]]) {
    const db = database(category, key, value);
    const hash = (await readCharacteristicConfiguration(db, category)).config_hash;
    const p = product(category, { [key]: value }, { id: null, full_sku: null, sku_schema_version_id: null, public_sku: 'AG-PREVIEW' });
    const supported = await loadProspectiveSupportInput(db, compiled.definition, p, hash);
    assert.deepEqual(evaluateProduct(compiled, supported).errors, []);
    assert.equal(supported.characteristic_version_id, undefined);
    assert.ok(evaluateProduct(compiled, { ...supported }).errors.some(e => e.code === 'SOURCE_SUPPORT_INVALID'));
    assert.equal(db.queries.length, 2);
    assert.ok(db.queries.every(sql => !/INSERT|UPDATE|nextval|sku_registry|product_characteristic_versions/.test(sql)));
    db.question.options[0].archived = true;
    await assert.rejects(loadProspectiveSupportInput(db, compiled.definition, p, hash), { code: 'PRODUCT_CHARACTERISTICS_CHANGED' });
  }
});
test('prospective context rejects stored identities, fake version IDs, old evaluators and different definition objects', async () => {
  const compiled = definition(), db = database('NM', 'extra', 1);
  const hash = (await readCharacteristicConfiguration(db, 'NM')).config_hash;
  const p = product('NM', { extra: 1 }, { id: null, full_sku: null, sku_schema_version_id: null, public_sku: 'AG-PREVIEW' });
  for (const changed of [{ id: 1 }, { public_sku: 'AG-000001' }, { characteristic_version_id: '1' }, { sku_schema_version_id: 1 }, { full_sku: 'NM1' }]) {
    await assert.rejects(loadProspectiveSupportInput(db, compiled.definition, { ...p, ...changed }, hash), { code: 'SOURCE_SUPPORT_INVALID' });
  }
  await assert.rejects(loadProspectiveSupportInput(db, { ...compiled.definition, evaluatorVersion: 'magento-declarative-4' }, p, hash), { code: 'SOURCE_SUPPORT_INVALID' });
  const supported = await loadProspectiveSupportInput(db, compiled.definition, p, hash);
  assert.ok(evaluateProduct(definition(), supported).errors.some(e => e.code === 'SOURCE_SUPPORT_INVALID'));
});

test('creation input mode is explicit and native live catalog needs no schema publication, within read-only RR', async () => {
  const { creationInputs } = require('../src/services/magento/integration-editor.service');
  for (const enabled of [true, false]) {
    const queries = [];
    const client = { release() {}, async query(sql) {
      queries.push(sql);
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes('public_sku_activation')) return { rows: [{ enabled }] };
      if (sql.includes('FROM categories c')) return { rows: [{ code: 'ZZ', name: 'New category', requires_weight: 0, code_mutable: true }] };
      if (sql.includes('FROM questions q')) return { rows: [{ q_db_id: 1, category_code: 'ZZ', key: 'kind', q_label: 'Kind', required: 1, include_in_sku: 1 }] };
      if (sql.includes('FROM sku_schema_versions')) return { rows: [] };
      throw new Error(sql);
    } };
    const result = await creationInputs({ categoryCode: 'ZZ' }, { databasePool: { connect: async () => client } });
    assert.equal(result.productCreation.identityMode, enabled ? 'public_identity' : 'encoded_sku');
    assert.equal(result.categories.ZZ.sku_schema_version_id, undefined);
    assert.equal(result.questions.ZZ[0].id, 'kind');
    assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(queries.at(-1), 'COMMIT');
    assert.ok(queries.every(sql => !/INSERT|UPDATE|nextval/.test(sql)));
  }
});

test('prospective native projection uses authoritative normalized answers for every category and leaves legacy behavior intact', () => {
  const { prospectiveAnswers } = require('../src/services/magento/integration-editor.service');
  for (const categoryCode of ['NM', 'AR', 'SV', 'ZZ']) {
    const built = { identityMode: 'public_identity', normalizedAnswers: { kind: 7, weight: 12.3 } };
    const projected = prospectiveAnswers(built, { categoryCode, answers: { kind: '007', weight: '12,3' } });
    assert.deepEqual(projected, { kind: 7, weight: 12.3 });
    projected.kind = 99; assert.equal(built.normalizedAnswers.kind, 7);
  }
  const legacy = { categoryCode: 'NM', answers: { size: '12,3', note: 'Text, unchanged' } };
  assert.deepEqual(prospectiveAnswers({}, legacy), legacy.answers);
  assert.equal(prospectiveAnswers({}, { categoryCode: 'SV', answers: { weight: '12,3' } }).weight, 12.3);
});

test('real prospective article requires owned reservation proof and retains private exact-SKU provenance', async () => {
  const compiled = definition(), db = database('AR','size',28);
  const hash=(await readCharacteristicConfiguration(db,'AR')).config_hash;
  const p=product('AR',{size:28},{id:null,full_sku:null,sku_schema_version_id:null,public_sku:'AG-000123'});
  const key='00000000-0000-4000-8000-000000000123';
  const originalQuery=db.query;
  db.query=async(sql,params)=>sql.includes('product_creation_sku_reservations')
    ?{rows:params[0]===21&&params[1]===key&&params[2]==='AR'&&params[3]==='AG-000123'?[{public_sku:'AG-000123'}]:[]}
    :originalQuery(sql,params);
  for(const context of [{},{actorUserId:22,idempotencyKey:key},{actorUserId:21,idempotencyKey:'00000000-0000-4000-8000-000000000124'}]){
    await assert.rejects(loadProspectiveSupportInput(db,compiled.definition,p,hash,context),{code:'SOURCE_SUPPORT_INVALID'});
  }
  const supported=await loadProspectiveSupportInput(db,compiled.definition,p,hash,{actorUserId:21,idempotencyKey:key});
  assert.deepEqual(evaluateProduct(compiled,supported).errors,[]);
  assert.ok(evaluateProduct(compiled,{...supported}).errors.some(error=>error.code==='SOURCE_SUPPORT_INVALID'));
  supported.public_sku='AG-000124';
  assert.ok(evaluateProduct(compiled,supported).errors.some(error=>error.code==='SOURCE_SUPPORT_INVALID'));
});
