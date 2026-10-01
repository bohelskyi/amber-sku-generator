import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('current recount and name-review surfaces do not invite retired article or manual-site workflows', () => {
  for (const file of ['components/app/RecountConfirmDialog.jsx', 'hooks/useProductRecount.js',
    'components/app/ProductMagentoNameReview.jsx', 'components/app/ExportTools.jsx']) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /коригувальний артикул|Новий артикул буде активним|Він не потрапить в експорт|ручного оновлення сайту|English name|\?{4}/, file);
  }
});
