const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { requirements, normalizeBindings } = require('../src/services/magento/binding-validation');
const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
const literal = value => ({ op: 'literal', value });
const source = id => ({ op: 'source', id });
const text = id => ({ op: 'text', input: source(id), trim: false, format: 'scalar-v1', onAbsent: 'empty' });
function fixture(options = {}) {
  const definition = structuredClone(fixtures.definition());
  definition.sources.price = { kind: 'product', field: 'total_price_uah', type: 'scalar' };
  definition.sources.size.key = 'braclet_size';
  const br = definition.groups.find(group => group.route === 'BR');
  br.rows[0].cells.price = text('price');
  br.rows[0].cells.decor_weight = text('weight');
  br.rows[0].cells.dovzhyna_brasletu_diuimiv = { op: 'when', if: { op: 'present', input: source('size'), policy: 'answer-v1' },
    then: text('size'), else: { op: 'error', field: 'braclet_size', message: literal('Required size') } };
  for (const group of definition.groups) group.rows[1].cells.price = literal('');
  if (options.zero) definition.tables.fixtureColors['0'] = 'Zero output';
  if (options.nativeWeight) {
    definition.outputContract = 'magento-products-columns-v2';
    definition.groups.forEach(group => { group.columnLabels = {}; group.outputChecks = []; });
    br.columns.push('weight'); br.rows[0].cells.weight = text('weight');
  }
  options.changeDefinition?.(definition);
  const compiled = compileDefinition(definition);
  const schema = structuredClone(fixtures.schema());
  schema.attributes.find(attribute => attribute.attribute_code === 'name').scope = 'store';
  for (const code of ['decor_weight', 'dovzhyna_brasletu_diuimiv']) {
    const attribute = schema.attributes.find(candidate => candidate.attribute_code === code);
    attribute.frontend_input = 'text'; attribute.options = [];
  }
  if (options.remoteRequired) schema.attributes.find(attribute => attribute.attribute_code === 'dovzhyna_brasletu_diuimiv').is_required = true;
  if (options.zero) schema.attributes.find(attribute => attribute.attribute_code === 'kolir')
    .options.push({ value: 'zero-id', label: 'Remote zero' });
  if (options.nativeWeight) {
    schema.attributes.push({ attribute_id: 906, attribute_code: 'weight', frontend_input: 'text', options: [] });
    schema.attributeSets[0].attributeCodes.push('weight');
  }
  options.changeSchema?.(schema);
  const normalizedSchema = normalizeSchema(schema);
  const plans = requirements(compiled.definition, normalizedSchema);
  const selected = plans.filter(plan => plan.amberGroup === (options.category || 'BR'));
  const remoteOptions = { 'Red output': 'red-id', 'Blue output': 'blue-id', 'Zero output': 'zero-id' };
  const bindings = { routes: plans.map(plan => ({ routeKey: plan.routeKey,
    enabled: selected.includes(plan), setId: selected.includes(plan) ? 8001 : null,
    reviewState: selected.includes(plan) ? 'approved' : 'review_required' })),
  attributes: [], options: [], policies: [] };
  for (const plan of selected) for (const attribute of plan.attributes) {
    bindings.attributes.push({ routeKey: plan.routeKey, rowId: attribute.rowId, target: attribute.target,
      strategy: attribute.strategy, attributeCode: attribute.strategy === 'transport_control' ? null : attribute.target,
      transportTarget: attribute.strategy === 'transport_control' ? 'product.' + attribute.target : null,
      reviewState: 'approved' });
    for (const option of attribute.options) bindings.options.push({ ...option,
      bindingKey: attribute.bindingKey, optionId: remoteOptions[option.evaluatedOutput], reviewState: 'approved' });
    bindings.policies.push({ bindingKey: attribute.bindingKey, storeCode: attribute.rowId === 'english' ? 'en' : 'all',
      policy: attribute.strategy === 'transport_control' ? 'magento_managed' : 'authoritative_create_update',
      reviewState: 'approved' });
  }
  const normalized = normalizeBindings(bindings);
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-2222-2222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: hash(normalizedSchema),
    topologyFingerprint: hash(normalizedSchema.storeTopology), schema: normalizedSchema, bindings: normalized };
  const product = { id: 1, category: options.category || 'BR', full_sku: 'BR-fixture', weight: '5.000', total_price_uah: '42.00',
    details: { answers: { binding_test_semantic: 7, braclet_size: '17' } } };
  const raw = { id: 81, sku: product.full_sku, attribute_set_id: 8001, name: 'Remote UA', price: '42.000',
    custom_attributes: [{ attribute_code: 'kolir', value: 'red-id' },
      { attribute_code: 'decor_weight', value: '5.0' },
      { attribute_code: 'dovzhyna_brasletu_diuimiv', value: '17' }] };
  return { observation: { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema: normalizedSchema,
  domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } },
  currencyEvidence: { verified: true, currency: 'UAH' } };
}
const field = (result, target, scope = 'all') => result.plan.fields.find(value => value.target === target && value.scope === scope);
const metadata = (result, target, scope = 'all') => result.projection.find(value => value.target === target && value.scope === scope);
const remote = (input, code, value) => { input.observation.raw.custom_attributes.find(attribute => attribute.attribute_code === code).value = value; };
test('projects approved direct sources and independent first remote names', () => {
  const result = projectFirstSyncFields(fixture());
  assert.equal(field(result, 'name').status, 'imported');
  assert.equal(field(result, 'name', 'en').status, 'imported');
  assert.equal(field(result, 'price').status, 'equal');
  assert.equal(field(result, 'decor_weight').status, 'equal');
  assert.equal(field(result, 'kolir').status, 'equal');
  assert.equal(metadata(result, 'dovzhyna_brasletu_diuimiv').persistence, 'information');
  assert.equal(metadata(result, 'decor_weight').source.field, 'weight');
  assert.equal(metadata(result, 'price').source.definitionHash, fixture().observation.amber.compiled.hash);
  assert.equal(result.readyForOutbound, true);
  assert.equal(result.complete, false);
});
test('direct information imports require the runtime catalog validator and exact source metadata', () => {
  const input = fixture(); delete input.observation.amber.product.details.answers.braclet_size;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').status, 'imported');
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').importValue, '17');
  const item = metadata(result, 'dovzhyna_brasletu_diuimiv');
  assert.equal(item.requiresRuntimeValidation, true);
  assert.equal(item.storagePath, 'details.answers.braclet_size');
  assert.equal(item.source.routeKey, 'BR:all');
  assert.match(item.mappingHash, /^[a-f0-9]{64}$/);
});

