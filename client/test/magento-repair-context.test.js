import assert from 'node:assert/strict';
import test from 'node:test';
import { repairContext, safeRepairReturn, withRepairContext } from '../src/lib/magento-repair-context.js';
import { nextAction, problemRepairUrl, problemTitle } from '../src/components/attention/sync-problem-presentation.js';

test('repair navigation keeps exact source and return context without treating them as write instructions', () => {
  const returnTo = '/attention?category=SV&reason=integration&problem=42';
  const path = problemRepairUrl({ code: 'CATEGORY_PATH_MISSING', path: 'Default/Сувеніри/Птахи' }, { productId: 42, category: 'SV' }, returnTo);
  const url = new URL(path, 'http://local.test');
  assert.equal(url.pathname, '/admin/magento/categories/SV');
  assert.equal(url.searchParams.get('tab'), 'placement');
  assert.deepEqual(repairContext(url.searchParams), { productId: '42', category: 'SV', path: 'Default/Сувеніри/Птахи', returnTo });
  const field = problemRepairUrl({ code: 'OPTION_UNRESOLVED', target: 'kamin_obrobka', question: 'finish', value: '0' }, { productId: 42, category: 'SV' }, returnTo);
  assert.equal(new URL(field, 'http://local.test').searchParams.get('value'), '0');
  assert.equal(nextAction({ code: 'OPTION_UNRESOLVED' }), 'Знайти або додати значення');
  assert.match(problemTitle({ code: 'CATEGORY_PATH_MISSING', path: 'Root/Child', message: 'Категорії немає' }), /Root\/Child/);
});

test('repair context rejects external returns, fragments, control characters, invalid identities and unknown keys', () => {
  for (const bad of ['https://evil.test', '//evil.test', '/attention/../../evil', '/attention#fragment', '/attention\\evil', '/attention\n']) assert.equal(safeRepairReturn(bad), null);
  assert.deepEqual(repairContext({ productId: '1e3', field: 'bad\nfield', returnTo: '//evil.test', apply: 'true', category: 'SV' }), { category: 'SV' });
  assert.equal(withRepairContext('//evil.test', { productId: '7' }), '/admin/magento');
  const url = new URL(withRepairContext('/admin/magento/prepare?intent=mapping', { productId: '7', field: 'finish' }, { field: null }), 'http://local.test');
  assert.equal(url.searchParams.get('intent'), 'mapping');
  assert.equal(url.searchParams.get('field'), null);
  assert.equal(url.searchParams.get('productId'), '7');
  const task = new URL(withRepairContext('/admin/magento/prepare?tab=old&step=4', { productId: '7' },
    { intent: 'option', tab: 'attributes', version: 'version-1', templateVersion: 'template-2', draft: 'draft-3', step: '', ignored: 'no' }), 'http://local.test');
  assert.deepEqual(Object.fromEntries(task.searchParams), { tab: 'attributes', productId: '7', intent: 'option', version: 'version-1', templateVersion: 'template-2', draft: 'draft-3' });
});
