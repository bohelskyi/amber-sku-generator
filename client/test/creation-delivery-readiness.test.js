import test from 'node:test';
import assert from 'node:assert/strict';
import { creationDeliveryState } from '../src/lib/creation-delivery-readiness.js';
const upgrade = { scope: 'native_characteristic_source_support', status: 'configuration_required',
  code: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', categoryCode: 'NM', questionKey: 'extra',
  targetContract: 'public-product-characteristics-v1', bindingRevisionId: 'current-v4' };
test('exact current-binding support handoff retains native category, question and own return path', () => {
  const state = creationDeliveryState(upgrade, 'NM');
  const url = new URL(state.href, 'https://manager.local');
  assert.equal(url.pathname, '/admin/magento/categories/NM');
  assert.equal(url.searchParams.get('binding'), 'current-v4');
  assert.equal(url.searchParams.get('question'), 'extra');
  assert.equal(url.searchParams.get('returnTo'), '/products/create?category=NM');
});
test('deferred frozen AR size produces a value-review action rather than an upgrade solution', () => {
  const state = creationDeliveryState({ ...upgrade, categoryCode: 'AR', questionKey: 'size',
    code: 'SOURCE_SUPPORT_DEFERRED_VALUE', valueId: '29', targetContract: undefined }, 'AR');
  assert.equal(state.kind, 'deferred_value');
  assert.equal(new URL(state.href, 'https://manager.local').searchParams.get('value'), '29');
});
test('mismatched category, future code, missing proof and unsafe identity never fabricate a handoff', () => {
  for (const diagnostic of [{ ...upgrade, categoryCode: 'AR' }, { ...upgrade, code: 'OTHER' },
    { ...upgrade, questionKey: 'other' }, { ...upgrade, targetContract: undefined },
    { ...upgrade, bindingRevisionId: '//evil.example' }]) {
    assert.deepEqual(creationDeliveryState(diagnostic, 'NM'), { status: 'not_checked' });
  }
  assert.equal(creationDeliveryState(null, 'NM'), null);
});
test('source support success remains narrow and does not become global delivery readiness', () => {
  assert.deepEqual(creationDeliveryState({ ...upgrade, status: 'no_native_upgrade_blocker', code: null }, 'NM'),
    { status: 'no_native_upgrade_blocker' });
});
test('category and consumed value diagnostics retain exact server context without substituting native upgrade language',()=>{
  const category=creationDeliveryState({...upgrade,categoryCode:'NEW',code:'MAGENTO_CATEGORY_NOT_LINKED',questionKey:null,valueId:null},'NEW');
  assert.equal(category.kind,'category');assert.equal(new URL(category.href,'https://local.invalid').searchParams.has('question'),false);
  const value=creationDeliveryState({...upgrade,categoryCode:'NEW',code:'MAGENTO_SOURCE_VALUE_NOT_LINKED',questionKey:'color',valueId:'8'},'NEW');
  assert.equal(value.kind,'source_value');assert.equal(new URL(value.href,'https://local.invalid').searchParams.get('value'),'8');
  assert.deepEqual(creationDeliveryState({...upgrade,code:'MAGENTO_SOURCE_VALUE_NOT_LINKED',valueId:'8',questionKey:'bad/key'},'NM'),{status:'not_checked'});
});
