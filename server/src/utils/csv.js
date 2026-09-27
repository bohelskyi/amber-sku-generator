function finalizeCsvValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(value)
    ? `'${value}`
    : String(value);
}

function escapeCsvValue(value) {
  const stringValue = finalizeCsvValue(value);
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildCsv(rows) {
  return rows
    .map((row) => row.map((value) => escapeCsvValue(value)).join(','))
    .join('\n');
}

module.exports = {
  buildCsv,
  escapeCsvValue,
  finalizeCsvValue,
};
