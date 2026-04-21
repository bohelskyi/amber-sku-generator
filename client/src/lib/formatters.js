export const formatUah = (value) =>
  value !== null && value !== undefined ? `${value} ₴` : '---';

export const formatUsd = (value) => (Number(value) > 0 ? `$${value}` : '---');

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
};