test('allowlisted trimmed information imports only already canonical exact text', () => {
  for(const value of ['17',' 17 ',17]){
    const input=fixture({changeDefinition:d=>{d.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv.then.trim=true;}});
    delete input.observation.amber.product.details.answers.braclet_size;
    remote(input,'dovzhyna_brasletu_diuimiv',value);
    const result=projectFirstSyncFields(input),decision=field(result,'dovzhyna_brasletu_diuimiv');
    assert.equal(metadata(result,'dovzhyna_brasletu_diuimiv').persistence,'information');
    assert.equal(decision.status,value==='17'?'imported':'review_required');
    if(value!=='17')assert.equal(metadata(result,'dovzhyna_brasletu_diuimiv').reason,'CANONICAL_INFORMATION_VALUE_NORMALIZED');
  }
});
test('trimmed transformed or non-information text cannot become a canonical setter', () => {
  const input=fixture({changeDefinition:d=>{d.groups[0].rows[0].cells.decor_weight={op:'text',trim:true,format:'scalar-v1',onAbsent:'empty',input:source('weight')};}});
  assert.equal(metadata(projectFirstSyncFields(input),'decor_weight').persistence,'derived');
});
test('exact same-source presence guards with empty fallbacks remain direct', () => {
  const input = fixture({ changeDefinition: definition => {
    definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv.else = literal('');
  } });
  delete input.observation.amber.product.details.answers.braclet_size;
  assert.equal(field(projectFirstSyncFields(input), 'dovzhyna_brasletu_diuimiv').status, 'imported');
});
test('source references and same-source require wrappers retain the information target', () => {
  const input = fixture({ changeDefinition: definition => {
    definition.bindings.push({ id: 'fixture.size', group: 'BR', value: text('size') });
    definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv = {
      op: 'require', if: { op: 'present', input: source('size'), policy: 'answer-v1' }, value: { op: 'ref', id: 'fixture.size' },
      error: { op: 'error', field: 'size', message: literal('Required') } };
  } });
  assert.equal(metadata(projectFirstSyncFields(input), 'dovzhyna_brasletu_diuimiv').persistence, 'information');
});
test('arbitrary conditionals and firstPresent never reverse into a canonical source', () => {
  for (const cell of [
    { op: 'when', if: { op: 'eq', left: source('color'), right: literal(7) }, then: text('size'), else: literal('') },
    { op: 'firstPresent', items: [text('size'), text('weight')], policy: 'answer-v1' },
  ]) {
    const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv = cell; } });
    delete input.observation.amber.product.details.answers.braclet_size;
    const result = projectFirstSyncFields(input);
    assert.equal(metadata(result, 'dovzhyna_brasletu_diuimiv').persistence, 'derived');
    assert.notEqual(field(result, 'dovzhyna_brasletu_diuimiv').status, 'imported');
  }
});
test('derived forward output can establish equality without recovering its inputs', () => {
  const input = fixture({ changeDefinition: definition => {
    definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv = { op: 'join', items: [text('size'), text('weight')], delimiter: '/', omitEmpty: true };
  } });
  remote(input, 'dovzhyna_brasletu_diuimiv', '17/5.000');
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').status, 'equal');
  assert.equal(metadata(result, 'dovzhyna_brasletu_diuimiv').persistence, 'derived');
});
test('current approved option forward equality tolerates many-to-one mappings', () => {
  const input = fixture();
  input.observation.amber.product.details.answers.binding_test_semantic = 9;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'kolir').status, 'equal');
  assert.equal(result.fields.find(value => value.target === 'kolir').local.forwardOptionId, 'red-id');
  assert.equal(result.fields.find(value => value.target === 'kolir').reverseCandidates.filter(value => value.optionId === 'red-id').length, 2);
});
test('unique reverse option candidates still require a safe characteristic setter', () => {
  const input = fixture(); delete input.observation.amber.product.details.answers.binding_test_semantic;
  remote(input, 'kolir', 'blue-id');
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'kolir').status, 'review_required');
  assert.equal(field(result, 'kolir').evidenceReason, 'HISTORICAL_IDENTITY_CHARACTERISTIC_IMPORT_UNSUPPORTED');
  assert.equal(metadata(result, 'kolir').persistence, 'characteristic');
});
test('option zero is present and forward equality does not require label guessing', () => {
  const input = fixture({ zero: true });
  input.observation.amber.product.details.answers.binding_test_semantic = 0;
  remote(input, 'kolir', 'zero-id');
  assert.equal(field(projectFirstSyncFields(input), 'kolir').status, 'equal');
});
test('scalar false and zero remain populated data in text information', () => {
  for (const value of [false, 0]) {
    const input = fixture(); input.observation.amber.product.details.answers.braclet_size = value;
    remote(input, 'dovzhyna_brasletu_diuimiv', String(value));
    assert.equal(field(projectFirstSyncFields(input), 'dovzhyna_brasletu_diuimiv').status, 'equal');
  }
});
test('required weight zero is present but violates the positive canonical contract', () => {
  const input = fixture(); input.observation.amber.product.weight = 0; remote(input, 'decor_weight', 0);
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'decor_weight').status, 'review_required');
  assert.equal(field(result, 'decor_weight').reason, 'REMOTE_DECIMAL_OUT_OF_RANGE');
});
test('legacy weight import remains reviewed while retaining the exact gram contract', () => {
  const input = fixture(); delete input.observation.amber.product.weight;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'decor_weight').status, 'review_required');
  assert.equal(field(result, 'decor_weight').evidenceReason, 'FIRST_SYNC_CANONICAL_NATIVE_VERSION_REQUIRED');
  const projected = result.fields.find(value => value.target === 'decor_weight');
  assert.equal(projected.unit, 'g'); assert.equal(projected.scale, 3);
  assert.equal(metadata(result, 'decor_weight').mirrorAnswerKey, 'weight');
  assert.equal(metadata(result, 'decor_weight').requiresRuntimeValidation, true);
});
test('divergent physical and answer weights never become an import', () => {
  const input = fixture(); input.observation.amber.product.details.answers.weight = '6';
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'decor_weight').evidenceReason, 'CANONICAL_WEIGHT_ANSWER_INCOHERENT');
});
test('price adoption needs verified UAH evidence and preserves the manual-price setter contract', () => {
  const input = fixture(); delete input.currencyEvidence;
  assert.equal(field(projectFirstSyncFields(input), 'price').evidenceReason, 'PRICE_CURRENCY_UAH_NOT_PROVEN');
  input.currencyEvidence = { verified: true, currency: 'UAH' };
  delete input.observation.amber.product.total_price_uah;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'price').importValue, '42');
  assert.equal(metadata(result, 'price').setterContract, 'manual-UAH-scale2-preserve-server-pricing-baseline');
});
test('decimal comparison is exact comma/dot and trailing-zero normalization without rounding', () => {
  const input = fixture(); input.observation.amber.product.total_price_uah = '42,0000';
  assert.equal(field(projectFirstSyncFields(input), 'price').status, 'equal');
  input.observation.raw.price = '42.001';
  assert.equal(field(projectFirstSyncFields(input), 'price').reason, 'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
});
test('failed EN reads stay unknown while UA adoption remains independent', () => {
  const input = fixture(); input.observation.domainEvidence.failures = [{ code: 'STORE_VIEW_READ_UNAVAILABLE', operation: 'storeViews' }];
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'name').status, 'imported');
  assert.equal(field(result, 'name', 'en').status, 'unknown');
  assert.equal(metadata(result, 'name', 'en').readReason, 'EN_REMOTE_READ_FAILED');
  assert.equal(result.readyForOutbound, false);
});
test('partial EN identity, wrong product and changed scope cannot establish remote emptiness', () => {
  for (const mutate of [
    input => { delete input.observation.domainEvidence.english.id; },
    input => { input.observation.domainEvidence.english.sku = 'other'; },
    input => { input.observation.schema = structuredClone(input.observation.schema); input.observation.schema.storeTopology.storeViews[0].id++; },
  ]) {
    const input = fixture(); mutate(input);
    assert.equal(field(projectFirstSyncFields(input), 'name', 'en').status, 'unknown');
  }
});
test('null remote names preserve populated local names for guarded outward', () => {
  const input = fixture(); input.observation.raw.name = null; input.observation.domainEvidence.english.fields.name = '';
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'name').status, 'pending_outward_confirmation');
  assert.equal(field(result, 'name', 'en').status, 'pending_outward_confirmation');
});
test('per-language receipt preserves later local edits without initializing EN', () => {
  const input = fixture(); input.receipts = { 'all/name': { state: 'name_received' } };
  input.observation.amber.product.magento_name_override = {
    generated: { all: 'Fixture name', en: 'Fixture name' }, values: { all: 'Later edit', en: 'Earlier EN' } };
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'name').ordinaryReconciliation, true);
  assert.equal(result.fields.find(value => value.target === 'name' && value.scope === 'all').local.value, 'Later edit');
  assert.equal(field(result, 'name', 'en').status, 'imported');
  assert.equal(result.complete, false);
  assert.equal(result.plan.progress.received, 1);
});
test('bounded invalid old full name can be replaced with an exact before-CAS value', () => {
  const input = fixture(); const invalidName = 'x'.repeat(1500);
  input.observation.amber.product.magento_name_override = {
    generated: { all: 'Fixture name', en: 'Fixture name' }, values: { all: invalidName, en: 'Valid EN' } };
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'name').status, 'imported');
  assert.equal(field(result, 'name').before.value, invalidName);
});
test('unrelated local price failure does not gate information or first name imports', () => {
  const input = fixture(); delete input.observation.amber.product.total_price_uah;
  delete input.observation.amber.product.details.answers.braclet_size;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'name').status, 'imported');
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').status, 'imported');
});
test('unpublished, stale hash and JSON-cloned compiled definitions are rejected', () => {
  for (const mutate of [
    input => { input.observation.amber.revision.state = 'draft'; },
    input => { input.observation.amber.revision.definitionHash = '0'.repeat(64); },
    input => { input.observation.amber.compiled = structuredClone(input.observation.amber.compiled); },
  ]) {
    const input = fixture(); mutate(input);
    const result = projectFirstSyncFields(input);
    assert.equal(result.mode, 'review_required'); assert.equal(result.fields.length, 0);
  }
});
test('changed AST without its approved publication evidence is rejected', () => {
  const input = fixture(); const changed = structuredClone(input.observation.amber.compiled.definition);
  changed.groups[0].rows[0].cells.price = literal('100');
  input.observation.amber.compiled = compileDefinition(changed);
  assert.equal(projectFirstSyncFields(input).blockers[0].code, 'PUBLISHED_DEFINITION_BINDING_IDENTITY_MISMATCH');
});
test('unchanged category has no route when remote set differs', () => {
  const input = fixture(); input.observation.raw.attribute_set_id = 8002;
  assert.equal(projectFirstSyncFields(input).blockers[0].code, 'CATEGORY_REMOTE_ROUTE_NOT_APPROVED');
  assert.equal(input.observation.amber.product.category, 'BR');
});
test('two approved same-set routes use the exact known local predicate; unknown never selects a negative branch', () => {
  const input = fixture({ changeDefinition: definition => {
    const route = { op: 'when', if: { op: 'eq', left: { op: 'semanticKey', input: source('color') }, right: literal('7') },
      then: literal('Set A'), else: literal('Set B') };
    definition.groups[0].rows.forEach(row => { row.cells.attribute_set_code = route; });
  } });
  assert.equal(projectFirstSyncFields(input).route.routeKey,'BR.binding_test_semantic=value_id:7');
  input.observation.amber.product.details.answers.binding_test_semantic=8;
  assert.equal(projectFirstSyncFields(input).route.routeKey,'BR.binding_test_semantic!=value_id:7');
  for(const value of [undefined,null,'','invalid',7.1,true,'07']){
    input.observation.amber.product.details.answers.binding_test_semantic=value;
    assert.equal(projectFirstSyncFields(input).blockers[0].code,'CATEGORY_REMOTE_ROUTE_NOT_APPROVED');
  }
});

