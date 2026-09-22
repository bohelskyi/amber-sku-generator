const assert = require('node:assert/strict');
const test = require('node:test');
const pool = require('../src/db/pool');
const { mapProduct } = require('../src/services/magento-products-v1');
const { suggestEnglishSubject } = require('../src/services/product-magento-name.service');

test('SV manual pair overrides automatic name; missing pair reports manual_name_required', () => {
  const product = { id: 1, category: 'SV', full_sku: 'SV-1', weight: 10,
    total_price_uah: 2000, details: { answers: { souvenir: 6, weight: '5', size: '4 см' } } };
  const automatic = mapProduct(product);
  assert.equal(automatic.base.name, 'Брелок з бурштину. Арт: SV-1');
  const manual = mapProduct({ ...product,
    magento_name_subject_ua: 'Фігурка птаха',
    magento_name_subject_en: 'bird figurine' });
  assert.equal(manual.base.name, 'Фігурка птаха з бурштину. Арт: SV-1');
  assert.equal(manual.english.name, 'Amber bird figurine. Art: SV-1');
  const missing = mapProduct({ ...product,
    details: { answers: { ...product.details.answers, souvenir: 5 } } });
  assert.ok(missing.errors.some((item) => item.code === 'manual_name_required'));
});

test('Google suggestion sends server key in header and plain uk-en POST body only', async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ id: 1, category: 'SV', status: 'active',
    corrected_to_product_id: null }] });
  try {
    let captured;
    const result = await suggestEnglishSubject({ productId: 1, subjectUa: 'Фігурка птаха' }, {
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, json: async () => ({ data: {
          translations: [{ translatedText: 'Bird figurine' }],
        } }) };
      },
    });
    assert.deepEqual(result, { subjectEn: 'Bird figurine' });
    assert.equal(captured.url, 'https://translation.googleapis.com/language/translate/v2');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['X-Goog-Api-Key'], 'test-key');
    assert.deepEqual(JSON.parse(captured.options.body), {
      q: 'Фігурка птаха', source: 'uk', target: 'en', format: 'text',
    });
    assert.ok(!captured.url.includes('test-key'));
    await assert.rejects(suggestEnglishSubject({ productId: 1, subjectUa: 'Фігурка' }, {
      apiKey: 'test-key', fetchImpl: async () => { throw new Error('network failed'); },
    }), (error) => error.publicCode === 'TRANSLATION_FAILED'
      && !error.message.includes('test-key'));
  } finally {
    pool.query = originalQuery;
  }
});

test('unconfigured translation rejects before product lookup or provider request', async () => {
  const originalQuery = pool.query;
  let databaseCalls = 0;
  let providerCalls = 0;
  pool.query = async () => { databaseCalls += 1; throw new Error('unexpected DB call'); };
  try {
    await assert.rejects(suggestEnglishSubject({ productId: 1, subjectUa: 'Камінь' }, {
      apiKey: '', fetchImpl: async () => { providerCalls += 1; },
    }), (error) => error.statusCode === 503
      && error.publicCode === 'TRANSLATION_NOT_CONFIGURED');
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    pool.query = originalQuery;
  }
});

test('Magento mapper uses saved names without invoking translation', () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = () => { providerCalls += 1; throw new Error('translation in export'); };
  try {
    const mapped = mapProduct({ id: 1, category: 'SV', full_sku: 'SV-1',
      weight: 10, total_price_uah: 2000,
      magento_name_subject_ua: 'Камінь', magento_name_subject_en: 'stone',
      details: { answers: { souvenir: 5, weight: '5', size: '4 см' } },
    });
    assert.equal(mapped.base.name, 'Камінь з бурштину. Арт: SV-1');
    assert.equal(mapped.english.name, 'Amber stone. Art: SV-1');
    assert.equal(providerCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
