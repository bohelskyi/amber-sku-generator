function parseVariationSku(skuValue) {
  const normalizedSku = String(skuValue || '').trim().toUpperCase();
  const variationMatch = normalizedSku.match(/^(.*)-(\d{3})$/);

  if (!variationMatch) {
    return {
      normalizedSku,
      baseFullSku: normalizedSku,
      variationNumber: null,
    };
  }

  return {
    normalizedSku,
    baseFullSku: variationMatch[1],
    variationNumber: Number(variationMatch[2]),
  };
}

function decodeSkuAnswers(questions, encodedPart, index = 0, decodedAnswers = []) {
  if (index === questions.length) {
    return encodedPart.length === 0 ? decodedAnswers : null;
  }

  const question = questions[index];
  const options = [...question.options].sort(
    (a, b) => String(b.id).length - String(a.id).length || a.id - b.id
  );

  for (const option of options) {
    const optionCode = String(option.id);
    if (!encodedPart.startsWith(optionCode)) continue;

    const nextDecoded = decodeSkuAnswers(
      questions,
      encodedPart.slice(optionCode.length),
      index + 1,
      [
        ...decodedAnswers,
        {
          key: question.key,
          label: question.label,
          sku_index: question.sku_index,
          value_id: option.id,
          value_label: option.label,
          is_placeholder: false,
        },
      ]
    );

    if (nextDecoded) return nextDecoded;
  }

  const hasZeroOption = question.options.some((option) => Number(option.id) === 0);
  if (question.required !== 1 && !hasZeroOption && encodedPart.startsWith('0')) {
    return decodeSkuAnswers(questions, encodedPart.slice(1), index + 1, [
      ...decodedAnswers,
      {
        key: question.key,
        label: question.label,
        sku_index: question.sku_index,
        value_id: null,
        value_label: 'Не обрано',
        is_placeholder: true,
      },
    ]);
  }

  return null;
}

module.exports = {
  parseVariationSku,
  decodeSkuAnswers,
};
