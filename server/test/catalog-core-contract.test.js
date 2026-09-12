const assert = require('node:assert/strict');
const test = require('node:test');

const catalogService = require('../src/services/catalog.service');

test('catalog service keeps its ten-export compatibility surface', () => {
  assert.deepEqual(Object.keys(catalogService), [
    'getAppConfig',
    'createCategory',
    'updateCategory',
    'createQuestion',
    'updateQuestion',
    'createOption',
    'updateOption',
    'setOptionArchived',
    'updateQuestionsOrder',
    'deleteCatalogItem',
  ]);
});
