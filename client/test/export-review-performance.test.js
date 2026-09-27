import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { parseReviewFile, parseReviewCsv } from '../src/lib/export-review-presentation.js';
import { parsePreviewCsv } from '../src/lib/export-template-csv.js';

test('UX3 slice parser preserves exact CSV presentation including quoted multiline/empty/formula text and rejects malformed input', () => {
  for (const csv of ['', '""', 'a,', '\ufeffsku,name\r\nA,"\' =SUM(1,2)"\r\n', 'a,b\n"a""b","\r\n"', 'a,b\r1,2\r', 'a\n""\n']) {
    assert.deepEqual(parseReviewCsv(csv), parsePreviewCsv(csv));
  }
  for (const csv of ['a\n"', 'a,b\n1', 'a\n"b"tail', 'a\nb"c']) assert.throws(() => parseReviewCsv(csv));
});

for (const products of [100, 1000, 5000]) for (const columns of [32, 64]) {
  test(`UX3 presentation ${products} products, two files, ${columns} columns and long quoted cells`, () => {
    const headers = ['sku', 'store_view_code', ...Array.from({ length: columns - 2 }, (_, i) => `field_${i}`)];
    const quote = (value) => `"${value.replaceAll('"', '""')}"`;
    const long = 'Категорія, "SEO"\n'.repeat(100);
    const files = ['BR', 'SV'].map((group) => ({ groupCode: group,
      csvContent: [headers.join(','), ...Array.from({ length: products }, (_, i) => [group + Math.floor(i / 2), i % 2 ? 'en' : '',
        ...Array.from({ length: columns - 2 }, (_, c) => c === 0 ? quote(long) : c === 1 ? quote("'=formula") : 'value')].join(','))].join('\n') }));
    const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.csvContent), 0);
    assert.ok(bytes < 64 * 1024 * 1024, 'fixture respects existing output ceiling');
    const heap = process.memoryUsage().heapUsed; const started = performance.now();
    const parsed = files.map((f) => parseReviewFile(f)); const parsingMs = performance.now() - started;
    assert.equal(parsed[0].headers.length, columns); assert.equal(parsed[1].rows.length, products);
    const cached = performance.now(); assert.equal(parseReviewFile(files[0]), parsed[0]); const cacheMs = performance.now() - cached;
    const filtering = performance.now(); const selected = parsed[0].rows.filter((r) => r.sku.includes('1') && r.language === 'en').slice(50, 100); const filterMs = performance.now() - filtering;
    assert.ok(selected.length <= 50); assert.equal(parsed[0].rows[0].cells[2].value, long);
    console.log(JSON.stringify({ products, columns, files: 2, bytes, parsingMs: +parsingMs.toFixed(1), cacheMs: +cacheMs.toFixed(3), filterMs: +filterMs.toFixed(2), heapGrowthMiB: +((process.memoryUsage().heapUsed - heap) / 1048576).toFixed(1), processPeakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) }));
  });
}
