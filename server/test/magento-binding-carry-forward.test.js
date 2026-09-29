const assert = require('node:assert/strict');
const test = require('node:test');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { describeMapper } = require('../src/services/magento/mapper-schema');
const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const { normalizeSchema, originHash } = require('../src/services/magento/binding-contract');
const { carryReviewedBindings, collectLiveVerification } = require('../src/services/magento/binding-carry-forward');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { parse } = require('../scripts/magento-binding-carry-forward');

function candidateSchema(definition) {
  const mapper = describeMapper(definition);
  const schema = normalizeSchema({ storeCode: 'all',
    storeTopology: { websites: [{ id: 701, code: 'fixture', name: 'Fixture' }],
      storeGroups: [{ id: 702, name: 'Group', website_id: 701, root_category_id: 703, default_store_id: 704 }],
      storeViews: [{ id: 704, code: 'en', name: 'English', website_id: 701,
        store_group_id: 702, is_active: true }] },
    attributes: mapper.targets.map((target, index) => ({ attribute_code: target.target,
      attribute_id: 10000 + index,
      frontend_input: target.usages.some((usage) => usage.values.some((value) => value.kind === 'dictionary'))
        ? 'select' : 'text',
      options: [...new Set(target.usages.flatMap((usage) => usage.values.map((value) => value.label)))]
        .filter(Boolean).map((label, optionIndex) => ({ value: String(20000 + index * 100 + optionIndex), label })) })),
    attributeSets: mapper.attributeSets.map((set, index) => ({ attribute_set_id: 30000 + index,
      attribute_set_name: set.attribute_set_code,
      attributeCodes: mapper.targets.map((target) => target.target) })) });
  schema.attributeSets.push({ attribute_set_id: 39999, attribute_set_name: 'Reviewed compatibility set',
    attributeCodes: schema.attributes.map((row) => row.attribute_code) });
  return normalizeSchema(schema);
}

