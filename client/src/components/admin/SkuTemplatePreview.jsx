const normalizeQuestionSeparator = (separator) => {
  const value = String(separator || '').trim();
  return /^[._/-]{1,3}$/.test(value) ? value : '';
};

const getSampleValue = (question) => {
  const firstOption = (question.options || [])[0];
  if (firstOption?.sku_code !== undefined && firstOption?.sku_code !== null) return String(firstOption.sku_code);
  if (firstOption?.id !== undefined && firstOption?.id !== null) return String(firstOption.id);
  return '0';
};

const getSkuQuestions = (questions) =>
  (questions || [])
    .filter((question) => question.include_in_sku === 1)
    .sort((a, b) => Number(a.sku_index) - Number(b.sku_index) || String(a.id).localeCompare(String(b.id)));

export function SkuTemplatePreview({ category, marker = '', questions }) {
  if (!category) return null;

  const skuQuestions = getSkuQuestions(questions);
  const parts = skuQuestions.map((question) => {
    const value = getSampleValue(question);
    const separator = normalizeQuestionSeparator(question.sku_separator);

    return {
      id: question.id,
      label: question.label || question.id,
      index: question.sku_index,
      separator,
      value,
      token: separator ? `${separator}${value}${separator}` : value,
    };
  });

  const suffixLabel = category.requires_weight === 1 ? '045' : '001';
  const suffixText = category.requires_weight === 1 ? 'вага' : 'номер';
  const sampleSku = `${category.code}${marker || ''}${parts.map((part) => part.token).join('')}${suffixLabel}`;
  const isBranchingSku = category.skip_hidden_sku_questions === 1;

  return (
    <div className="catalog-sku-template">
      <div className="catalog-sku-template-main">
        <div>
          <div className="catalog-sku-template-label">Шаблон SKU</div>
          <div className="catalog-sku-template-value">{sampleSku}</div>
        </div>
        <span className="catalog-sku-template-mode">{isBranchingSku ? 'Гілковий' : 'Фіксований'} · суфікс: {suffixText}</span>
      </div>

      {parts.length === 0 ? (
        <div className="catalog-sku-template-empty">
          У цій категорії ще немає питань, які додаються в SKU.
        </div>
      ) : (
        <details className="catalog-sku-template-details">
          <summary>Склад шаблону</summary>
          {isBranchingSku && <p>Приховані питання пропускаються; приклад містить повний набір можливих SKU-полів.</p>}
          <div>
            <span className="font-mono">{category.code}</span>
            {marker && <span className="font-mono">{marker}</span>}
            {parts.map((part) => (
              <span key={part.id} title={`${part.label} (${part.id})`}>
                #{part.index} {part.label}: <b className="font-mono">{part.token}</b>
              </span>
            ))}
            <span>{suffixText}: <b className="font-mono">{suffixLabel}</b></span>
          </div>
        </details>
      )}
    </div>
  );
}
