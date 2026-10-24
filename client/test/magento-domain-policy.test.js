import assert from 'node:assert/strict';
import test from 'node:test';
import { domainPolicyGuidance } from '../src/lib/magento-domain-policy.js';

// Fresh publication-preview DTOs: the diagnostic has no policy-entry ID.
function fixture({ operation = 'storeViews', target = 'meta_title', requiredPolicy = 'authoritative_create_update',
  rowId = 'english', storeCode = 'en' } = {}) {
  const problem = { code: 'DOMAIN_POLICY_REVIEW_REQUIRED', operation, target, requiredPolicy };
  const context = {
    productId: 42, currentPublishedId: 'published-2',
    review: { bindingRevisionId: 'draft-7', expectedRevision: 7, expectedCurrentId: 'published-2',
      checked: [{ kind: 'current', productId: 42, group: 'BR', routeKey: 'BR:all', blockers: [problem] }] },
    revision: { id: 'draft-7', revision: 7, state: 'draft', schema: { attributes: [] }, bindings: {
      attributes: [{ bindingKey: 'returned-key-EN', routeKey: 'BR:all', rowId, target, reviewState: 'approved' }],
      policies: [{ bindingKey: 'returned-key-EN', storeCode, policy: 'blocked', reviewState: 'blocked' }],
    } },
  };
  return { problem, context };
}

function resultOf({ problem, context }) { return domainPolicyGuidance(problem, context); }
function queryOf(result) {
  const url = new URL(result.href, 'https://amber.test');
  assert.equal(url.origin, 'https://amber.test');
  assert.equal(url.hash, '');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}
