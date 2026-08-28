const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCorrectionChangesText,
  normalizeCorrectionRow,
  normalizeHistoryFilters,
} = require('../src/services/correction-history.service');

const config = {
  categories: { BR: { name: 'Браслети' } },
  questions: {
    BR: [
      {
        id: 'quality',
        label: 'Якість',
        required: 1,
        options: [
          { id: 1, label: '1 сорт - натура', visible_if_json: { raw_type: 1 } },
          { id: 1, label: '1 сорт - формований', visible_if_json: { raw_type: 2 } },
          { id: 2, label: '2 сорт - натура', visible_if_json: { raw_type: 1 } },
        ],
      },
    ],
  },
  extraConfig: {
    is_calibrated: {
      label: 'Сировина калібрована?',
      options: [
        { id: 0, label: 'Ні' },
        { id: 1, label: 'Так' },
      ],
    },
  },
};

test('history reconstructs changes and preserves historical old labels', () => {
  const item = normalizeCorrectionRow({
    id: 7,
    source_product_id: 10,
    corrected_product_id: 11,
    category_code: 'BR',
    source_sku: 'BR-OLD',
    corrected_sku: 'BR-NEW',
    price_delta_uah: 200,
    reason: 'Уточнено сорт',
    created_at: '2026-08-20T08:00:00.000Z',
    old_payload: {
      totalPriceUah: 400,
      pricePerGram: 1,
      answers: { raw_type: 1, quality: 1, is_calibrated: 0 },
      decodedAnswers: [{
        key: 'quality',
        label: 'Історична якість',
        value_id: 1,
        value_label: 'Старий опис 1 сорту',
      }],
      pricing: { matrixName: 'Стара матриця' },
    },
    new_payload: {
      categoryCode: 'BR',
      totalPriceUah: 600,
      pricePerGram: 1.5,
      answers: { raw_type: 1, quality: 2, is_calibrated: 1 },
      pricingDetails: { scenario: { name: 'Нова матриця' } },
    },
  }, config);

  assert.equal(item.categoryName, 'Браслети');
  assert.equal(item.oldPriceUah, 400);
  assert.equal(item.newPriceUah, 600);
  assert.equal(item.oldMatrixName, 'Стара матриця');
  assert.equal(item.newMatrixName, 'Нова матриця');
  assert.deepEqual(item.changes, [
    {
      key: 'quality',
      from: 1,
      to: 2,
      questionLabel: 'Історична якість',
      fromLabel: 'Старий опис 1 сорту',
      toLabel: '2 сорт - натура',
    },
    {
      key: 'is_calibrated',
      from: 0,
      to: 1,
      questionLabel: 'Сировина калібрована?',
      fromLabel: 'Ні',
      toLabel: 'Так',
    },
  ]);
  assert.equal(
    getCorrectionChangesText(item),
    'Історична якість: Старий опис 1 сорту -> 2 сорт - натура; Сировина калібрована?: Ні -> Так'
  );
});

test('history filters validate date ranges and normalize category', () => {
  assert.deepEqual(normalizeHistoryFilters({
    category: ' nm ',
    search: '  NM123 ',
    from: '2026-08-01',
    to: '2026-08-31',
  }), {
    categoryCode: 'NM',
    search: 'NM123',
    from: '2026-08-01',
    to: '2026-08-31',
  });
  assert.throws(
    () => normalizeHistoryFilters({ from: '2026-09-01', to: '2026-08-01' }),
    /Початкова дата/
  );
  assert.throws(() => normalizeHistoryFilters({ from: '01.08.2026' }), /Некоректна/);
});