test('known conditional route still requires its own approval, enabled state and remote set',()=>{
  for(const change of ['disabled','review','set']){
    const input=fixture({changeDefinition:d=>{const route={op:'when',if:{op:'eq',left:{op:'semanticKey',input:source('color')},right:literal('7')},then:literal('Set A'),else:literal('Set B')};d.groups[0].rows.forEach(r=>{r.cells.attribute_set_code=route;});}});
    const chosen=input.observation.amber.revision.bindings.routes.find(r=>r.routeKey==='BR.binding_test_semantic=value_id:7');
    if(change==='disabled')chosen.enabled=false;if(change==='review')chosen.reviewState='review_required';if(change==='set')input.observation.raw.attribute_set_id=8002;
    assert.equal(projectFirstSyncFields(input).blockers[0].code,'CATEGORY_REMOTE_ROUTE_NOT_APPROVED');
  }
});

test('actual published schema6 routes share151 but select the proved souvenir branch and exact size expression',()=>{
  const real=require('./fixtures/legacy-sv-schema6'),p=real.publication(),compiled=compileDefinition(p.definition),schema=normalizeSchema(p.schema);
  const revision={id:'11111111-1111-1111-1111-111111111111',state:'published',templateVersionId:'22222222-2222-2222-2222-222222222222',definitionHash:compiled.hash,evaluatorVersion:compiled.definition.evaluatorVersion,outputContract:compiled.definition.outputContract,formatVersion:compiled.definition.formatVersion,schemaFingerprint:hash(schema),topologyFingerprint:hash(schema.storeTopology),schema,bindings:normalizeBindings(p.bindings)};
  for(const [id,routeKey] of [[1919,'SV.souvenir!=value_id:5'],[2198,'SV.souvenir=value_id:5']]){
    const product=real.product(id);delete product.details.answers.size;
    const raw={id:123,sku:product.full_sku,attribute_set_id:151,custom_attributes:[{attribute_code:'rozmir_suveniriv',value:'12/5/3'}]};
    const observation={amber:{product,compiled,revision,template:{kind:'published',versionId:revision.templateVersionId,definitionHash:compiled.hash}},raw,schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:'Fixture EN'}},failures:[]}};
    const projected=projectFirstSyncFields({observation});assert.equal(projected.route.routeKey,routeKey);
    assert.equal(metadata(projected,'rozmir_suveniriv').persistence,'information');assert.equal(field(projected,'rozmir_suveniriv').importValue,'12/5/3');
  }
});
test('attribute identity drift blocks reused option IDs', () => {
  const input = fixture(); input.observation.schema = structuredClone(input.observation.schema);
  input.observation.schema.attributes.find(attribute => attribute.attribute_code === 'kolir').attribute_id += 100;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'kolir').evidenceReason, 'ATTRIBUTE_ID_CHANGED');
});
test('same native option ID with different evaluated outputs is rejected as invalid binding evidence', () => {
  const input = fixture(); input.observation.amber.revision.bindings = structuredClone(input.observation.amber.revision.bindings);
  input.observation.amber.revision.bindings.options.find(option => option.evaluatedOutput === 'Blue output').optionId = 'red-id';
  assert.equal(projectFirstSyncFields(input).blockers[0].code, 'BINDING_OR_SCHEMA_EVIDENCE_INVALID');
});
test('unapproved outbound policy prevents pending outward becoming write-ready', () => {
  const input = fixture(); remote(input, 'dovzhyna_brasletu_diuimiv', '');
  const target = input.observation.amber.revision.bindings.attributes.find(attribute => attribute.target === 'dovzhyna_brasletu_diuimiv');
  input.observation.amber.revision.bindings.policies.find(policy => policy.bindingKey === target.bindingKey).policy = 'magento_managed';
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').evidenceReason, 'OUTWARD_POLICY_NOT_AUTHORITATIVE');
  assert.equal(result.readyForOutbound, false);
});
test('unknown/multiselect raw value remains unknown and cannot become empty', () => {
  const input = fixture(); remote(input, 'kolir', ['red-id']);
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'kolir').status, 'unknown');
  assert.equal(metadata(result, 'kolir').reason, 'REMOTE_VALUE_TYPE_UNSUPPORTED');
});
test('duplicate custom attributes, accessor inputs and receipt identity spoofing fail bounded validation', () => {
  const duplicate = fixture(); duplicate.observation.raw.custom_attributes.push({ attribute_code: 'kolir', value: 'blue-id' });
  assert.throws(() => projectFirstSyncFields(duplicate), { code: 'FIRST_SYNC_PROJECTION_INPUT_INVALID' });
  const accessor = fixture(); Object.defineProperty(accessor.observation.raw, 'name', { get() { throw Error('Must not execute'); } });
  assert.throws(() => projectFirstSyncFields(accessor), { code: 'FIRST_SYNC_PROJECTION_INPUT_INVALID' });
  const receipt = fixture(); receipt.receipts = [{ target: 1, scope: 'all', state: 'equal' }];
  assert.throws(() => projectFirstSyncFields(receipt), { code: 'FIRST_SYNC_PROJECTION_INPUT_INVALID' });
});
test('receipt array and map share stable target/scope keys independently of mapping hash', () => {
  const input = fixture(); input.receipts = [{ target: 'name', scope: 'all', state: 'outward_verified' }];
  const first = projectFirstSyncFields(input);
  input.receipts = { 'all/name': { state: 'outward_verified' } };
  assert.deepEqual(projectFirstSyncFields(input).plan, first.plan);
});
test('new remote absence returns create mode without fake first-sync initialization', () => {
  const input = fixture(); input.observation.raw = null;
  const result = projectFirstSyncFields(input);
  assert.equal(result.mode, 'create'); assert.equal(result.complete, false); assert.equal(result.plan, null);
});
test('no photos are claimed adopted and original inputs remain unchanged', () => {
  const input = fixture(); const before = JSON.stringify(input);
  const result = projectFirstSyncFields(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.coverage.fullProductAdoption, false);
  assert.equal(result.coverage.photos, 'unsupported_without_url_import');
});

