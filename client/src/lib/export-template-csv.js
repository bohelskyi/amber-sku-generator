// Read-only RFC-style CSV presentation. Never serialize or alter server bytes.
export function parsePreviewCsv(csv) {
  if (typeof csv !== 'string') throw new Error('Відсутній CSV сервера.');
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  const source = csv.startsWith('\ufeff') ? csv.slice(1) : csv;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && source[i + 1] === '\n') i++; }
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Некоректні лапки CSV. Використайте технічний перегляд.'); cell += c; }
  }
  if (quoted) throw new Error('Незакриті лапки CSV.');
  if (cell !== '' || row.length || closed) rows.push([...row, cell]);
  const headers = rows.shift() || [];
  if (rows.some((r) => r.length !== headers.length)) throw new Error('Неповний рядок CSV.');
  return { headers, rows };
}
