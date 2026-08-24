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
