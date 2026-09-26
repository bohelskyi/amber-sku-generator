// Read stored evidence only. This does not change the export CSV serializer.
function readStoredCsv(input) {
  if (typeof input !== 'string') throw new Error('CSV_NOT_TEXT');
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let state = 'start';
  let recordStarted = false;
  const cell = () => { row.push(value); value = ''; state = 'start'; };
  const record = () => { cell(); rows.push(row); row = []; recordStarted = false; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    recordStarted = true;
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index += 1; }
        else state = 'closed';
      } else value += char;
      continue;
    }
    if (char === ',') { cell(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record();
      continue;
    }
    if (state === 'closed') throw new Error('CSV_TRAILING_QUOTE_DATA');
    if (char === '"') {
      if (state !== 'start') throw new Error('CSV_UNEXPECTED_QUOTE');
      state = 'quoted';
    } else { value += char; state = 'unquoted'; }
  }
  if (state === 'quoted') throw new Error('CSV_UNCLOSED_QUOTE');
  if (recordStarted) record();
  return rows;
}

module.exports = { readStoredCsv };
