const normalizeQuestionSeparator = (separator) => {
  const value = String(separator || '').trim();
  return /^[._/-]{1,3}$/.test(value) ? value : '';
};

const getSampleValue = (question) => {
  const firstOption = (question.options || [])[0];
  if (firstOption?.id !== undefined && firstOption?.id !== null) return String(firstOption.id);
  return '0';
};

const getSkuQuestions = (questions) =>
  (questions || [])
    .filter((question) => question.include_in_sku === 1)
    .sort((a, b) => Number(a.sku_index) - Number(b.sku_index) || String(a.id).localeCompare(String(b.id)));

export function SkuTemplatePreview({ category, questions }) {
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
  const sampleSku = `${category.code}${parts.map((part) => part.token).join('')}${suffixLabel}`;
  const isBranchingSku = category.skip_hidden_sku_questions === 1;

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white/80 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-500">SKU-конструктор</div>
          <div className="mt-1 font-mono text-lg font-semibold text-slate-900">{sampleSku}</div>
        </div>
        <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">
          {isBranchingSku ? 'гілковий SKU' : 'фіксований SKU'} | суфікс: {suffixText}
        </span>
      </div>

      {isBranchingSku && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-slate-700">
          У цій категорії приховані питання не потрапляють в артикул. Приклад нижче показує повний набір можливих SKU-полів.
        </div>
      )}

      {parts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          У цій категорії ще немає питань, які додаються в SKU.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700">
            {category.code}
          </span>
          {parts.map((part) => (
            <span
              key={part.id}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
              title={`${part.label} (${part.id})`}
            >
              #{part.index} {part.label}: <span className="font-mono">{part.token}</span>
            </span>
          ))}
          <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
            {suffixText}: <span className="font-mono">{suffixLabel}</span>
          </span>
        </div>
      )}
    </div>
  );
}
