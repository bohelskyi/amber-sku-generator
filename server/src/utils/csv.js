function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
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
};