test('explicit failed currency evidence yields price review, never fabricated UAH', () => {
  const input = fixture(); input.currencyEvidence = { verified: false, reason: 'STORE_CONFIG_READ_FAILED' };
  assert.equal(field(projectFirstSyncFields(input), 'price').evidenceReason, 'PRICE_CURRENCY_UAH_NOT_PROVEN');
});
test('required guarded information cannot complete while both sides are empty', () => {
  const input = fixture(); delete input.observation.amber.product.details.answers.braclet_size;
  remote(input, 'dovzhyna_brasletu_diuimiv', '');
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').status, 'review_required');
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').reason, 'REQUIRED_FIELD_EMPTY');
  assert.equal(result.readyForOutbound, false);
});
test('forward option validation preserves original private immutable source proof', async () => {
  const { projectSupportProducts } = require('../src/services/export-templates/source-support');
  const ownership = require('../src/services/magento/native-identity-ownership');
  const input = fixture({ category: 'NM', changeDefinition: definition => {
    const br = definition.groups.find(group => group.route === 'BR');
    const nm = definition.groups.find(group => group.route === 'NM');
    nm.rows[0].cells.kolir = br.rows[0].cells.kolir;
    br.rows[0].cells.kolir = literal('');
    definition.sources.color.category = 'NM'; definition.sources.color.key = 'extra';
    definition.sources.sku.field = 'public_sku';
    definition.outputContract = 'magento-products-columns-v2';
    definition.groups.forEach(group => { group.columnLabels = {}; group.outputChecks = []; });
    definition.evaluatorVersion = 'magento-declarative-5';
    definition.sourceContractVersion = 'public-product-characteristics-v1';
    definition.questionContracts.extra = { source: 'color', exists: true, required: false, rule: {}, allowed: ['7', '8', '9'] };
    definition.sourceSupport = { version: 'historical-source-support-v1',
      sources: { 'NM.extra': { semanticValues: ['7', '8', '9'], deferredValues: [], placeholder: 'numeric-zero-v1' } } };
  } });
  const amber = input.observation.amber;
  const original = { ...amber.product, public_sku: 'AG-fixture', full_sku: null,
    characteristic_version_id: 12, public_product_identity_id: 3,
    details: { answers: { extra: 7 } } };
  amber.product = projectSupportProducts([original], [], [{ id: 12, category_code: 'NM',
    questions: [{ key: 'extra', options: [{ value_id: 7 }, { value_id: 8 }, { value_id: 9 }] }] }])[0];
  input.observation.raw.sku = original.public_sku;
  input.observation.domainEvidence.english.sku = original.public_sku;
  await ownership.load({ query: async () => ({ rows: [{ origin: 'legacy' }] }) }, amber, null);
  assert.equal(field(projectFirstSyncFields(input), 'kolir').status, 'equal');
  amber.product = { ...amber.product };
  assert.equal(field(projectFirstSyncFields(input), 'kolir').status, 'review_required');
});