function fixture() {
  const legacy = compileDefinition(materializeMagentoV1(catalog()));
  const target = compileDefinition(materializeMagentoV1(catalog(), { publicSku: true }));
  const targetSchema = candidateSchema(target.definition);
  const amberTarget = { compiled: target,
    products: [product('BR', {}, { status: 'active' }), product('KL', { addit: 1 }, { status: 'active' }),
      product('SV', { souvenir: 5 }, { status: 'active' }), product('AR', { size: 28 }, { status: 'active' })],
    current: [] };
  const dynamicOutput = evaluate(amberTarget, amberTarget.products[0]).base.dovzhyna_brasletu_diuimiv;
  const dynamicAttribute = targetSchema.attributes.find((row) => row.attribute_code === 'dovzhyna_brasletu_diuimiv');
  dynamicAttribute.frontend_input = 'select';
  dynamicAttribute.options.push({ value: '49999', label: dynamicOutput });
  const targetBindings = buildCandidates(amberTarget, targetSchema, []);
  const inclusionTarget = targetBindings.options.find((row) => row.amberGroup === 'KL'
    && row.questionKey === 'addit' && row.valueId === '1');
  assert.ok(inclusionTarget?.optionId);
  const arTarget = targetBindings.options.find((row) => row.amberGroup === 'AR'
    && row.questionKey === 'size' && row.valueId === '28');
  assert.ok(arTarget?.optionId);
  const sourceSchema = structuredClone(targetSchema);
  const arAttribute = targetBindings.attributes.find((row) => row.bindingKey === arTarget.bindingKey);
  sourceSchema.attributes.find((row) => row.attribute_code === arAttribute.attributeCode).options =
    sourceSchema.attributes.find((row) => row.attribute_code === arAttribute.attributeCode)
      .options.filter((row) => row.value !== arTarget.optionId);
  const sourceBindings = buildCandidates({ ...amberTarget, compiled: legacy }, sourceSchema, []);

  for (const route of sourceBindings.routes) {
    if (route.setId !== null) { route.enabled = true; route.reviewState = 'approved'; }
  }
  const compatibilityRoute = sourceBindings.routes.find((row) => row.routeKey === 'SV.souvenir=value_id:5');
  compatibilityRoute.enabled = true;
  compatibilityRoute.setId = 39999;
  compatibilityRoute.reviewState = 'approved';
  for (const attribute of sourceBindings.attributes) if (attribute.reviewState !== 'blocked') attribute.reviewState = 'approved';
  for (const option of sourceBindings.options) if (option.optionId !== null) option.reviewState = 'approved';
  for (const policy of sourceBindings.policies) {
    const attribute = sourceBindings.attributes.find((row) => row.bindingKey === policy.bindingKey);
    policy.reviewState = 'approved';
    policy.policy = attribute.target === 'product_online' && attribute.rowId === 'base'
      ? 'initialize_create_only' : attribute.target === 'name' ? 'magento_managed' : 'authoritative_create_update';
    if (policy.policy === 'initialize_create_only') policy.evidence.createValue = 2;
  }
  for (const attribute of sourceBindings.attributes) {
    for (const category of attribute.evidence.categories || []) {
      if (category.categoryId !== null) category.reviewState = 'approved';
    }
  }
  const blockedSource = sourceBindings.options.find((row) => row.sourceKind === 'semantic'
    && row.optionId !== null && !(row.amberGroup === 'AR' && row.questionKey === 'size' && row.valueId === '28'));
  const blockedTarget = targetBindings.options.find((row) => row.bindingKey === blockedSource.bindingKey
    && row.amberGroup === blockedSource.amberGroup && row.questionKey === blockedSource.questionKey
    && row.valueId === blockedSource.valueId);
  for (const option of [blockedSource, blockedTarget]) {
    option.optionId = null; option.reviewState = 'blocked';
    option.evidence = { diagnosticCodes: ['FIXTURE_UNSUPPORTED'], candidateIds: [] };
  }
  return {
    targetDefinition: target.definition,
    source: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      originHash: originHash('https://fixture.example.invalid'), schema: normalizeSchema(sourceSchema),
      bindings: sourceBindings },
    target: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      originHash: originHash('https://fixture.example.invalid'), schema: targetSchema, bindings: targetBindings },
    arTargetOptionId: arTarget.optionId,
    inclusionTargetOptionId: inclusionTarget.optionId,
    blockedSource,
  };
}

function oneCategoryMissing(f) {
  const sourceAttribute = f.source.bindings.attributes.find((row) => row.target === 'categories'
    && row.evidence.categories?.length);
  assert.ok(sourceAttribute);
  const targetAttribute = f.target.bindings.attributes.find((row) => row.bindingKey === sourceAttribute.bindingKey);
  const sourceCategory = sourceAttribute.evidence.categories[0];
  sourceCategory.categoryId = '47003';
  sourceCategory.candidates = [{ categoryId: '47003', path: sourceCategory.normalizedPath }];
  sourceCategory.reviewState = 'approved';
  targetAttribute.evidence.categories = targetAttribute.evidence.categories
    .filter((row) => row.normalizedPath !== sourceCategory.normalizedPath);
  return { sourceAttribute, targetAttribute, sourceCategory };
}

function treeWithPath(path, leafId = 47003, duplicate = false) {
  const parts = path.split('/');
  const root = { id: 703, parent_id: 1, name: parts[0], children_data: [] };
  let parent = root;
  for (let index = 1; index < parts.length; index += 1) {
    const child = { id: index === parts.length - 1 ? leafId : 47000 + index,
      parent_id: parent.id, name: parts[index], children_data: [] };
    parent.children_data.push(child);
    parent = child;
  }
  if (duplicate) {
    const duplicateLeaf = { ...structuredClone(parent), id: 47999, parent_id: parent.parent_id };
    let duplicateParent = root;
    while (!duplicateParent.children_data.includes(parent)
      && duplicateParent.children_data.length) duplicateParent = duplicateParent.children_data[0];
    duplicateParent.children_data.push(duplicateLeaf);
  }
  return root;
}

