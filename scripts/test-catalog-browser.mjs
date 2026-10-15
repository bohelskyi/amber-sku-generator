// Built-client browser verification against local HTTP fixtures only.
// Fixture auth is not a real login or human acceptance. No database or Magento is used.
// node scripts/test-catalog-browser.mjs <installed Chromium/Edge executable>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const WebSocket = require('ws');
const executable = process.argv[2];
assert.ok(executable && existsSync(executable), 'Provide an installed Chromium/Edge executable');
const directory = mkdtempSync(path.join(tmpdir(), 'amber-catalog-browser-'));
const profile = path.join(directory, 'profile');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
assert.ok(existsSync(path.join(dist, 'index.html')), 'Build the client first');
const permissions = ['products.view', 'exports.view', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'catalog.view', 'catalog.manage'];
const requests = [], unexpected = [];
const localOptions = Array.from({ length: 61 }, (_, id) => ({ id, db_id: 100 + id, label: `Колір ${id}`, label_en: `Color ${id}`, sku_code: String(id) }));
const config = { categories: { BR: { code: 'BR', name: 'Браслети', requires_weight: 1 } },
  questions: { BR: [{ id: 'color', q_db_id: 84, label: 'Колір', input_type: 'options', include_in_sku: 1, options: localOptions }] },
  extraConfig: {}, catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } };
const category = { code: 'BR', name: 'Браслети', unboundCount: 0, operational: { count: 0 } };
const revision = { id: 'current', revision: '4', state: 'published', templateId: 'original', templateVersionId: 'original-version' };
const literal = (value) => ({ op: 'literal', value });
const definition = { evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1', outputContract: 'magento-products-columns-v2',
  sources: { color: { kind: 'semantic', category: 'BR', key: 'color', type: 'scalar' } }, tables: {}, bindings: [],
  groups: [{ route: 'BR', columns: ['name', 'description', 'kolir', 'categories'], rows: [
    { id: 'base', cells: { name: literal('Браслет'), description: literal('Опис'), kolir: { op: 'source', id: 'color' }, categories: literal('Default/Браслети') } },
    { id: 'english', cells: { name: literal('Bracelet'), description: literal('Description'), kolir: literal(''), categories: literal('') } },
  ] }] };
const attributes = [
  { code: 'name', target: 'name', label: 'Назва', text: true, inputType: 'text' },
  { code: 'description', target: 'description', label: 'Опис', text: true, inputType: 'text' },
  { code: 'kolir', target: 'kolir', label: 'Колір Magento', text: false, inputType: 'select' },
  { code: 'categories', target: 'categories', label: 'Категорії магазину', text: false, inputType: 'text' },
].map((item) => ({ ...item, editable: true, configured: true, sources: [], state: 'connected', policy: 'authoritative_create_update', policyApproved: true }));
attributes.push({ code: 'texture', target: 'texture', label: 'Фактура магазину', text: false, inputType: 'select', editable: true, configured: false, state: 'unmapped', sources: [] });
const projection = (rowId) => ({ category, revision, template: { definition, versionId: revision.templateVersionId },
  groupIndex: 0, rowIndex: rowId === 'english' ? 1 : 0, observedAt: '2026-10-01T00:00:00Z', routeKey: 'BR:all', routes: [{ routeKey: 'BR:all', setName: 'Браслети' }],
  questions: config.questions.BR.map((question) => ({ ...question, uses: question.id === 'color' ? [{ target: 'kolir', rowId: 'base' }] : [] })), attributes, unboundCount: 0 });
