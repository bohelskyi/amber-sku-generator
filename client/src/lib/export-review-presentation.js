export const dateText = (value) => value ? new Date(value).toLocaleString('uk-UA') : 'Немає даних';
const parsedFiles = new WeakMap();

// Same strict CSV presentation contract, scanning slices instead of retaining one
// concatenated string node per character of large quoted SEO/category values.
// The existing Template Builder parser and its behavior remain untouched.
export function parseReviewCsv(csv) {
  if (typeof csv !== 'string') throw new Error('Відсутній CSV сервера.');
  const source = csv.startsWith('\ufeff') ? csv.slice(1) : csv;
  const rows = []; let row = []; let chunks = []; let start = 0; let quoted = false; let closed = false;
  const cell = (end) => closed ? chunks.join('') : source.slice(start, end);
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        chunks.push(source.slice(start, i));
        if (source[i + 1] === '"') { chunks.push('"'); i++; }
        else { quoted = false; closed = true; }
        start = i + 1;
      }
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(cell(i)); chunks = []; closed = false;
      if (char !== ',') { rows.push(row); row = []; if (char === '\r' && source[i + 1] === '\n') i++; }
      start = i + 1;
    } else if (char === '"' && i === start && !closed) { quoted = true; start = i + 1; }
    else if (closed || char === '"') throw new Error('Некоректні лапки CSV. Використайте технічний перегляд.');
  }
  if (quoted) throw new Error('Незакриті лапки CSV.');
  if (start < source.length || row.length || closed) rows.push([...row, cell(source.length)]);
  const headers = rows.shift() || [];
  if (rows.some((r) => r.length !== headers.length)) throw new Error('Неповний рядок CSV.');
  return { headers, rows };
}

// CSV parsing is per immutable file/evidence, never per focus, filter, width or page.
export function parseReviewFile(file, stored = false) {
  const cached = parsedFiles.get(file);
  if (cached?.stored === stored) return cached.result;
  if (file.rows && file.headers) return { headers: file.headers, rows: file.rows };
  const parsed = parseReviewCsv(file.csvContent);
  const skuIndex = parsed.headers.indexOf('sku'); const languageIndex = parsed.headers.indexOf('store_view_code');
  const result = { headers: parsed.headers, rows: parsed.rows.map((values, index) => ({
    ordinal: index + 1, sku: values[skuIndex] || '', language: values[languageIndex] === 'en' ? 'en' : 'main',
    readiness: stored ? 'stored' : 'ready', issues: [],
    cells: values.map((value) => ({ state: value === '' ? 'blank' : 'final', value })),
  })) };
  parsedFiles.set(file, { stored, result });
  return result;
}

