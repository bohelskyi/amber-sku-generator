// Comparison only: no unit inference, conversion, rounding or source rewrite.
const COMPARISON = 'sv-dimensions-ordered-decimals-v1';
function components(value) {
  if (typeof value !== 'string' || value.length > 500
    || !/^\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?){0,2}$/.test(value)) return null;
  const result = [];
  for (const part of value.split('/')) {
    if (part.length > 128) return null;
    const [whole, fraction = ''] = part.replace(',', '.').split('.');
    const integer = whole.replace(/^0+(?=\d)/, '');
    const decimal = fraction.replace(/0+$/, '');
    if (decimal.length > 18 || integer === '0' && !decimal) return null;
    result.push(integer + (decimal ? '.' + decimal : ''));
  }
  return result;
}
function equivalent(left, right) {
  const a = components(left), b = components(right);
  return a !== null && b !== null && a.length === b.length && a.every((value, index) => value === b[index]);
}
module.exports = { COMPARISON, components, equivalent };