test('Magento required information stays required even when the local AST is optional', () => {
  const input = fixture({ remoteRequired: true, changeDefinition: definition => {
    definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv.else = literal('');
  } });
  delete input.observation.amber.product.details.answers.braclet_size;
  remote(input, 'dovzhyna_brasletu_diuimiv', '');
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').reason, 'REQUIRED_FIELD_EMPTY');
  assert.equal(result.readyForOutbound, false);
});
test('changed Magento requiredness is explicit field drift before any receipt', () => {
  const input = fixture(); input.observation.schema = structuredClone(input.observation.schema);
  input.observation.schema.attributes.find(attribute => attribute.attribute_code === 'dovzhyna_brasletu_diuimiv').is_required = true;
  assert.equal(field(projectFirstSyncFields(input), 'dovzhyna_brasletu_diuimiv').evidenceReason, 'ATTRIBUTE_REQUIREDNESS_CHANGED');
});

test('derived native price literal compares exact REST numeric UAH without canonical adoption', () => {
  const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = literal('42'); } });
  input.observation.raw.price = 42; delete input.observation.amber.product.total_price_uah;
  const result = projectFirstSyncFields(input), projected = result.fields.find(value => value.target === 'price');
  assert.equal(field(result, 'price').status, 'equal');
  assert.equal(projected.kind, 'derived'); assert.equal(projected.type, 'decimal');
  assert.equal(projected.unit, 'UAH'); assert.equal(projected.scale, 2);
  assert.equal(metadata(result, 'price').persistence, 'derived');
  assert.equal(Object.hasOwn(field(result, 'price'), 'importValue'), false);
  assert.equal(Object.hasOwn(input.observation.amber.product, 'total_price_uah'), false);
});
test('derived numberText and decimalText price wrappers validate forward decimals without inverse guesses', () => {
  for (const cell of [
    { op: 'numberText', input: literal('42'), format: 'js-number-positive-v1',
      error: { op: 'error', field: 'price', message: literal('Invalid price') } },
    { op: 'decimalText', input: { op: 'firstPresent', items: [literal('42,00'), literal('50')], policy: 'answer-v1' },
      format: 'unsigned-comma-dot-v1', error: { op: 'error', field: 'price', message: literal('Invalid price') } },
  ]) {
    const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = cell; } });
    input.observation.raw.price = 42;
    const result = projectFirstSyncFields(input);
    assert.equal(field(result, 'price').status, 'equal');
    assert.equal(metadata(result, 'price').persistence, 'derived');
  }
});
test('derived native price still requires verified currency and pinned numeric price metadata', () => {
  const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = literal('42'); } });
  input.observation.raw.price = 42; delete input.currencyEvidence;
  assert.equal(field(projectFirstSyncFields(input), 'price').evidenceReason, 'PRICE_CURRENCY_UAH_NOT_PROVEN');
  input.currencyEvidence = { verified: true, currency: 'UAH' };
  input.observation.schema = structuredClone(input.observation.schema);
  input.observation.amber.revision.schema = structuredClone(input.observation.amber.revision.schema);
  for (const schema of [input.observation.schema, input.observation.amber.revision.schema]) {
    schema.attributes.find(attribute => attribute.attribute_code === 'price').frontend_input = 'text';
  }
  input.observation.amber.revision.schemaFingerprint = hash(normalizeSchema(input.observation.amber.revision.schema));
  assert.equal(field(projectFirstSyncFields(input), 'price').evidenceReason, 'PRICE_NATIVE_DECIMAL_CONTRACT_NOT_PROVEN');
});
test('derived native price mismatch and invalid scale stay exact; empty remote is guarded outward only', () => {
  const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = literal('42'); } });
  input.observation.raw.price = 43;
  assert.equal(field(projectFirstSyncFields(input), 'price').reason, 'DERIVED_FORWARD_MISMATCH');
  input.observation.raw.price = 42.001;
  assert.equal(field(projectFirstSyncFields(input), 'price').reason, 'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
  input.observation.raw.price = null;
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'price').status, 'pending_outward_confirmation');
  assert.equal(field(result, 'price').outwardValue, '42');
  assert.equal(field(result, 'price').requiresGuardedOutward, true);
  assert.equal(Object.hasOwn(field(result, 'price'), 'importValue'), false);
});
test('invalid derived price prospective output cannot complete a receipt', () => {
  const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = literal('42.001'); } });
  input.observation.raw.price = 42;
  assert.equal(field(projectFirstSyncFields(input), 'price').reason, 'LOCAL_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
});
test('native Magento weight is ignored while custom gram weight keeps its canonical validation contract', () => {
  const input = fixture({ nativeWeight: true });
  input.observation.raw.weight = 999;
  const result = projectFirstSyncFields(input);
  assert.equal(result.fields.some(value => value.target === 'weight'), false);
  assert.deepEqual(result.coverage.fields.find(value => value.target === 'weight'),
    { target: 'weight', scope: 'all', state: 'ignored', reason: 'NATIVE_MAGENTO_WEIGHT_NOT_A_CANONICAL_GRAM_SOURCE' });
  assert.equal(field(result, 'decor_weight').status, 'equal');
  assert.equal(metadata(result, 'decor_weight').persistence, 'weight');
  assert.equal(result.fields.find(value => value.target === 'decor_weight').unit, 'g');
  assert.equal(metadata(result, 'decor_weight').requiresRuntimeValidation, true);
});

