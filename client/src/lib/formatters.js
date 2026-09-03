const hasFiniteNumericValue = (value) => (
  value !== null
  && value !== undefined
  && String(value).trim() !== ''
  && Number.isFinite(Number(value))
);

export const formatDecimal = (value) => {
  if (value === null || value === undefined) return '';

  const text = String(value).trim();
  const match = text.match(/^([+-]?\d+)(?:\.(\d+))?$/);
  if (!match || !match[2]) return text;

  const fraction = match[2].replace(/0+$/, '');
  return fraction ? `${match[1]}.${fraction}` : match[1];
};

export const formatUah = (value) => (hasFiniteNumericValue(value)
  ? `${formatDecimal(value)} ₴`
  : '---');

export const formatUahPerGram = (value) => {
  return hasFiniteNumericValue(value)
    ? `${formatDecimal(value)} ₴`
    : '---';
};

export const formatUsd = (value) => (
  hasFiniteNumericValue(value) && Number(value) > 0
    ? `$${formatDecimal(value)}`
    : '---'
);

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
};

export const formatDecodedSuffix = (suffix) => {
  if (!suffix || suffix.type === 'none') return 'Без фінального суфікса';
  if (suffix.type === 'weight') {
    return suffix.value !== null && suffix.value !== undefined
      ? `${formatDecimal(suffix.value)} г`
      : suffix.raw;
  }
  if (suffix.type === 'sequence') return suffix.raw || String(suffix.value || '');
  return suffix.raw || '---';
};
