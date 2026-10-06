// Whole plain-decimal grammar, shared by write validation and pricing.
function parseStrictDecimal(value, rules = {}, fieldLabel = 'Значення') {
  let text = typeof value === 'string' ? value.trim() : String(value);
  // JSON numbers have already been parsed. Expand their JS representation for
  // precision checks; exponent notation remains forbidden in submitted strings.
  if (typeof value === 'number' && Number.isFinite(value) && /e/i.test(text)) {
    const [coefficient, exponentText] = text.toLowerCase().split('e');
    const sign = coefficient.startsWith('-') ? '-' : '';
    const absolute = coefficient.replace(/^-/, '');
    const digits = absolute.replace('.', '');
    const position = (absolute.split('.')[0].length) + Number(exponentText);
    text = sign + (position <= 0 ? `0.${'0'.repeat(-position)}${digits}`
      : position >= digits.length ? digits + '0'.repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`);
  }
  const fail = (message) => { throw Object.assign(new Error(`${fieldLabel}: ${message}`), { statusCode: 422 }); };
  if (!['string', 'number'].includes(typeof value) || !/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) fail('вкажіть лише число без одиниць виміру та зайвих символів.');
  const parsed = Number(text.replace(',', '.'));
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) fail('число завелике.');
  const fractionDigits = (text.split(/[.,]/)[1] || '').length;
  if (rules.kind === 'integer' && (!Number.isSafeInteger(parsed) || fractionDigits > 0)) fail('вкажіть ціле число.');
  if (rules.maxFractionDigits != null && fractionDigits > rules.maxFractionDigits) fail(`дозволено не більше ${rules.maxFractionDigits} цифр після коми.`);
  if (rules.min != null && (rules.minInclusive === false ? parsed <= rules.min : parsed < rules.min)) fail(`значення має бути ${rules.minInclusive === false ? 'більшим за' : 'не меншим за'} ${rules.min}.`);
  if (rules.max != null && (rules.maxInclusive === false ? parsed >= rules.max : parsed > rules.max)) fail(`значення має бути ${rules.maxInclusive === false ? 'меншим за' : 'не більшим за'} ${rules.max}.`);
  return parsed;
}

function normalizeNumericValidation(value) {
  if (value == null) return null;
  const fail = () => { throw Object.assign(new Error('Некоректні числові правила питання.'), { statusCode: 400 }); };
  if (typeof value !== 'object' || Array.isArray(value) || !['integer', 'decimal'].includes(value.kind)) fail();
  const allowed = new Set(['kind', 'unit', 'min', 'max', 'minInclusive', 'maxInclusive', 'maxFractionDigits']);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail();
  const bound = (input) => {
    if (input == null || input === '') return null;
    try { return parseStrictDecimal(input); } catch { fail(); }
  };
  const normalized = { kind: value.kind, unit: value.unit == null || value.unit === '' ? null : value.unit,
    min: bound(value.min), max: bound(value.max),
    minInclusive: value.minInclusive ?? true, maxInclusive: value.maxInclusive ?? true,
    maxFractionDigits: value.maxFractionDigits == null || value.maxFractionDigits === '' ? null : bound(value.maxFractionDigits) };
  if (normalized.unit != null && (typeof normalized.unit !== 'string' || normalized.unit.length > 32 || /[\x00-\x1f\x7f]/.test(normalized.unit))) fail();
  if (typeof normalized.minInclusive !== 'boolean' || typeof normalized.maxInclusive !== 'boolean') fail();
  if (normalized.maxFractionDigits != null && (!Number.isInteger(normalized.maxFractionDigits) || normalized.maxFractionDigits < 0 || normalized.maxFractionDigits > 12)) fail();
  if (normalized.kind === 'integer') normalized.maxFractionDigits = 0;
  if (normalized.min != null && normalized.max != null && (normalized.min > normalized.max || (normalized.min === normalized.max && (!normalized.minInclusive || !normalized.maxInclusive)))) fail();
  return normalized;
}

function validateNumericAnswer(question, value) {
  try { return parseStrictDecimal(value, question.numeric_validation || {}, question.label || question.key || question.id); }
  catch (error) { error.fieldErrors = { [question.key || question.id]: error.message }; throw error; }
}

function parseNonNegativeDecimal(value, fieldLabel = 'Значення') {
  try { return parseStrictDecimal(value, { min: 0 }, fieldLabel); }
  catch { throw Object.assign(new Error(`${fieldLabel} має бути невід'ємним числом.`), { statusCode: 400 }); }
}

function parsePositiveDecimal(value, fieldLabel = 'Значення') {
  try { return parseStrictDecimal(value, { min: 0, minInclusive: false }, fieldLabel); }
  catch { throw Object.assign(new Error(`${fieldLabel} має бути числом, більшим за 0.`), { statusCode: 400 }); }
}

function resolveProductWeight(weight, answerWeight) {
  const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';
  const parseWeight = (value) => {
    try { return present(value) ? parseStrictDecimal(value, { min: 0, maxFractionDigits: 3 }, 'Вага') : null; }
    catch (error) { error.fieldErrors = { weight: error.message }; throw error; }
  };
  const physical = parseWeight(weight);
  const answer = parseWeight(answerWeight);
  if (physical != null && answer != null && physical !== answer) {
    const message = 'Вага товару та значення характеристики відрізняються. Вкажіть одну підтверджену вагу.';
    throw Object.assign(new Error(message), { statusCode: 422, code: 'WEIGHT_CONFLICT',
      fieldErrors: { weight: message }, details: { weight: physical, answerWeight: answer } });
  }
  return physical ?? answer ?? 0;
}

module.exports = { resolveProductWeight, parseStrictDecimal, normalizeNumericValidation, validateNumericAnswer, parseNonNegativeDecimal, parsePositiveDecimal };