test('empty remote derived price needs an authoritative ordinary outward policy', () => {
  const input = fixture({ changeDefinition: definition => { definition.groups[0].rows[0].cells.price = literal('42'); } });
  input.observation.raw.price = null;
  const binding = input.observation.amber.revision.bindings.attributes.find(attribute => attribute.target === 'price' && attribute.rowId === 'base');
  input.observation.amber.revision.bindings.policies.find(policy => policy.bindingKey === binding.bindingKey).policy = 'magento_managed';
  const result = projectFirstSyncFields(input);
  assert.equal(field(result, 'price').evidenceReason, 'OUTWARD_POLICY_NOT_AUTHORITATIVE');
  assert.equal(result.readyForOutbound, false);
});
test('plain numeric information keeps text review without a proved numeric unit contract', () => {
  const input = fixture(); remote(input, 'dovzhyna_brasletu_diuimiv', 17);
  const result = projectFirstSyncFields(input);
  assert.equal(result.fields.find(value => value.target === 'dovzhyna_brasletu_diuimiv').type, 'text');
  assert.equal(field(result, 'dovzhyna_brasletu_diuimiv').reason, 'REMOTE_TEXT_INVALID');
});

function localizedDerivedFixture(cell = literal('English SEO')) {
  const input=fixture({changeDefinition:definition=>{
    definition.groups.find(group=>group.route==='BR').rows[1].cells.dovzhyna_brasletu_diuimiv=cell;
  },changeSchema:schema=>{
    schema.attributes.find(attribute=>attribute.attribute_code==='dovzhyna_brasletu_diuimiv').scope='store';
  }});
  input.observation.domainEvidence.english.fields.dovzhyna_brasletu_diuimiv='English SEO';
  return input;
}
test('derived English store equality proves only fresh forward output without importing canonical data',()=>{
  const result=projectFirstSyncFields(localizedDerivedFixture());
  const selected=field(result,'dovzhyna_brasletu_diuimiv','en');
  assert.equal(selected.status,'equal');
  assert.equal(selected.reason,'DERIVED_FORWARD_EQUAL');
  assert.equal(metadata(result,'dovzhyna_brasletu_diuimiv','en').persistence,'derived');
  assert.equal(Object.hasOwn(selected,'importValue'),false);
  const prepared=require('../src/services/magento/first-sync-progress-plan').prepareProgress(result,null);
  assert.equal(prepared.rows.find(row=>row.target===selected.target&&row.scope==='en').record.state,'equal');
});
test('derived English mismatch remains review and has no Admin reverse-import choice',()=>{
  const input=localizedDerivedFixture();input.observation.domainEvidence.english.fields.dovzhyna_brasletu_diuimiv='Different SEO';
  const result=projectFirstSyncFields(input);
  const selected=field(result,'dovzhyna_brasletu_diuimiv','en');
  assert.equal(selected.status,'review_required');assert.equal(selected.reason,'DERIVED_FORWARD_MISMATCH');
  const prepared=require('../src/services/magento/first-sync-progress-plan').prepareProgress(result,null);
  const row=prepared.rows.find(row=>row.target===selected.target&&row.scope==='en');
  assert.equal(row.canAcceptRemote,false);assert.equal(row.canKeepLocal,false);assert.equal(prepared.complete,false);
});
test('empty English derived remote allows guarded outward only with an authoritative policy',()=>{
  const input=localizedDerivedFixture();input.observation.domainEvidence.english.fields.dovzhyna_brasletu_diuimiv='';
  let result=projectFirstSyncFields(input),selected=field(result,'dovzhyna_brasletu_diuimiv','en');
  assert.equal(selected.status,'pending_outward_confirmation');assert.equal(selected.requiresGuardedOutward,true);
  assert.equal(Object.hasOwn(selected,'importValue'),false);
  const binding=input.observation.amber.revision.bindings.attributes.find(row=>row.target===selected.target&&row.rowId==='english');
  input.observation.amber.revision.bindings.policies.find(row=>row.bindingKey===binding.bindingKey).policy='magento_managed';
  result=projectFirstSyncFields(input);selected=field(result,selected.target,'en');
  assert.equal(selected.status,'review_required');assert.equal(selected.evidenceReason,'OUTWARD_POLICY_NOT_AUTHORITATIVE');
});
test('unknown English read cannot become derived equality or empty completion',()=>{
  const input=localizedDerivedFixture();delete input.observation.domainEvidence.english;
  const selected=field(projectFirstSyncFields(input),'dovzhyna_brasletu_diuimiv','en');
  assert.ok(['unknown','review_required'].includes(selected.status));assert.equal(Object.hasOwn(selected,'importValue'),false);
});
test('English direct canonical information remains unsupported even when its forward output matches',()=>{
  const input=localizedDerivedFixture(text('size'));input.observation.domainEvidence.english.fields.dovzhyna_brasletu_diuimiv='17';
  const selected=field(projectFirstSyncFields(input),'dovzhyna_brasletu_diuimiv','en');
  assert.equal(selected.status,'review_required');assert.equal(selected.evidenceReason,'LOCALIZED_CANONICAL_SETTER_NOT_PROVEN');
});
test('English derived comparison still requires a proven store-scoped text contract',()=>{
  const input=localizedDerivedFixture();
  for(const schema of [input.observation.schema,input.observation.amber.revision.schema])
    schema.attributes.find(row=>row.attribute_code==='dovzhyna_brasletu_diuimiv').scope='global';
  input.observation.amber.revision.schemaFingerprint=hash(normalizeSchema(input.observation.amber.revision.schema));
  const selected=field(projectFirstSyncFields(input),'dovzhyna_brasletu_diuimiv','en');
  assert.equal(selected.status,'review_required');assert.equal(Object.hasOwn(selected,'importValue'),false);
});
