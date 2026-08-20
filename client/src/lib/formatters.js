export const formatUah = (value) => {
  const numericValue = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numericValue)
    ? `${Math.round(numericValue)} ₴`
    : '---';
};

export const formatUahPerGram = (value) => {
  const numericValue = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numericValue)
    ? `${numericValue.toFixed(2)} ₴`
    : '---';
};

export const formatUsd = (value) => (Number(value) > 0 ? `$${value}` : '---');

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
};

export const formatDecodedSuffix = (suffix) => {
  if (!suffix || suffix.type === 'none') return 'Без фінального суфікса';
  if (suffix.type === 'weight') return suffix.value !== null ? `${suffix.value} г` : suffix.raw;
  if (suffix.type === 'sequence') return suffix.raw || String(suffix.value || '');
  return suffix.raw || '---';
};
