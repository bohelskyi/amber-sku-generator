function roundUah(value) {
  if (value === null || value === undefined || value === '') return null;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue) : null;
}

function roundAutomaticUah(value) {
  if (value === null || value === undefined || value === '') return null;

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  if (numericValue <= 100) return numericValue;

  let increment;
  if (numericValue < 300) increment = 10;
  else if (numericValue < 5000) increment = 50;
  else if (numericValue < 25000) increment = 100;
  else if (numericValue < 100000) increment = 500;
  else increment = 1000;

  return Math.floor((numericValue / increment) + 0.5) * increment;
}

function toUahNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

module.exports = { roundAutomaticUah, roundUah, toUahNumber };
