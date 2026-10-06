import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalogReturnTarget, resolveCatalogEntry } from '../src/lib/catalog-entry.js';
const config = { categories: { SV: { code: 'SV' } }, questions: { SV: [{ id: 'kind', q_db_id: 7,
  options: [{ id: 0, db_id: 12, archived: 1 }, { id: 2, db_id: 13 }, { id: 2, db_id: 14 }] }] } };
test('deep-link resolves exact archived zero row and rejects unknown or ambiguous semantic identity', () => {
  const zero = resolveCatalogEntry(config, '?category=SV&question=kind&value=0&action=edit-option', 'k');
  assert.equal(zero.option.db_id, 12); assert.equal(zero.action.optionDbId, 12);
  for (const value of ['99', '00', '2', '', '2junk']) {
    assert.equal(resolveCatalogEntry(config, '?category=SV&question=kind&value='+value+'&action=edit-option', 'k').action, null);
  }
  assert.equal(resolveCatalogEntry(config, '?category=SV&question=7&value=2&optionId=14&action=edit-option', 'k').action.optionDbId, 14);
  assert.equal(resolveCatalogEntry(null, '?category=SV&question=kind&value=0&action=edit-option', 'k').action, null);
});
test('catalog return keeps permitted context and rejects noncanonical or external navigation', () => {
  for (const value of ['/admin/magento/categories/SV?question=kind', '/attention?item=12']) assert.equal(getCatalogReturnTarget(value), value);
  for (const value of ['https://evil.test', '//evil.test', '/admin/magento', '/admin/magento/categories/SV/../other', '/attention#x', '/attention%3Fx', '/admin/magento/categories/SV%2fother', '/attention\\evil']) assert.equal(getCatalogReturnTarget(value), null);
});
test('preparation return accepts only the exact internal workspace path and preserves the original task', () => {
  const back = '/admin/magento/prepare?category=SV&draft=kept&step=1&intent=option&question=kind&value=0&productId=42&returnTo=%2Fattention%3Fproblem%3D42';
  const entry = resolveCatalogEntry(config, `?${new URLSearchParams({ category: 'SV', question: 'kind', action: 'new-option', returnTo: back })}`, 'task');
  assert.equal(entry.returnTo, back);
  assert.equal(entry.action.questionDbId, 7);
  for (const value of ['/admin/magento/prepare/other', '/admin/magento/prepare/', '/admin/magento/%70repare', '/admin/magento/prepare/../prepare', '//manager.local/admin/magento/prepare', '/admin/magento/prepare#x', '/admin/magento/prepare\\x', '/admin/magento/prepare\n']) {
    assert.equal(getCatalogReturnTarget(value), null, value);
  }
});
