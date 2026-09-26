const { INFORMATION_FIELDS_V1 } = require('../product-information.service');
const { stableJson } = require('../export-exposure/evidence');

function numericRepresentation(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
  const number = Number(value.trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function inheritRecountNames(source, target, schema, questions, decodedAnswers = []) {
  const ua = source.magento_name_subject_ua ?? null;
  const en = source.magento_name_subject_en ?? null;
  if (ua === null && en === null) return { ua, en, reviewRequired: false };
  let safe = Boolean(ua && en && schema?.id && source.sku_schema_version_id
    && Number(schema.id) === Number(source.sku_schema_version_id)
    && Number(target.skuSchemaVersionId) === Number(source.sku_schema_version_id)
    && target.categoryCode === source.category && Number(target.weight) === Number(source.weight));
  const before = source.details?.answers || {};
  const after = target.answers || {};
  const placeholders = new Set(decodedAnswers.filter((a) => a.is_placeholder && a.value_id == null).map((a) => a.key));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (stableJson(before[key]) === stableJson(after[key])) continue;
    const semantic = schema?.questions?.find((q) => q.key === key);
    const current = questions.filter((q) => q.key === key);
    if (semantic) {
      const decoded = decodedAnswers.find((a) => a.key === key);
      const oldNumber = numericRepresentation(before[key] === undefined && !decoded?.is_placeholder
        ? decoded?.value_id : before[key]);
      const newNumber = numericRepresentation(after[key]);
      if (oldNumber !== null && newNumber === oldNumber
        && semantic.options?.some((o) => Number(o.value_id) === oldNumber)) continue;
      // A decoded placeholder is not an independently entered semantic answer.
      if (placeholders.has(key) && before[key] === undefined && after[key] === 0
        && !semantic.options?.some((o) => Number(o.value_id) === 0)) continue;
      safe = false;
    } else if (key === 'is_calibrated') {
      if (Number(before[key] ?? source.details?.isCalibrated ?? 0) !== Number(after[key] ?? 0)) safe = false;
    } else if (current.length !== 1 || Number(current[0].include_in_sku) !== 0
      || current[0].input_type !== 'text') {
      safe = false;
    } else if (!INFORMATION_FIELDS_V1[source.category]?.includes(key)) {
      // The accepted souvenir representation case is deliberately narrow; this
      // does not authorize an in-place weight edit or general semantic aliases.
      if (source.category !== 'SV' || key !== 'weight' || numericRepresentation(before[key]) === null
        || numericRepresentation(before[key]) !== numericRepresentation(after[key])) safe = false;
    }
  }
  return { ua, en, reviewRequired: Boolean(source.magento_name_review_required) || !safe };
}

module.exports = { inheritRecountNames };