let created = false, previewFamily = null, overviewUnavailable = false;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : null; requests.push({ path: url.pathname, method: request.method, body });
    let data;
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/auth/me': data = { identity: { issuer: 'https://fixture.example.invalid', sub: 'catalog-fixture', name: 'Оператор' }, applicationUser: { id: 1, status: 'active' }, csrfToken: 'fixture-only', permissions, roles: [] }; break;
      case 'GET /api/admin/config': case 'GET /api/config': data = config; break;
      case 'GET /api/magento/summary': data = { enabled: true, problemCount: 0 }; break;
      case 'GET /api/admin/magento-integration/overview': if (overviewUnavailable) { response.statusCode = 503; data = { error: 'Fixture connection unavailable' }; } else data = { categories: [category], integration: { activePublication: revision } }; break;
      case 'GET /api/admin/magento-integration/categories/BR': data = projection(url.searchParams.get('rowId')); break;
      case 'GET /api/admin/magento-integration/categories/BR/fields/kolir': data = { attribute: attributes[2], options: localOptions.map((item) => ({ value: String(item.id + 1000), label: item.label })), entries: localOptions.map((item) => ({ id: `option:color:${item.id}`, kind: 'option', group: 'BR', row: 'base', target: 'kolir', routeKey: 'BR:all', source: `BR.color=value_id:${item.id}`, evaluated: item.label, identity: String(item.id + 1000), reviewState: 'approved' })) }; break;
      case 'GET /api/admin/magento-integration/categories/BR/fields/name': case 'GET /api/admin/magento-integration/categories/BR/fields/categories': data = { attribute: {}, options: [], entries: [] }; break;
      case 'GET /api/admin/export-templates/sources': data = { nativeCharacteristicsAuthoring: true, productFields: ['public_sku'], references: { questions: config.questions.BR.map((question) => ({ category_code: 'BR', key: question.id, label: question.label, input_type: question.input_type, include_in_sku: 1, archived: false })), schemas: [{ category_code: 'BR', questions: [{ key: 'color' }] }] } }; break;
      case 'GET /api/admin/export-templates/source-details': data = { current: [{ options: (config.questions.BR.find((question) => question.id === url.searchParams.get('key'))?.options || []).map((item) => ({ value_id: String(item.id), label: item.label, label_en: item.label_en })) }] }; break;
      case 'GET /api/admin/magento-integration': data = { revision: { ...revision, schema: { attributeSets: [{ attribute_set_id: 1, attribute_set_name: 'Браслети', attributeCodes: ['texture'] }], attributes: [{ attribute_code: 'texture', default_frontend_label: 'Фактура магазину', frontend_input: 'select' }] }, bindings: { routes: [{ routeKey: 'BR:all', setId: 1 }] } } }; break;
      case 'POST /api/admin/question': assert.equal(created, false); assert.equal(body.label, 'Фактура'); assert.equal(Object.hasOwn(body, 'key'), false); created = true; config.questions.BR.push({ ...body, id: 'q_exact_server', q_db_id: 901, options: [] }); data = { id: 901, key: 'q_exact_server' }; break;
      case 'GET /api/admin/export-templates/sample-products': data = { products: [{ id: 21, category: 'BR', public_sku: 'AG-000021', status: 'active' }], nextOffset: null }; break;
      case 'POST /api/admin/export-templates': previewFamily = { id: 'example', draft: { revision: '1', definitionHash: 'example-hash', definition: body.definition } }; data = previewFamily; break;
      case 'POST /api/admin/export-templates/example/test-preview':
        assert.deepEqual(body.productIds, [21]); data = { revision: '1', definitionHash: 'example-hash', result: { artifacts: [{ groupCode: 'BR', csvContent: 'store_view_code,name\n,Браслет: приклад UA\nen,Bracelet: EN example\n' }], errors: [] } }; break;
      case 'POST /api/admin/magento-integration/discovery': data = { observedAt: '2026-10-15T12:00:00Z', categories: [
        { categoryId: 8, path: 'Default/Браслети', normalizedPath: 'Default/Браслети', comparable: true },
        { categoryId: 9, path: 'Default/Нові браслети', normalizedPath: 'Default/Нові браслети', comparable: true },
      ] }; break;
      default: unexpected.push({ path: url.pathname, method: request.method }); response.statusCode = 404; data = { error: `Unexpected local fixture API: ${request.method} ${url.pathname}` };
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); return;
  }
  const filename = url.pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(url.pathname)) : path.join(dist, 'index.html');
  if (!existsSync(filename)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html'); response.end(readFileSync(filename));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
let command;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !existsSync(portFile) && attempt < 100; attempt++) await pause(100);
  assert.ok(existsSync(portFile), 'Headless browser did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map(); const browserErrors = []; const blockedExternal = [];
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.on('message', (message) => {
    const data = JSON.parse(String(message));
    if (data.method === 'Runtime.exceptionThrown') browserErrors.push(data.params.exceptionDetails);
    if (data.method === 'Fetch.requestPaused') {
      const url = data.params.request.url;
      // Navigation/AbortController can cancel a paused request before CDP handles
      // our response. Ignore only that exact expired-interception race.
      const completed = (error) => { if (error.message !== 'Invalid InterceptionId.') browserErrors.push({ interceptionError: error.message }); };
      if (url.startsWith(`${origin}/`)) void command('Fetch.continueRequest', { requestId: data.params.requestId }).catch(completed);
      else { blockedExternal.push(url); void command('Fetch.failRequest', { requestId: data.params.requestId, errorReason: 'BlockedByClient' }).catch(completed); }
    }
    const entry = pending.get(data.id);
    if (entry) { pending.delete(data.id); if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result); }
  });
  const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await pause(100); }
    throw new Error(`Browser condition failed: ${expression}\n${await evaluate('document.body.textContent')}\n${JSON.stringify(browserErrors)}\n${JSON.stringify(requests.slice(-10))}`);
  };
  const click = (text) => evaluate(`(() => { const scope=[...document.querySelectorAll('[role=dialog]')].at(-1)||document; const target=[...scope.querySelectorAll('button,a,summary')].find(element=>element.textContent.trim()===${JSON.stringify(text)}); if(!target) throw new Error('Missing action: '+${JSON.stringify(text)}+'; available: '+[...document.querySelectorAll('button,a,summary')].map(element=>element.textContent.trim()).join(' | ')); target.click(); })()`);
  const setField = (label, value) => evaluate(`(() => { const field=[...document.querySelectorAll('label')].find(label=>label.childNodes[0]?.textContent.trim()===${JSON.stringify(label)}).querySelector('input,select');
    Object.getOwnPropertyDescriptor(field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)}); field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const navigate = async (route) => { await command('Page.navigate', { url: `${origin}${route}` }); await wait("!!document.querySelector('h1')"); };
  const noOverflow = async (label) => assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'), true, label);
  const screenshot = async (name) => {
    const metrics = await command('Page.getLayoutMetrics');
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: await evaluate('window.innerWidth'), height: Math.min(metrics.cssContentSize.height, 4000), scale: 1 } });
    writeFileSync(path.join(directory, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await command('Page.enable'); await command('Runtime.enable');
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: "window.fixtureCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fixtureCopies.push(text)}}});" });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const checks = [];
  for (const width of [1440, 390, 360]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await navigate('/admin/catalog?category=BR'); await wait("!!document.querySelector('[aria-label=\"Характеристики Менеджера\"]')");
    assert.equal(await evaluate("document.querySelector('h1').textContent"), 'Каталог');
    await noOverflow(`Catalog overflow ${width}px`);
    await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Додати характеристику').focus()");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("document.activeElement.matches('a,button,input,select,summary') && Number.parseFloat(getComputedStyle(document.activeElement).outlineWidth)>0"), true);
    await screenshot(`catalog-${width}`); checks.push({ width, keyboardFocus: true, noOverflow: true });
  }
  await click('Додати характеристику'); await wait("!![...document.querySelectorAll('label')].find(label => label.textContent.includes('Назва характеристики'))");
  await setField('Назва характеристики', 'Фактура'); await click('Зберегти характеристику');
  await wait("document.body.textContent.includes('Характеристику створено')");
  assert.equal(requests.filter((item) => item.method !== 'GET').length, 1, 'Local creation must not write Magento');
  await screenshot('local-characteristic-saved-360'); await click('Налаштувати передавання');
  await wait("!!document.querySelector('[aria-label=\"Передавання в магазин\"]') || document.body.textContent.includes('Вибрати наявний атрибут')");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('question')"), 'q_exact_server');
  await click('Вибрати наявний атрибут'); await wait("!![...document.querySelectorAll('label')].find(label=>label.childNodes[0]?.textContent.trim()==='Атрибут магазину')"); await setField('Атрибут магазину', 'texture'); await click('Продовжити налаштування');
  await wait("!!document.querySelector('[role=combobox]') && document.querySelector('[role=combobox]').value.includes('Фактура')");
  assert.equal(await evaluate("[...document.querySelectorAll('code')].some(code=>code.textContent.includes('BR.q_exact_server'))"), true, 'New mapping retains the exact server characteristic source');
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(label=>label.childNodes[0]?.textContent==='Код поля Magento').querySelector('input').value"), 'texture');
  await screenshot('exact-new-source-360'); await click('Скасувати'); await wait("document.body.textContent.includes('Відкинути введення поля')"); await click('Відкинути введення поля');
  await navigate('/admin/catalog?category=BR&field=kolir');
  await wait("!!document.querySelector('[aria-label=\"Magento для Колір 0\"]')");
  await screenshot('mapping-360');
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Менеджер — Magento: значення\"] tbody tr').length"), 25);
  await evaluate("[...document.querySelectorAll('[aria-label=\"Сторінки значень\"] button')].find(button => button.textContent==='Далі').click()");
  await wait("!!document.querySelector('[aria-label=\"Magento для Колір 25\"]')");
  await setField('Пошук значення', 'Колір 60'); await wait("!!document.querySelector('[aria-label=\"Magento для Колір 60\"]')");
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Менеджер — Magento: значення\"] tbody tr').length"), 1);
  assert.equal(requests.filter((item) => item.method !== 'GET').length, 1, 'Opening and paging mappings cannot mutate');
  checks.push({ createdCharacteristic: 'q_exact_server', localReceipt: 'retained', mapping: 'existing attribute; 25 per page; search resets page; no mutation' });
  await navigate('/admin/catalog?category=BR&tab=text&field=name');
  await wait("document.body.textContent.includes('Приклад на товарі')");
  await setField('Пошук за артикулом або внутрішнім SKU', 'AG-21'); await wait("document.body.textContent.includes('Обрати AG-000021')"); await click('Обрати AG-000021');
  await click('Оновити приклад'); await wait("!!document.querySelector('[aria-label=\"Приклад UA\"]')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Приклад UA\"]').textContent.includes('Браслет: приклад UA') && document.querySelector('[aria-label=\"Приклад EN\"]').textContent.includes('Bracelet: EN example')"), true);
  await noOverflow('Text example overflow 360px'); await evaluate("document.querySelector('[aria-label=\"Приклад EN\"]').scrollIntoView({block:'center'})"); await screenshot('text-example-360');
  checks.push({ textPreview: 'server fixture UA and EN, exact product, isolated unpublished family' });
  overviewUnavailable = true; const writesBeforeOffline = requests.filter((item) => item.method !== 'GET').length;
  await navigate('/admin/catalog?category=BR'); await wait("document.body.textContent.includes('Налаштування магазину недоступні')"); await click('Фактура');
  await wait("!![...document.querySelectorAll('label')].find(label=>label.childNodes[0]?.textContent==='Назва характеристики')?.querySelector('input')");
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(label=>label.childNodes[0]?.textContent==='Назва характеристики').querySelector('input').value"), 'Фактура');
  await screenshot('local-editor-store-unavailable-360'); await click('Готово');
  assert.equal(requests.filter((item) => item.method !== 'GET').length, writesBeforeOffline);
  checks.push({ offline: 'saved exact characteristic remains editable without store connection' }); overviewUnavailable = false;
  await navigate('/admin/catalog?category=BR&view=placement'); await wait("!!document.querySelector('[aria-label=\"Редагувати розміщення Default/Браслети\"]')");
  await evaluate("document.querySelector('[aria-label=\"Редагувати розміщення Default/Браслети\"]').click()");
  await wait("document.body.textContent.includes('Змінити розміщення')"); await click('Прочитати розділи магазину'); await wait("document.body.textContent.includes('Default › Нові браслети')");
  await click('Default › Нові браслети'); await click('Зберегти розміщення в правилі'); await click('Готово');
  await wait("!document.querySelector('[role=dialog]') && document.body.textContent.includes('Default › Нові браслети')");
  await noOverflow('Placement table overflow 360px'); await screenshot('placement-table-360');
  checks.push({ placement: 'exact existing table row edited locally, no publication' });
  assert.deepEqual(unexpected, []); assert.deepEqual(blockedExternal, []); assert.deepEqual(browserErrors, []);
  const allowedWrites = ['/api/admin/question', '/api/admin/export-templates', '/api/admin/export-templates/example/test-preview', '/api/admin/magento-integration/discovery'];
  assert.deepEqual(requests.filter((item) => item.method !== 'GET' && !allowedWrites.includes(item.path)), []);
  console.log(JSON.stringify({ result: 'passed', authentication: 'fixture only; no real login or human acceptance', checks, requestCount: requests.length, runtimeErrors: browserErrors.length, externalRequests: blockedExternal.length, artifacts: directory }));
} finally {
  try { await command?.('Browser.close'); } catch { /* Browser closes the socket before acknowledging. */ }
  await Promise.race([
    new Promise((resolve) => browser.exitCode !== null ? resolve() : browser.once('exit', resolve)),
    pause(3000),
  ]);
  socket?.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const resolvedProfile = path.resolve(profile);
  assert.ok(resolvedProfile.startsWith(`${path.resolve(directory)}${path.sep}`), 'Temporary browser profile must stay inside the created artifact directory');
  try { rmSync(resolvedProfile, { recursive: true, force: true }); } catch { /* Browser profile can finish closing after screenshots are written. */ }
}
