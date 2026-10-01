// Built-client browser smoke with local API fixtures only. No real auth, DB, or Magento.
// node scripts/test-client-browser.mjs <Chromium-or-Edge-executable>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const WebSocket = require('ws'); // Existing jsdom dependency; no added application dependency.
const executable = process.argv[2];
assert.ok(executable && existsSync(executable), 'Provide an installed Chromium/Edge executable');
const directory = mkdtempSync(path.join(tmpdir(), 'amber-wave1-browser-'));
const profile = path.join(directory, 'profile');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
const permissions = ['products.view', 'products.decode', 'products.create', 'products.recount', 'history.view',
  'corrections.view', 'corrections.create', 'exports.view', 'exports.create', 'export_templates.view',
  'catalog.view', 'pricing.view', 'repricing.view', 'users.manage', 'roles.manage', 'audit.view'];
const product = { id: 7, full_sku: 'SV227002', status: 'active', public_sku: 'AG-000002', magento_name_review_required: false,
  weight: 10, total_price_uah: '100', details: {} };
const category = { code: 'SV', name: 'Сувеніри', requires_weight: 1 };
let syncState = 'needs_attention';
const requests = [];
const namePair = { amber: { all: 'Назва Amber', en: 'Amber name' }, magento: { all: 'Назва Magento', en: 'Magento name' } };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname.startsWith('/api/')) {
    let body = ''; for await (const part of request) body += part;
    requests.push({ path: url.pathname, method: request.method, body });
    let data;
    switch (url.pathname) {
      case '/api/auth/me': data = { identity: { issuer: 'https://fixture.example.invalid', sub: 'fixture', name: 'Богдан '.repeat(50) },
        applicationUser: { id: 1, status: 'active' }, csrfToken: 'fixture-only', permissions, roles: [] }; break;
      case '/api/config': data = { categories: { SV: category }, questions: { SV: [] } }; break;
      case '/api/products': data = [{ ...product, full_sku: `SV${'2'.repeat(80)}`, category: 'SV' }]; break;
      case '/api/export/status': data = { delivery: { legacyProductCsvEnabled: false, automaticSyncEnabled: true }, countSinceLastExport: 50 }; break;
      case '/api/price-export/status': data = { pendingCount: 0, excludedPendingCount: 0 }; break;
      case '/api/decode': data = { sku: product.full_sku, publicSku: product.public_sku, internalSku: product.full_sku,
        category, product, existsInDb: true, decodedAnswers: [], skuSchema: { version: 1 }, suffix: { type: 'sequence', value: 2 }, calibration: { status: 'known' }, pricing: null }; break;
      case '/api/product-timeline': data = { querySku: 'AG-000002', lineage: { currentSku: product.full_sku, currentPublicSku: product.public_sku,
        integrity: 'ok', products: [{ productId: 7, sku: product.full_sku, publicSku: product.public_sku,
          categoryCode: 'SV', status: 'active', magentoNameReviewRequired: product.magento_name_review_required,
          magentoSync: { state: product.magento_name_review_required ? 'needs_attention' : 'pending' } }] }, events: [] }; break;
      case '/api/magento/summary': data = { enabled: true, problemCount: syncState === 'needs_attention' ? 1 : 0 }; break;
      case '/api/magento/product-status/7': data = { state: syncState, nameConflict: syncState === 'needs_attention' }; break;
      case '/api/magento/problems': data = syncState === 'needs_attention' ? [{ productId: 7, article: product.public_sku,
        problems: [{ code: 'NAME_CONFLICT', message: 'Назву змінено і в Amber, і в Magento. Виберіть актуальну.', resolution: 'name' }], nameConflict: namePair }] : []; break;
      case '/api/magento/name-resolution/preview': data = { ...namePair, choice: JSON.parse(body).choice, previewToken: 'fixture-proof' }; break;
      case '/api/magento/name-resolution/apply': syncState = 'pending'; data = { state: syncState }; break;
      default: response.statusCode = 404; data = { error: `Unexpected fixture API: ${url.pathname}` };
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); return;
  }
  const asset = url.pathname.startsWith('/assets/');
  const filename = path.join(dist, asset ? path.basename(url.pathname) : 'index.html');
  const resolved = asset ? path.join(dist, 'assets', path.basename(url.pathname)) : filename;
  if (!existsSync(resolved)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', resolved.endsWith('.js') ? 'text/javascript' : resolved.endsWith('.css') ? 'text/css' : resolved.endsWith('.png') ? 'image/png' : 'text/html');
  response.end(readFileSync(resolved));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !existsSync(portFile) && attempt < 100; attempt += 1) await pause(100);
  assert.ok(existsSync(portFile), 'Headless browser did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const browserErrors = [];
  const pending = new Map();
  socket.on('message', (message) => { const data = JSON.parse(String(message));
    if (data.method === 'Runtime.exceptionThrown') browserErrors.push(data.params.exceptionDetails);
    const entry = pending.get(data.id);
    if (entry) { pending.delete(data.id); if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result); } });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const data = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (data.exceptionDetails) throw new Error(JSON.stringify(data.exceptionDetails)); return data.result.value; };
  const wait = async (expression) => { for (let attempt = 0; attempt < 100; attempt += 1) { if (await evaluate(expression)) return; await pause(100); }
    throw new Error(`Browser condition failed: ${expression}\n${await evaluate('document.body.textContent')}\n${JSON.stringify(browserErrors)}\n${JSON.stringify(requests.slice(-12))}`); };
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const checks = [];
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: origin });
    await wait("document.querySelector('h1')?.textContent === 'Товари'");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `body overflow at ${width}px`);
    const links = await evaluate("[...document.querySelectorAll('.workspace-nav a:not(.workspace-brand)')].filter(a=>a.getBoundingClientRect().width>0).map(a=>a.getAttribute('href'))");
    assert.deepEqual(links, ['/', '/admin/repricing', '/sync-problems', '/settings']);
    assert.equal(await evaluate("[...document.querySelectorAll('.daily-links a')].every(a=>{ const r=a.getBoundingClientRect(); return r.left>=0 && r.right<=document.documentElement.clientWidth; })"), true, `all daily destinations visible at ${width}px`);
    assert.equal(new Set(links).size, 4, `duplicate visible destination at ${width}px`);
    assert.equal(await evaluate("!!document.querySelector('.navigation-count')"), true);
    if (width <= 390) assert.ok(await evaluate("document.querySelector('.workspace-nav').getBoundingClientRect().height") <= 110, 'compact mobile header');
    await evaluate("document.querySelector('.daily-links a').focus()");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("document.activeElement.getAttribute('href') === '/admin/repricing'"), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `focused navigation overflow at ${width}px`);
    assert.equal(await evaluate("document.querySelector('[aria-controls=workspace-more-links]') === null"), true);
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(directory, `navigation-${width}.png`), Buffer.from(shot.data, 'base64'));
    checks.push({ width, noOverflow: true, uniqueVisibleRoutes: links.length, keyboard: true });
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/exports` });
  await wait("document.body.textContent.includes('Доставку товарів через CSV вимкнено')");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>/Створити файли|Перевірити діапазон/.test(b.textContent))"), false);
  await command('Page.navigate', { url: `${origin}/sync-problems` });
  await wait("document.body.textContent.includes('Назву змінено і в Amber')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>/Повторити|Retry/.test(b.textContent))"), false);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Вибрати актуальну назву').click()");
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Підтвердити вибір' && !b.disabled)");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  const dialog = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(directory, 'name-conflict-390.png'), Buffer.from(dialog.data, 'base64'));
  await evaluate("[...document.querySelectorAll('input[type=radio]')].at(-1).click()");
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Підтвердити вибір' && !b.disabled)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Підтвердити вибір').click()");
  await wait("!document.querySelector('[role=dialog]') && document.body.textContent.includes('Невирішених проблем немає')");
  await command('Page.navigate', { url: `${origin}/?article=AG-000002` });
  await wait("document.body.textContent.includes('Magento: Очікує синхронізації')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Оновити стан Magento')?.textContent"), '');
  const applies = requests.filter((request) => request.path === '/api/magento/name-resolution/apply');
  assert.equal(applies.length, 1);
  assert.deepEqual(JSON.parse(applies[0].body), { productId: 7, choice: 'magento', previewToken: 'fixture-proof' });
  assert.equal(requests.filter((request) => request.method !== 'GET' && !['/api/decode','/api/magento/name-resolution/preview','/api/magento/name-resolution/apply'].includes(request.path)).length, 0);
  console.log(JSON.stringify({ result: 'passed', checks, nameReconciliation: 'reviewed Magento choice applied once, queue cleared, pending status refreshed', artifacts: directory }));
} finally {
  socket?.close(); browser.kill();
  await new Promise((resolve) => server.close(resolve));
  await pause(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser profile may still be closing */ }
}