function fakeLiveClient(f, { categoryTree, omitOption = false, changeOption = false } = {}) {
  return {
    getCategoryTree: async () => categoryTree || { id: 703, parent_id: 1, name: 'Default', children_data: [] },
    getProductAttribute: async (code) => {
      const attribute = f.target.schema.attributes.find((row) => row.attribute_code === code);
      return { attribute_id: attribute.attribute_id, attribute_code: code, frontend_input: attribute.frontend_input };
    },
    getProductAttributeOptions: async (code) => {
      const options = f.target.schema.attributes.find((row) => row.attribute_code === code).options;
      return options.filter((row) => !omitOption || row.value !== omitOption)
        .map((row) => ({ value: row.value, label: row.value === changeOption ? `${row.label} changed` : row.label }));
    },
  };
}

test('binding carry-forward preserves reviewed policies, compatibility routes, semantic approvals and refusals', () => {
  const f = fixture();
  const result = carryReviewedBindings(f.source, f.target, f.targetDefinition);
  assert.deepEqual(result.blockers, []);
  const compatibility = result.bindings.routes.find((row) => row.routeKey === 'SV.souvenir=value_id:5');
  assert.equal(compatibility.setId, 39999);
  assert.equal(compatibility.reviewState, 'approved');
  const inclusion = result.bindings.options.find((row) => row.amberGroup === 'KL'
    && row.questionKey === 'addit' && row.valueId === '1');
  assert.equal(inclusion.optionId, f.inclusionTargetOptionId);
  assert.equal(inclusion.reviewState, 'approved');
  const blocked = result.bindings.options.find((row) => row.amberGroup === f.blockedSource.amberGroup
    && row.questionKey === f.blockedSource.questionKey && row.valueId === f.blockedSource.valueId);
  assert.equal(blocked.reviewState, 'blocked');
  const ar = result.bindings.options.find((row) => row.amberGroup === 'AR'
    && row.questionKey === 'size' && row.valueId === '28');
  assert.equal(ar.optionId, f.arTargetOptionId);
  assert.equal(ar.reviewState, 'proposed');
  assert.ok(result.skipped.some((row) => row.id.includes('AR.size=value_id:28')
    && row.code === 'BLOCKED_CASE_CHANGED_OR_RESOLVED'));
  assert.ok(result.bindings.policies.every((row) => row.reviewState === 'approved'));
  assert.ok(result.bindings.policies.some((row) => row.policy === 'initialize_create_only'
    && row.evidence.createValue === 2));
  assert.ok(result.summary.policyDecisionsCarried > 0);
  assert.ok(result.summary.blockedDecisionsCarried > 0);
});

test('binding carry-forward fails closed on ambiguous matches and changed approved remote identity', () => {
  const ambiguous = fixture();
  const sourceOption = ambiguous.source.bindings.options.find((row) => row.sourceKind === 'evaluated'
    && row.reviewState === 'approved');
  const targetOption = ambiguous.target.bindings.options.find((row) => row.bindingKey === sourceOption.bindingKey
    && row.outputKey === sourceOption.outputKey && row.evaluatedOutput === sourceOption.evaluatedOutput);
  const duplicate = { ...structuredClone(targetOption), domainKey: 'f'.repeat(64),
    optionId: null, reviewState: 'review_required' };
  delete duplicate.sourceKey;
  ambiguous.target.bindings.options.push(duplicate);
  const ambiguousResult = carryReviewedBindings(ambiguous.source, ambiguous.target, ambiguous.targetDefinition);
  assert.ok(ambiguousResult.blockers.some((row) => row.code === 'AMBIGUOUS_TARGET_MATCH'));

  const changed = fixture();
  const approved = changed.source.bindings.options.find((row) => {
    const attribute = changed.source.bindings.attributes.find((candidate) => candidate.bindingKey === row.bindingKey);
    return row.sourceKind === 'semantic' && row.reviewState === 'approved' && row.optionId !== null
      && changed.target.schema.attributes.find((candidate) => candidate.attribute_code === attribute.attributeCode)
        .options.some((option) => option.value !== row.optionId);
  });
  const candidate = changed.target.bindings.options.find((row) => row.bindingKey === approved.bindingKey
    && row.sourceKind === approved.sourceKind
    && (row.sourceKind === 'semantic' ? row.valueId === approved.valueId : row.outputKey === approved.outputKey));
  candidate.optionId = changed.target.schema.attributes
    .find((row) => row.attribute_code === changed.target.bindings.attributes
      .find((attribute) => attribute.bindingKey === candidate.bindingKey).attributeCode)
    .options.find((row) => row.value !== approved.optionId).value;
  const changedResult = carryReviewedBindings(changed.source, changed.target, changed.targetDefinition);
  assert.ok(changedResult.blockers.some((row) => row.code === 'REMOTE_OPTION_IDENTITY_CHANGED'));
});

