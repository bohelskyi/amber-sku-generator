// Observation comparisons only. These never transform export or write values.
function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
  const result = Number(value.trim().replace(',', '.'));
  return Number.isFinite(result) ? result : null;
}
function numericComparison(expected, observed, allowIntegerRounding = false) {
  const a = numeric(expected); const b = numeric(observed);
  if (a === null || b === null) return 'unavailable_or_non_numeric';
  if (String(expected) === String(observed)) return 'exact';
  if (a === b) return 'numeric_equivalent';
  if (allowIntegerRounding && Number.isSafeInteger(b) && Math.round(a) === b) return 'rounded';
  return 'different';
}
function orientation(length, width, observedLength, observedWidth) {
  const values = [length, width, observedLength, observedWidth].map(numeric);
  if (values.includes(null)) return 'unavailable_or_non_numeric';
  const [a, b, c, d] = values;
  const direct = a === c && b === d; const reversed = a === d && b === c;
  return direct && reversed ? 'ambiguous_equal_axes' : direct ? 'direct' : reversed ? 'reversed' : 'different';
}
function sizeOrientation(length, width, text) {
  const parts = typeof text === 'string' ? text.split(/\s*[×xх]\s*/u) : [];
  return parts.length === 2 ? orientation(length, width, ...parts) : 'unavailable_or_non_numeric';
}
const populated = (value) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
function sizeTextOccurs(text, size) {
  if (typeof text !== 'string' || typeof size !== 'string' || !size) return false;
  const normalize = (s) => s.replace(/\s*[xх×]\s*/gu, '×');
  const haystack = normalize(text); const needle = normalize(size);
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (!/[\d.,]/.test(haystack[i - 1] || '') && !/[\d.,]/.test(haystack[i + needle.length] || '')) return true;
  }
  return false;
}
function scopeComparison(field, scopes, expected) {
  const available = (scope) => Object.hasOwn(scopes, scope);
  const value = (scope) => scopes[scope]?.[field] ?? null;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const baseAvailable = Object.hasOwn(expected.base, field);
  const englishAvailable = Object.hasOwn(expected.english, field);
  return { field, allEqualsUa: available('all') && available('ua') ? equal(value('all'), value('ua')) : null,
    enDiffersFromAll: available('en') && available('all') ? !equal(value('en'), value('all')) : null,
    enDiffersFromUa: available('en') && available('ua') ? !equal(value('en'), value('ua')) : null,
    expectedBase: expected.base[field] ?? null, expectedEnglish: expected.english[field] ?? null,
    baseAvailable, englishAvailable,
    baseMatchesAll: baseAvailable && available('all') ? equal(expected.base[field], value('all')) : null,
    baseMatchesUa: baseAvailable && available('ua') ? equal(expected.base[field], value('ua')) : null,
    englishMatchesEn: englishAvailable && available('en') ? equal(expected.english[field], value('en')) : null,
    nonemptyMagentoDiffersFromTemplate: Object.keys(scopes).filter((scope) => populated(value(scope))
      && (scope === 'en' ? englishAvailable : baseAvailable)
      && !equal(value(scope), (scope === 'en' ? expected.english : expected.base)[field])),
    classification: 'field_ownership_evidence', provisional: !expected.ready };
}
module.exports = { numeric, numericComparison, orientation, sizeOrientation, populated, scopeComparison, sizeTextOccurs };
