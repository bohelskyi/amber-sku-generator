// Presentation validation mirrors the closed catalog metadata. The server still
// validates every request and persists the authoritative normalized answers.
export function numericQuestionPolicy(question, categoryCode) {
  if (question?.numeric_validation) {
    const policy = question.numeric_validation;
    return question.id === 'weight' ? { ...policy, ...(policy.min == null || policy.min <= 0 ? { min: 0, minInclusive: false } : {}), maxFractionDigits: Math.min(3, policy.maxFractionDigits ?? 3) } : policy;
  }
  return question?.id === 'weight' && categoryCode === 'SV'
    ? { kind: 'decimal', min: 0, minInclusive: false, maxFractionDigits: 3, unit: 'г' }
    : null;
}

export function validateNumericInput(value, policy) {
  if (!policy) return { valid: true, normalized: value, error: '' };
  let raw = String(value ?? '').trim();
  // JSON numbers have already passed numeric parsing; a small finite number may
  // stringify in exponent form. Expand it while keeping exponent *text* invalid.
  if (typeof value === 'number' && Number.isFinite(value) && /e/i.test(raw)) {
    const negative = raw.startsWith('-');
    const [coefficient, exponent] = raw.replace(/^[+-]/, '').toLowerCase().split('e');
    const [whole, fraction = ''] = coefficient.split('.');
    const digits = whole + fraction; const point = whole.length + Number(exponent);
    raw = `${negative ? '-' : ''}${point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`}`;
  }
  if (!raw) return { valid: true, normalized: undefined, error: '' };
  const integer = policy.kind === 'integer';
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(raw)) {
    return { valid: false, error: 'Введіть лише число без одиниць виміру та зайвих символів.' };
  }
  if (integer && !/^[+-]?\d+$/.test(raw)) {
    return { valid: false, error: 'Введіть ціле число без дробової частини.' };
  }
  const normalized = Number(raw.replace(',', '.'));
  if (!Number.isFinite(normalized) || Math.abs(normalized) > Number.MAX_SAFE_INTEGER) return { valid: false, error: 'Число завелике.' };
  const fractions = raw.split(/[.,]/)[1]?.length || 0;
  if (policy.maxFractionDigits != null && fractions > policy.maxFractionDigits) return { valid: false, error: `Не більше ${policy.maxFractionDigits} знаків після коми.` };
  if (policy.min != null && (normalized < policy.min || policy.minInclusive === false && normalized === policy.min)) return { valid: false, error: `Значення має бути ${policy.minInclusive === false ? 'більшим за' : 'не меншим за'} ${policy.min}.` };
  if (policy.max != null && (normalized > policy.max || policy.maxInclusive === false && normalized === policy.max)) return { valid: false, error: `Значення має бути ${policy.maxInclusive === false ? 'меншим за' : 'не більшим за'} ${policy.max}.` };
  return { valid: true, normalized, error: '' };
}

export const physicalWeightPolicy = { kind: 'decimal', min: 0, minInclusive: false, maxFractionDigits: 3, unit: 'г' };

export function normalizeNumericAnswers(questions, answers, categoryCode) {
  const normalized = { ...answers };
  const fieldErrors = {};
  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id)) continue;
    const policy = numericQuestionPolicy(question, categoryCode);
    if (!policy) continue;
    const result = validateNumericInput(answers[question.id], policy);
    if (!result.valid) fieldErrors[question.id] = result.error;
    else if (result.normalized === undefined) delete normalized[question.id];
    else normalized[question.id] = result.normalized;
  }
  return { answers: normalized, fieldErrors };
}