test('missing reviewed categories require an exact live full-path and ID before synthesis', async () => {
  const exact = fixture();
  const { sourceCategory } = oneCategoryMissing(exact);
  const live = await collectLiveVerification(exact.source, exact.target, exact.targetDefinition,
    { configured: true, baseUrl: 'https://fixture.example.invalid' },
    { magentoClient: fakeLiveClient(exact, { categoryTree: treeWithPath(sourceCategory.normalizedPath) }) });
  const carried = carryReviewedBindings(exact.source, exact.target, exact.targetDefinition, live);
  assert.equal(carried.blockers.some((row) => row.kind === 'category'), false);
  const category = carried.bindings.attributes.flatMap((row) => row.evidence.categories || [])
    .find((row) => row.normalizedPath === sourceCategory.normalizedPath);
  assert.equal(category.categoryId, sourceCategory.categoryId);
  assert.equal(category.reviewState, 'approved');
  assert.ok(carried.carried.some((row) => row.kind === 'category' && row.synthesized));

  for (const [name, tree, code] of [
    ['missing', { id: 703, parent_id: 1, name: 'Default', children_data: [] }, 'LIVE_CATEGORY_MISSING'],
    ['ambiguous', treeWithPath(sourceCategory.normalizedPath, 47003, true), 'LIVE_CATEGORY_AMBIGUOUS'],
    ['different', treeWithPath(sourceCategory.normalizedPath, 47004), 'LIVE_CATEGORY_ID_CHANGED'],
  ]) {
    const changed = fixture();
    oneCategoryMissing(changed);
    const evidence = await collectLiveVerification(changed.source, changed.target, changed.targetDefinition,
      { configured: true, baseUrl: 'https://fixture.example.invalid' },
      { magentoClient: fakeLiveClient(changed, { categoryTree: tree }) });
    const result = carryReviewedBindings(changed.source, changed.target, changed.targetDefinition, evidence);
    assert.ok(result.blockers.some((row) => row.code === code), name);
  }
});

