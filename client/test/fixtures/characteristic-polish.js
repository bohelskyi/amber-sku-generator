// Synthetic historical projection and recount evidence; no real product data.
const category = { code: 'SV', name: 'Сувеніри', requires_weight: 0 };
const questions = [
  { id: 'souvenir', label: 'Тип сувеніра', required: 1, options: [
    { id: 1, label: 'Письмовий набір' }, { id: 2, label: 'Годинник' },
  ] },
  ...['statue', 'animal', 'bird', 'plant', 'symbol', 'game', 'stone', 'extra_stone'].map((id) => ({
    id, label: `Відсутнє ${id}`, required: 0, include_in_sku: 1,
    visible_if: { souvenir: [3] }, options: [{ id: 1, label: 'Обраний варіант' }],
  })),
  { id: 'kit_part', label: 'Деталь набору', required: 0, include_in_sku: 1,
    visible_if: { souvenir: [1] }, options: [{ id: 7, label: 'Підставка' }] },
  { id: 'visible_clear', label: 'Видиме очищення', required: 0,
    options: [{ id: 5, label: 'Збережений вибір' }] },
  { id: 'zero_option', label: 'Семантичний нуль', required: 0,
    options: [{ id: 0, label: 'Справжній нуль' }] },
  { id: 'numeric_zero', label: 'Числове поле', required: 0, input_type: 'text', options: [] },
  { id: 'is_calibrated', label: 'Калібрування', required: 1, include_in_sku: 0,
    options: [{ id: 0, label: 'Некалібрований' }, { id: 2, label: 'Напівкалібрований' }] },
  { id: 'historic_zero', label: 'Історичний нуль', required: 0, options: [] },
  { id: 'historic_unknown', label: 'Історично невідоме', required: 0, options: [] },
  { id: 'historic_archived', label: 'Архівний вибір', required: 0,
    options: [{ id: 8, label: 'Архівний варіант', archived: 1 }] },
];
export const polishConfig = { categories: { SV: category }, questions: { SV: questions }, extraConfig: {} };
const answers = { souvenir: 1, kit_part: 7, visible_clear: 5, zero_option: 0, numeric_zero: 0,
  is_calibrated: 0, historic_zero: 0, historic_unknown: 90, historic_archived: 8,
  statue: 0, animal: 0, bird: 0, plant: 0, symbol: 0, game: 0, stone: 0, extra_stone: 0 };
const historicalLabels = { historic_zero: '0', historic_unknown: 'Невідомо (збережено: 90)',
  historic_archived: 'Історичний архівний варіант' };
const decodedAnswers = questions.map((question) => {
  const isPlaceholder = question.id.startsWith('extra_')
    || ['statue', 'animal', 'bird', 'plant', 'symbol', 'game', 'stone'].includes(question.id);
  const value = answers[question.id];
  return { key: question.id, label: question.label, value_id: isPlaceholder ? null : value,
    is_placeholder: isPlaceholder,
    value_label: isPlaceholder ? 'Не обрано'
      : historicalLabels[question.id] ?? question.options.find((option) => option.id === value)?.label ?? String(value) };
});
export const polishDecoded = { existsInDb: true, decodeSource: 'stored_history', sku: 'SV-SYNTHETIC-20',
  internalSku: 'SV-SYNTHETIC-20', publicSku: 'AG-000020', category, decodedAnswers,
  skuSchema: { id: 17, version: 1 }, suffix: { type: 'sequence', value: 20 },
  product: { id: 20, status: 'active', weight: 0, details: { answers, isCalibrated: 0 } },
  pricing: { source: 'stored', totalPriceUah: 1200, totalPrice: 30 } };
export const polishTargetAnswers = { souvenir: 2, visible_clear: 5, zero_option: 0, numeric_zero: 0,
  is_calibrated: 0, historic_zero: 0, historic_unknown: 90, historic_archived: 8 };
export const polishPreview = {
  source: { answers, decodedAnswers, publicSku: polishDecoded.publicSku, totalPriceUah: 1200,
    sku: polishDecoded.sku, stateSignature: 'synthetic-source-signature' },
  corrected: { categoryCode: 'SV', answers: polishTargetAnswers, publicSku: polishDecoded.publicSku,
    fullSku: 'SV-SYNTHETIC-20-001', totalPriceUah: 1300, autoPriceUah: 1300 },
  changes: [{ key: 'souvenir', from: 1, to: 2 }, { key: 'kit_part', from: 7, to: null },
    ...['statue', 'animal', 'bird', 'plant', 'symbol', 'game', 'stone', 'extra_stone'].map((key) => ({ key, from: 0, to: null }))],
  previewToken: 'synthetic-preview-token', priceDeltaUah: 100, priceDeltaUsd: 2.5,
};
