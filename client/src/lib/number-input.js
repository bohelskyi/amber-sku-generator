export const handleNumberWheel = (event) => {
  if (document.activeElement === event.currentTarget) {
    event.currentTarget.blur();
  }
};

export const handleNumberKeyDown = (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
  }
};

export const normalizeDecimalInput = (value) => String(value ?? '').replace(/,/g, '.');

export function getMatrixPriceValidationError(value) {
  const normalizedValue = normalizeDecimalInput(value).trim();
  if (!normalizedValue) return '';
  const parsedValue = Number(normalizedValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? ''
    : 'Ціна в матриці повинна бути більшою за 0.';
}