function assertGeneral(result) {
  assert.equal(result.exact, false);
  assert.equal(result.linkLabel, 'Переглянути всі правила категорії');
  assert.deepEqual(queryOf(result), { path: '/admin/magento/categories/BR', query: {
    binding: 'draft-7', source: 'published-2', review: 'policies', category: 'BR', productId: '42',
  } });
}
function assertGlobal(result) {
  assert.equal(result.exact, false);
  assert.equal(result.href, '/admin/magento');
  assert.equal(result.linkLabel, 'Переглянути налаштування інтеграції');
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('domain guidance accepts only the exact structured diagnostic code', () => {
  for (const problem of [null, undefined, 'DOMAIN_POLICY_REVIEW_REQUIRED', {},
    { code: 'DOMAIN_POLICY_REVIEW_REQUIRED:meta_title' }, { code: 'FIELD_POLICY_REQUIRED' },
    { code: 'constructor' }, { code: ['DOMAIN_POLICY_REVIEW_REQUIRED'] }]) {
    assert.equal(domainPolicyGuidance(problem, fixture().context), null);
  }
});

test('fresh EN diagnostic resolves one returned policy through the exact tuple, never a constructed entry ID', () => {
  const input = fixture();
  input.context.revision.bindings.attributes.unshift(
    { bindingKey: 'same-target-UA', routeKey: 'BR:all', rowId: 'base', target: 'meta_title' },
    { bindingKey: 'same-target-other-route', routeKey: 'BR.size=value_id:0', rowId: 'english', target: 'meta_title' });
  input.context.revision.bindings.policies.unshift(
    { bindingKey: 'same-target-UA', storeCode: 'all', policy: 'authoritative_create_update' },
    { bindingKey: 'same-target-other-route', storeCode: 'en', policy: 'authoritative_create_update' });
  const result = resultOf(input);
  assert.equal(result.exact, true);
  assert.equal(result.operationLabel, 'Передавання англійською');
  assert.equal(result.fieldLabel, 'SEO заголовок');
  assert.equal(result.scopeLabel, 'EN');
  assert.equal(result.policyLabel, 'Оновлюється з менеджера');
  assert.equal(result.linkLabel, 'Переглянути правило передавання');
  assert.deepEqual(queryOf(result), { path: '/admin/magento/categories/BR', query: {
    binding: 'draft-7', source: 'published-2', review: 'policies', category: 'BR', productId: '42',
    route: 'BR:all', language: 'english', reviewField: 'meta_title', reviewStore: 'en',
  } });
});

for (const [target, label] of [['qty', 'Кількість на складі'], ['is_in_stock', 'Наявність на складі']]) {
  test(`inventory ${target} requires initialization in base/all, without suggesting an EN or stock UPDATE policy`, () => {
    const result = resultOf(fixture({ operation: 'inventory', target, requiredPolicy: 'initialize_create_only', rowId: 'base', storeCode: 'all' }));
    assert.equal(result.exact, true);
    assert.equal(result.operationLabel, 'Початкові залишки');
    assert.equal(result.fieldLabel, label);
    assert.equal(result.scopeLabel, 'UA / основний магазин');
    assert.equal(result.policyLabel, 'Заповнюється лише для нового товару');
    assert.equal(queryOf(result).query.language, 'base');
    assert.equal(queryOf(result).query.reviewStore, 'all');
  });
}

test('website membership uses its own base/all authoritative policy', () => {
  const result = resultOf(fixture({ operation: 'websites', target: 'product_websites', rowId: 'base', storeCode: 'all' }));
  assert.equal(result.exact, true);
  assert.equal(result.operationLabel, 'Належність до вебсайтів');
  assert.equal(result.scopeLabel, 'UA / основний магазин');
  assert.equal(result.policyLabel, 'Оновлюється з менеджера');
  assert.equal(queryOf(result).query.reviewField, 'product_websites');
  assert.equal(queryOf(result).query.reviewStore, 'all');
});

for (const target of ['sku', 'product_type', 'attribute_set_code', 'store_view_code']) {
  test(`EN identity control ${target} requires Magento-managed policy rather than authoritative content`, () => {
    const result = resultOf(fixture({ target, requiredPolicy: 'magento_managed' }));
    assert.equal(result.exact, true);
    assert.equal(result.scopeLabel, 'EN');
    assert.equal(result.policyLabel, 'Вручну в Magento');
    assert.equal(queryOf(result).query.reviewField, target);
    assert.equal(queryOf(result).query.reviewStore, 'en');
  });
}

test('actual non-control EN targets use their exact code without inherited labels', () => {
  for (const target of ['custom_caption', 'constructor', 'toString']) {
    const result = resultOf(fixture({ target }));
    assert.equal(result.exact, true);
    assert.equal(result.fieldLabel, target);
    assert.equal(queryOf(result).query.reviewField, target);
    assert.equal(typeof result.message, 'string');
    assert.ok(!result.message.includes('[native code]'));
  }
});

test('wrong or unconfirmed saved policy still has a real row to review and is never corrected by guidance', () => {
  for (const [policy, reviewState] of [['blocked', 'blocked'], ['initialize_create_only', 'approved'], ['magento_managed', 'review_required']]) {
    const input = fixture();
    Object.assign(input.context.revision.bindings.policies[0], { policy, reviewState });
    const before = structuredClone(input);
    assert.equal(resultOf(input).exact, true);
    assert.deepEqual(input, before);
  }
});

test('explicit null current publication permits a first-publication tuple without inventing source', () => {
  for (const currentPublishedId of [null, undefined]) {
    const input = fixture();
    input.context.currentPublishedId = currentPublishedId;
    input.context.review.expectedCurrentId = null;
    const result = resultOf(input);
    assert.equal(result.exact, true);
    assert.equal(queryOf(result).query.source, undefined);
    assert.equal(queryOf(result).query.binding, 'draft-7');
    assert.equal(queryOf(result).query.reviewField, 'meta_title');
  }
});

test('absent or malformed current-publication header is not equivalent to explicit null', () => {
  for (const amend of [
    (input) => { delete input.context.review.expectedCurrentId; input.context.currentPublishedId = null; },
    (input) => { input.context.review.expectedCurrentId = undefined; input.context.currentPublishedId = undefined; },
    (input) => { input.context.review.expectedCurrentId = ''; input.context.currentPublishedId = ''; },
    (input) => { input.context.review.expectedCurrentId = null; },
    (input) => { input.context.currentPublishedId = null; },
  ]) {
    const input = fixture(); amend(input); assertGlobal(resultOf(input));
  }
});

test('reviewed binding and counter must both match the displayed revision', () => {
  for (const amend of [
    (input) => { input.context.review.bindingRevisionId = 'other-draft'; },
    (input) => { input.context.review.expectedRevision = 8; },
    (input) => { input.context.review.expectedRevision = '8'; },
    (input) => { input.context.review.expectedRevision = '07'; },
    (input) => { delete input.context.review.expectedRevision; },
    (input) => { input.context.review.expectedCurrentId = 'other-publication'; },
    (input) => { input.context.revision.revision = 0; input.context.review.expectedRevision = 0; },
    (input) => { input.context.revision.revision = Number.MAX_SAFE_INTEGER + 1; input.context.review.expectedRevision = input.context.revision.revision; },
  ]) {
    const input = fixture(); amend(input); assertGlobal(resultOf(input));
  }
});

test('canonical numeric and string counters identify the same reviewed revision without rounding large string counters', () => {
  const input = fixture();
  input.context.review.expectedRevision = '7';
  assert.equal(resultOf(input).exact, true);
  input.context.review.expectedRevision = '9223372036854775806';
  input.context.revision.revision = '9223372036854775806';
  assert.equal(resultOf(input).exact, true);
  input.context.review.expectedRevision = '9223372036854775805';
  assertGlobal(resultOf(input));
});

test('matching out-of-range counters do not turn malformed review headers into exact navigation', () => {
  for (const counter of ['9223372036854775807', '9999999999999999999', '10000000000000000000']) {
    const input = fixture();
    input.context.revision.revision = counter;
    input.context.review.expectedRevision = counter;
    assertGlobal(resultOf(input));
  }
});

test('missing or duplicate current-product evidence never selects the first matching product', () => {
  for (const amend of [
    (input) => { input.context.review.checked = []; },
    (input) => { input.context.review.checked.push(structuredClone(input.context.review.checked[0])); },
    (input) => { input.context.review.checked[0].kind = 'create'; },
    (input) => { input.context.productId = 99; },
    (input) => { delete input.context.productId; },
    (input) => { input.context.review.checked = null; },
  ]) {
    const input = fixture(); amend(input); assertGlobal(resultOf(input));
  }
});

test('checked category and route remain authoritative over conflicting diagnostic hints', () => {
  for (const amend of [
    (input) => { input.problem.routeKey = 'BR:other'; },
    (input) => { input.problem.category = 'SV'; },
    (input) => { input.problem.scope = 'all'; },
    (input) => { input.problem.storeCode = 'all'; },
    (input) => { input.problem.rowId = 'base'; },
    (input) => { input.context.review.checked[0].group = 'SV'; },
    (input) => { delete input.context.review.checked[0].group; },
    (input) => { delete input.context.review.checked[0].routeKey; },
  ]) {
    const input = fixture(); amend(input);
    assert.equal(resultOf(input).exact, false);
  }
});

test('missing, duplicate or foreign attributes fall back to category rules without guessing a policy row', () => {
  for (const amend of [
    (input) => { input.context.revision.bindings.attributes = []; },
    (input) => { input.context.revision.bindings.attributes.push(structuredClone(input.context.revision.bindings.attributes[0])); },
    (input) => { input.context.revision.bindings.attributes[0].rowId = 'base'; },
    (input) => { input.context.revision.bindings.attributes[0].routeKey = 'BR:other'; },
    (input) => { input.context.revision.bindings.attributes[0].target = 'meta_description'; },
    (input) => { input.context.revision.bindings.attributes = null; },
  ]) {
    const input = fixture(); amend(input); assertGeneral(resultOf(input));
  }
});

test('missing, duplicate or foreign policy scope falls back to category rules', () => {
  for (const amend of [
    (input) => { input.context.revision.bindings.policies = []; },
    (input) => { input.context.revision.bindings.policies.push(structuredClone(input.context.revision.bindings.policies[0])); },
    (input) => { input.context.revision.bindings.policies[0].storeCode = 'all'; },
    (input) => { input.context.revision.bindings.policies[0].bindingKey = 'another-attribute'; },
    (input) => { input.context.revision.bindings.policies = null; },
    (input) => { delete input.context.revision.bindings.attributes[0].bindingKey; delete input.context.revision.bindings.policies[0].bindingKey; },
  ]) {
    const input = fixture(); amend(input); assertGeneral(resultOf(input));
  }
});

test('unsupported operation-target-policy triples never produce an exact link even with matching saved rows', () => {
  for (const config of [
    { operation: 'inventory', target: 'meta_title', requiredPolicy: 'initialize_create_only', rowId: 'base', storeCode: 'all' },
    { operation: 'inventory', target: 'qty', requiredPolicy: 'authoritative_create_update', rowId: 'base', storeCode: 'all' },
    { operation: 'websites', target: 'qty', requiredPolicy: 'authoritative_create_update', rowId: 'base', storeCode: 'all' },
    { operation: 'websites', target: 'product_websites', requiredPolicy: 'initialize_create_only', rowId: 'base', storeCode: 'all' },
    { target: 'sku', requiredPolicy: 'authoritative_create_update' },
    { target: 'meta_title', requiredPolicy: 'magento_managed' },
  ]) assertGeneral(resultOf(fixture(config)));
});

test('unknown, inherited and absent operation or required-policy values remain safe generic guidance', () => {
  for (const key of ['operation', 'requiredPolicy']) for (const value of [undefined, null, '', 'unknown', 'constructor', '__proto__', 'toString', ['storeViews']]) {
    const input = fixture(); input.problem[key] = value;
    const result = resultOf(input);
    assertGeneral(result);
    assert.equal(typeof result.message, 'string');
    assert.ok(!result.message.includes('[native code]'));
  }
});

for (const length of [160, 161, 200, 201]) {
  test(`route length ${length} is preserved losslessly when navigable and never truncated`, () => {
    const input = fixture();
    const routeKey = `BR.${'x'.repeat(length - 3)}`;
    input.context.review.checked[0].routeKey = routeKey;
    input.context.revision.bindings.attributes[0].routeKey = routeKey;
    const result = resultOf(input);
    assert.equal(result.exact, length <= 200);
    const query = queryOf(result).query;
    assert.equal(query.route, length <= 200 ? routeKey : undefined);
    assert.equal(query.reviewField, length <= 200 ? 'meta_title' : undefined);
  });
}

test('malformed category and route evidence cannot become an exact URL', () => {
  for (const category of ['br', '../BR', 'BR/other', 'B'.repeat(33), 'BR\n']) {
    const input = fixture();
    input.context.review.checked[0].group = category;
    input.context.review.checked[0].routeKey = `${category}:all`;
    input.context.revision.bindings.attributes[0].routeKey = `${category}:all`;
    assertGlobal(resultOf(input));
  }
  for (const routeKey of ['BR:all\n', 'BR:\u007f', '', 42]) {
    const input = fixture();
    input.context.review.checked[0].routeKey = routeKey;
    input.context.revision.bindings.attributes[0].routeKey = routeKey;
    assert.equal(resultOf(input).exact, false);
  }
});

test('target code bounds are enforced before exact navigation without normalizing malformed identities', () => {
  const accepted = `a${'x'.repeat(99)}`;
  assert.equal(resultOf(fixture({ target: accepted })).exact, true);
  for (const target of [`${accepted}x`, ' meta_title', 'meta_title ', 'meta-title', 'meta_title\n', '', null, 0]) {
    assert.equal(resultOf(fixture({ target })).exact, false);
  }
});

test('binding and source identities remain bounded opaque values and are encoded rather than interpolated', () => {
  const input = fixture();
  const binding = 'draft/7?review=apply&token=not-a-token#literal';
  const source = 'published:2/7?source=literal&x=1';
  input.context.revision.id = binding; input.context.review.bindingRevisionId = binding;
  input.context.currentPublishedId = source; input.context.review.expectedCurrentId = source;
  const result = resultOf(input);
  assert.equal(result.exact, true);
  assert.equal(queryOf(result).query.binding, binding);
  assert.equal(queryOf(result).query.source, source);
  assert.equal(queryOf(result).query.token, undefined);
  for (const value of ['', 'x'.repeat(257), 'draft\n7']) {
    const invalid = fixture(); invalid.context.revision.id = value; invalid.context.review.bindingRevisionId = value;
    assertGlobal(resultOf(invalid));
  }
  const boundary = fixture();
  boundary.context.revision.id = 'x'.repeat(256); boundary.context.review.bindingRevisionId = boundary.context.revision.id;
  assert.equal(resultOf(boundary).exact, true);
});

test('safe repair context preserves return while exact reviewed scope wins and unrelated field hints or proof keys are omitted', () => {
  const input = fixture();
  const returnTo = '/attention?category=BR&problem=42&search=бурштин';
  input.context.repairContext = { productId: '999', category: 'SV', route: 'SV:other', field: 'wrong',
    question: 'finish', value: '0', path: 'Root/Amber', returnTo,
    reviewEntry: 'guessed', reviewField: 'wrong', reviewStore: 'all', language: 'base',
    apply: 'true', approve: 'true', policy: 'blocked', reason: 'approve', previewToken: 'secret', reviewHash: 'proof' };
  const result = resultOf(input);
  assert.equal(result.exact, true);
  const query = queryOf(result).query;
  assert.equal(query.returnTo, returnTo);
  assert.equal(query.productId, '42');
  assert.equal(query.category, 'BR');
  assert.equal(query.route, 'BR:all');
  assert.equal(query.language, 'english');
  assert.equal(query.reviewField, 'meta_title');
  assert.equal(query.reviewStore, 'en');
  for (const key of ['field', 'path', 'question', 'value', 'reviewEntry', 'apply', 'approve', 'policy', 'reason', 'previewToken', 'reviewHash']) assert.equal(query[key], undefined, key);
});

test('unsafe repair returns never create external or executable navigation', () => {
  for (const returnTo of ['https://evil.test', '//evil.test', '/attention#fragment', '/attention\\evil', '/attention\n']) {
    const input = fixture(); input.context.repairContext = { returnTo };
    const result = resultOf(input);
    assert.equal(result.exact, true);
    assert.equal(queryOf(result).query.returnTo, undefined);
  }
});

test('guidance handles frozen original diagnostic and review evidence without changing copied-report data', () => {
  const input = fixture();
  input.problem.message = 'Original recorded message';
  input.problem.evidence = { operation: 'other', target: 'other', value: 0 };
  input.context.review.previewToken = 'immutable-preview-proof';
  input.context.review.blockers = [{ code: 'AFFECTED_CURRENT_PREVIEW_BLOCKED', productId: 42 }];
  const before = JSON.stringify(input);
  freeze(input);
  const first = resultOf(input);
  assert.equal(first.exact, true);
  assert.deepEqual(resultOf(input), first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.context.review.checked[0].blockers[0], input.problem);
});