test('missing reviewed dynamic output is synthesized only with target-domain and exact live option identity', async () => {
  const exact = fixture();
  const source = exact.source.bindings.options.find((row) => row.sourceKind === 'evaluated'
    && row.reviewState === 'approved' && exact.source.bindings.attributes
      .find((attribute) => attribute.bindingKey === row.bindingKey).strategy === 'dynamic_exact_label_option');
  assert.ok(source);
  exact.target.bindings.options = exact.target.bindings.options.filter((row) => !(row.bindingKey === source.bindingKey
    && row.outputKey === source.outputKey && row.evaluatedOutput === source.evaluatedOutput));
  const live = await collectLiveVerification(exact.source, exact.target, exact.targetDefinition,
    { configured: true, baseUrl: 'https://fixture.example.invalid' },
    { magentoClient: fakeLiveClient(exact) });
  const carried = carryReviewedBindings(exact.source, exact.target, exact.targetDefinition, live);
  assert.equal(carried.blockers.some((row) => row.id.includes(`evaluated:${source.outputKey}`)), false);
  const synthesized = carried.bindings.options.find((row) => row.bindingKey === source.bindingKey
    && row.outputKey === source.outputKey);
  const targetRequirement = require('../src/services/magento/binding-validation')
    .requirements(exact.targetDefinition, exact.target.schema).flatMap((row) => row.attributes)
    .find((row) => row.bindingKey === source.bindingKey);
  assert.equal(synthesized.domainKey, targetRequirement.domainKey);
  assert.notEqual(synthesized.domainKey, source.domainKey);
  assert.equal(synthesized.optionId, source.optionId);
  assert.equal(synthesized.reviewState, 'approved');

  for (const mode of ['missing', 'changed']) {
    const unsafe = fixture();
    const old = unsafe.source.bindings.options.find((row) => row.sourceKind === 'evaluated'
      && row.reviewState === 'approved' && unsafe.source.bindings.attributes
        .find((attribute) => attribute.bindingKey === row.bindingKey).strategy === 'dynamic_exact_label_option');
    unsafe.target.bindings.options = unsafe.target.bindings.options.filter((row) => !(row.bindingKey === old.bindingKey
      && row.outputKey === old.outputKey && row.evaluatedOutput === old.evaluatedOutput));
    const evidence = await collectLiveVerification(unsafe.source, unsafe.target, unsafe.targetDefinition,
      { configured: true, baseUrl: 'https://fixture.example.invalid' },
      { magentoClient: fakeLiveClient(unsafe, mode === 'missing'
        ? { omitOption: old.optionId } : { changeOption: old.optionId }) });
    const result = carryReviewedBindings(unsafe.source, unsafe.target, unsafe.targetDefinition, evidence);
    assert.ok(result.blockers.some((row) => row.code === 'DYNAMIC_OPTION_LIVE_IDENTITY_CHANGED'), mode);
  }
});

test('semantic option label drift stays explicit review work while AR resolved candidate stays proposed', () => {
  const f = fixture();
  const inclusion = f.target.bindings.options.find((row) => row.amberGroup === 'KL'
    && row.questionKey === 'addit' && row.valueId === '1');
  const attribute = f.target.bindings.attributes.find((row) => row.bindingKey === inclusion.bindingKey);
  f.target.schema.attributes.find((row) => row.attribute_code === attribute.attributeCode)
    .options.find((row) => row.value === inclusion.optionId).label += ' reviewed spelling changed';
  const result = carryReviewedBindings(f.source, f.target, f.targetDefinition);
  assert.equal(result.blockers.some((row) => row.id.includes('KL.addit=value_id:1')), false);
  assert.ok(result.skipped.some((row) => row.id.includes('KL.addit=value_id:1')
    && row.code === 'SEMANTIC_REMOTE_EVIDENCE_CHANGED_REVIEW_REQUIRED'));
  assert.equal(result.bindings.options.find((row) => row.bindingKey === inclusion.bindingKey
    && row.valueId === '1').reviewState, 'review_required');
  const ar = result.bindings.options.find((row) => row.amberGroup === 'AR'
    && row.questionKey === 'size' && row.valueId === '28');
  assert.equal(ar.optionId, f.arTargetOptionId);
  assert.equal(ar.reviewState, 'proposed');
});

test('binding carry-forward CLI requires exact source/target revisions and plan hash', () => {
  assert.deepEqual(parse(['preflight', '--expected-database', 'amber_test', '--actor-user-id', '9',
    '--source', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '--source-revision', '12',
    '--target', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '--target-revision', '3', '--output', 'plan.json']), {
    action: 'preflight', expectedDatabase: 'amber_test', actorUserId: 9,
    sourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sourceRevision: '12',
    targetId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', targetRevision: '3', output: 'plan.json',
  });
  assert.throws(() => parse(['apply', '--expected-database', 'amber_test', '--actor-user-id', '9',
    '--plan', 'plan.json']), /MAGENTO_BINDING_CARRY_ARGUMENTS/);
});
