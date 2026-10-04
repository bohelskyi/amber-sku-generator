// Built-client browser verification against local HTTP fixtures only.
// Fixture auth is not a real login or human acceptance. No database or Magento is used.
// node scripts/test-magento-workspace-browser.mjs <installed Chromium/Edge executable>
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
const { materializeMagentoV1 } = require('../server/src/services/export-templates/magento-v1-definition');
const { catalog } = require('../server/test/fixtures/magento-v1/contract');
const definition = materializeMagentoV1(catalog());
const template = { id: 'template', display_name: 'Правила Magento', draft: { revision: '4', definitionHash: 'fixture-hash', definition }, versions: [{ id: 'template-version', versionNumber: '3', definition }] };
const executable = process.argv[2];
assert.ok(executable && existsSync(executable), 'Provide an installed Chromium/Edge executable');
const directory = mkdtempSync(path.join(tmpdir(), 'amber-magento-browser-'));
const profile = path.join(directory, 'profile');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
assert.ok(existsSync(path.join(dist, 'index.html')), 'Build the client first');
const permissions = ['products.view', 'products.decode', 'products.create', 'history.view', 'exports.view', 'exports.create',
  'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'catalog.view', 'catalog.manage'];
let administrator = false;
const requests = [];
const unexpected = [];
const schema = { attributeSets: [{attribute_set_id:151,attribute_set_name:'Сувеніри',attributeCodes:['fixture_choice']}],
  attributes: [{ attribute_id: 1471, attribute_code: 'fixture_choice', default_frontend_label:'Вид', is_user_defined:true, frontend_input: 'select', options: [] }] };
const binding = { id: 'published', revision: '4', versionNumber: 3, state: 'published', templateId: 'template', templateVersionId: 'template-version',
  publishedAt: '2026-10-01T12:00:00Z', observedAt: '2026-10-01T10:00:00Z', schema,
  bindings: { routes: [{ routeKey: 'SV:normal',enabled:true,reviewState:'approved',setId:151 }, { routeKey: 'SV:stone',enabled:true,reviewState:'approved',setId:151 }],
    attributes: ['normal', 'stone'].map((route) => ({ bindingKey: `category-${route}`, routeKey: `SV:${route}`, target: 'categories',
      evidence: { categories: [{ requestedPath: 'Root/Fixture', normalizedPath: 'root/fixture' }] } })) } };
const draft = { ...binding, id: 'draft', revision: '7', state: 'draft', versionNumber: null };
const observation = { observedAt: '2026-10-02T14:32:00Z', schema, categories: [
  { categoryId: 2, path: 'Root', normalizedPath: 'root', comparable: true },
  { categoryId: 8, path: 'Root/Fixture', normalizedPath: 'root/fixture', comparable: true },
] };
const values = Array.from({ length: 240 }, (_, i) => ({ questionKey: 'kind', questionLabel: 'Вид', valueId: String(i),
  label: i === 8 ? 'Скриньки' : `Готове значення ${i}`, labelEn: i === 8 ? 'Boxes' : `Value ${i}`, state: i === 8 || i % 2 ? 'approved' : 'not_applicable',
  mappings: i === 8 ? [{ attribute: 'fixture_choice', optionId: '42', state: 'approved' }] : [] }));
values.push({ questionKey: 'kind', questionLabel: 'Вид', valueId: 'missing', label: 'Потрібне значення', state: 'missing', mappings: [] });
values.push({ questionKey: 'stone_processing', questionLabel: 'Який камінь?', valueId: '0', skuCode: '0',
  label: 'Не оброблений камінь', state: 'approved', mappings: [{ routeKey: 'SV.souvenir=value_id:5', attribute: 'kamin_obrobka', optionId: '6040', optionLabel: 'Необроблений' }] });
const category = (code, name, count = 0, preparation = false) => ({ code, name, values: code === 'SV' ? values : [], routes: [],
  operational: { state: 'known', count, reasons: count ? [{ code: 'MAPPING', count, message: 'Потрібна перевірка відповідностей для поточного товару.' }] : [] },
  preparation: { needed: preparation, count: preparation ? 1 : 0, reasons: preparation ? [{ code: 'NOT_CONNECTED', count: 1, message: 'Ще не підключено' }] : [] }, impact: 'unexamined' });
const categories = [category('SV', 'Сувеніри', 1), category('XX', 'Майбутня категорія', 0, true), category('OK', 'Готова категорія')];
const publication = { id: binding.id, revision: binding.revision, versionNumber: binding.versionNumber, publishedAt: binding.publishedAt,
  templateId: binding.templateId, templateVersionId: binding.templateVersionId, templateVersionNumber: 3 };
const overview = { integration: { configured: true, activePublication: publication, delivery: { state: 'enabled' }, operational: { state: 'known', count: 1 },
  structureObservation: { observedAt: binding.observedAt, bindingId: binding.id, state: 'published' }, draftCount: 1, asOf: '2026-10-02T12:00:00Z' },
categories: categories.map(({ values: _values, routes: _routes, ...entry }) => entry) };
const config = { categories: { SV: { code: 'SV', name: 'Сувеніри', requires_weight: 0, sku_schema_version_id: 17 } }, questions: { SV: [] }, extraConfig: {} };
const saved = { id: 21, publicSku: 'AG-000021', fullSku: 'SV137001', internalSku: 'SV137001' };
const attributeActions = [];
let attributeMember = false;
let attributeProfile = null;
let createdCategory = null;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: url.pathname, method: request.method, body });
    let data;
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/auth/me': data = { identity: { issuer: 'https://fixture.example.invalid', sub: 'local-fixture', name: 'Оператор' },
        applicationUser: { id: 1, status: 'active' }, csrfToken: 'fixture-only', permissions,
        roles: administrator ? [{ id: 1, key: 'administrator', displayName: 'Адміністратор' }] : [{ id: 2, key: 'operator', displayName: 'Administrator' }] }; break;
      case 'GET /api/config': case 'GET /api/admin/magento-integration/creation-inputs': data = config; break;
      case 'GET /api/products': data = []; break;
      case 'POST /api/admin/category':
        assert.equal(createdCategory,null,'Category creation must not repeat during checkpoint reads');
        assert.deepEqual(body,{code:'ZZ',name:'Новий тип для перевірки',requires_weight:1,skip_hidden_sku_questions:0,marketing_rounding_enabled:1});
        createdCategory={code:body.code,name:body.name,values:[],ready:false,schema:null};
        data={id:body.code,name:body.name};break;
      case 'GET /api/admin/magento-integration/actions': data = attributeActions; break;
      case 'GET /api/admin/magento-integration/actions/attribute-assignment': data = attributeActions.find((action)=>action.id==='attribute-assignment'); break;
      case 'GET /api/admin/magento-integration/attributes/context': data = {sets:[{id:151,name:'Сувеніри'}],set:{id:151,name:'Сувеніри'},englishStoreId:3,
        groups:[{id:81,setId:151,name:'Основні характеристики'}],members:attributeMember?[{id:9901,code:'amber_fixture_texture'}]:[]}; break;
      case 'POST /api/admin/magento-integration/attributes/preview':
        assert.equal(body.required,false);assert.equal(body.scope,'global');
        attributeProfile={attribute_code:body.attributeCode,frontend_input:body.frontendInput,scope:body.scope,is_required:body.required,
          is_visible_on_front:body.visibleOnFront,is_searchable:body.searchable,is_filterable:body.filterable,is_filterable_in_search:body.filterableInSearch};
        data={kind:'attribute',label:body.label,target:{attributeCode:body.attributeCode},previewToken:'attribute-reviewed',body:{attribute:attributeProfile}}; break;
      case 'POST /api/admin/magento-integration/attributes/apply':
        assert.equal(body.previewToken,'attribute-reviewed');assert.equal(attributeActions.some((action)=>action.kind==='attribute'),false);
        data={id:'attribute-create',kind:'attribute',state:'verified',remoteId:'9901',attributeCode:body.attributeCode,label:body.label,attributeProfile,
          canReconcile:false,message:'Атрибут створено та перевірено. Підключіть його до потрібного набору.'};attributeActions.push(data);break;
      case 'POST /api/admin/magento-integration/attributes/assignment-preview':
        assert.equal(body.attributeCode,'amber_fixture_texture');assert.equal(body.attributeSetId,151);assert.equal(body.attributeGroupId,81);
        data={kind:'attribute_assignment',label:'Фактура поверхні',previewToken:'assignment-reviewed',body,
          target:{attributeCode:body.attributeCode,set:{id:151,name:'Сувеніри'},group:{id:81,name:'Основні характеристики'}}};break;
      case 'POST /api/admin/magento-integration/attributes/assignment-apply':
        assert.equal(body.previewToken,'assignment-reviewed');assert.equal(attributeMember,false);attributeMember=true;
        attributeActions.push({id:'attribute-assignment',kind:'attribute_assignment',state:'dispatched',attributeCode:'amber_fixture_texture',label:'Фактура поверхні',
          attributeSet:{id:151,name:'Сувеніри'},canReconcile:true,message:'Підключення надіслано. Результат ще не підтверджено.'});
        response.statusCode=409;data={error:'Підключення надіслано. Перевірте збережений результат.',details:{actionId:'attribute-assignment'}};break;
      case 'POST /api/admin/magento-integration/attributes/reconcile':
        assert.equal(body.actionId,'attribute-assignment');data=attributeActions.find((action)=>action.id===body.actionId);
        data.state='verified';data.canReconcile=false;data.assignmentPlacementVerified=false;data.message='Атрибут доступний у вибраному наборі. Правила передачі ще потрібно підключити.';break;
      case 'GET /api/products/register': data = { items: [], pageInfo: { hasMore: false, nextCursor: null },
        filterOptions: { categories: [{ code: 'SV', name: 'Сувеніри' }] } }; break;
      case 'GET /api/export/status': data = { delivery: { legacyProductCsvEnabled: false, automaticSyncEnabled: true } }; break;
      case 'GET /api/price-export/status': data = { pendingCount: 0, excludedPendingCount: 0 }; break;
      case 'GET /api/magento/summary': data = { enabled: true, problemCount: 1 }; break;
      case 'GET /api/admin/magento-integration/overview': data = overview; break;
      case 'GET /api/admin/export-templates': data = { templates: [template] }; break;
      case 'GET /api/admin/export-templates/template': data = template; break;
      case 'GET /api/admin/export-templates/sources': data = { references: { questions: [
        { category_code:'SV',key:'stone_processing',label:'Обробка каменю',include_in_sku:1,input_type:'options' },
      ], schemas: [{category_code:'SV',questions:[{key:'stone_processing'}]}] } }; break;
      case 'GET /api/admin/export-templates/source-details': data = {current:[{options:url.searchParams.get('key')==='stone_processing'?[{value_id:'0',label:'Не оброблений камінь'}]:[]}]}; break;
      case 'GET /api/admin/magento-integration': data = { revision: url.searchParams.get('bindingRevisionId') === 'draft' ? draft : binding,
        currentPublishedId: binding.id, categories:createdCategory?[...categories,createdCategory]:categories, revisions: [{ id: 'draft', state: 'draft', revision: '7', observed_at: draft.observedAt }],
        templateVersions: [{ id: 'template-version', display_name: 'Шаблон', version_number: 3 }], configured: true, limitations: [], products: [],
        catalog:createdCategory?{...config,questions:{...config.questions,[createdCategory.code]:[]}}:config }; break;
      case 'GET /api/admin/magento-integration/bindings/published': case 'GET /api/admin/magento-integration/bindings/draft':
        data = { revision: url.pathname.endsWith('/draft') ? draft : binding, entries: [], validation: { valid: true, diagnostics: [] } }; break;
      case 'GET /api/admin/magento-integration/bindings/published/handoffs': data = []; break;
      case 'GET /api/admin/magento-integration/bindings/published/controlled-products': data = { nextCursor: null, products: [
        { productId: 21, article: 'AG-000021', before: { all: 'Поточна назва', en: 'Current name' }, after: { all: 'Нова назва', en: 'New name' }, changed: true, blockers: [] },
        { productId: 22, article: 'AG-000022', before: { all: 'Непідтверджена доставка', en: 'Uncertain delivery' }, after: {}, changed: false, blockers: ['RECONCILIATION_REQUIRED'] },
      ] }; break;
      case 'POST /api/admin/magento-integration/discovery': data = observation; break;
      case 'POST /api/admin/magento-integration/structure-check': data = { ...observation, comparison: { state: 'checked', bindingRevisionId: binding.id, routesChecked: 2, attributesChecked: 1, productChecks: 0, findings: [] } }; break;
      case 'POST /api/preview': case 'POST /api/price-preview': data = { fullProposedSku: saved.fullSku, skuSchemaVersionId: 17, previewToken: 'fixture-preview', totalPriceUah: 1200 }; break;
      case 'POST /api/save': data = saved; break;
      case 'POST /api/admin/magento-integration/option-labels/inspect': data = { target: { label: 'Скриньки', englishLabel: 'Boxes' },
        attribute: schema.attributes[0], comparisonKind: 'effective', updateUnavailable: 'Безпечне оновлення недоступне без адаптера Magento.',
        comparison: [{ scope: 'all', before: 'Скриньки', after: 'Скриньки' }, { scope: 'en', before: 'Old English', after: 'Boxes' }] }; break;
      default: unexpected.push({ path: url.pathname, method: request.method }); response.statusCode = 404; data = { error: `Unexpected local fixture API: ${request.method} ${url.pathname}` };
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); return;
  }
  const asset = url.pathname.startsWith('/assets/');
  const filename = asset ? path.join(dist, 'assets', path.basename(url.pathname)) : path.join(dist, 'index.html');
  if (!existsSync(filename)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html');
  response.end(readFileSync(filename));
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
  const click = (text) => evaluate(`(() => { const target=[...document.querySelectorAll('button,a,summary')].find(element=>element.textContent.trim()===${JSON.stringify(text)}); if(!target) throw new Error('Missing action: '+${JSON.stringify(text)}+'; available: '+[...document.querySelectorAll('button,a,summary')].map(element=>element.textContent.trim()).join(' | ')); target.click(); })()`);
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
    await navigate('/admin/magento'); await wait("document.body.textContent.includes('Проблеми поточної доставки')");
    assert.equal(await evaluate("document.body.textContent.includes('Автоматичну синхронізацію увімкнено') && document.body.textContent.includes('Версія 3')"), true);
    assert.equal(await evaluate("document.querySelectorAll('.magento-category-card').length"), 2);
    assert.equal(await evaluate("document.body.textContent.includes('Готова категорія') || document.body.textContent.includes('Готове значення') || document.body.textContent.includes('value_id:')"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('a')].some(a=>a.textContent.trim()==='Контрольовані операції')"), false);
    await noOverflow(`Overview overflow at ${width}px`);
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Оновити стан').focus()");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("document.activeElement.matches('a,button,input,select,summary') && Number.parseFloat(getComputedStyle(document.activeElement).outlineWidth)>0"), true, 'Keyboard focus must be visible');
    await screenshot(`overview-${width}`);
    await click('Усі категорії'); await wait("document.body.textContent.includes('Готова категорія')");
    assert.equal(await evaluate("document.querySelectorAll('.magento-category-row').length"), 3);
    await noOverflow(`All categories overflow at ${width}px`);
    checks.push({ width, overview: 'attention-only', allCategories: true, keyboardFocus: true, noOverflow: true });
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate('/admin/magento/categories/SV'); await wait("document.body.textContent.includes('Вид: Потрібне значення')");
  assert.equal(await evaluate("document.body.textContent.includes('Готове значення')"), false);
  assert.equal(await evaluate("document.querySelectorAll('article').length"), 1);
  await click('Показати всі відповідності');
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Який камінь? · stone_processing → ') && b.textContent.includes('categories'))");
  assert.equal(await evaluate("document.querySelectorAll('article').length"), 0);
  await click('Вид · kind · 240');
  assert.equal(await evaluate("document.querySelectorAll('article').length"), 50);
  for (const term of ['kamin_obrobka', 'stone_processing', 'Не оброблений камінь']) {
    await setField('Пошук відповідностей', term);
    assert.equal(await evaluate("document.querySelectorAll('article').length"), 0);
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Який камінь? · stone_processing → ') && b.textContent.includes('kamin_obrobka')).click()");
    assert.equal(await evaluate("document.querySelectorAll('article').length"), 1);
    assert.equal(await evaluate("document.body.textContent.includes('Який камінь?: Не оброблений камінь') && !document.body.textContent.includes('value_id:')"), true);
  }
  await noOverflow('Category detail overflow at 390px'); await screenshot('category-390');
  await evaluate("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Правила передачі інших полів').click()");
  await wait("!!document.querySelector('.integration-rules table')");
  assert.equal(await evaluate("document.body.textContent.includes('Джерело в Amber') && document.body.textContent.includes('Поведінка в Magento')"), true);
  await navigate('/admin/magento/rules/template?version=template-version');
  await wait("document.body.textContent.includes('Використовується поточною інтеграцією Magento.')");
  assert.equal(await evaluate("!!document.querySelector('.integration-rules table') && !document.querySelector('.et-design-grid')"), true);
  assert.equal(requests.some((request) => request.path.endsWith('/activation')), false, 'Historical selection is not an integration dependency');
  await noOverflow('Integration rules overflow at 390px'); await screenshot('integration-rules-390');
  await navigate('/admin/magento/categories/SV?field=kamin_obrobka');
  await wait("document.body.textContent.includes('Зняти фільтр поля')");
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Який камінь? · stone_processing → ') && b.textContent.includes('categories'))");
  assert.equal(await evaluate("document.querySelectorAll('article').length"), 0);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Який камінь? · stone_processing → ') && b.textContent.includes('kamin_obrobka')).click()");
  assert.equal(await evaluate("document.querySelectorAll('article').length"), 1);
  assert.equal(requests.filter((request) => request.method !== 'GET').length, 0, 'Browsing cannot make decisions or writes');
  await navigate('/admin/magento/categories/SV?tab=placement');
  await wait("document.body.textContent.includes('Розділи магазину')");
  await noOverflow('Store placement overflow at 390px'); await screenshot('placement-390');
  await navigate('/admin/magento/categories/new?category=SV');
  await wait("!!document.querySelector('[aria-label=\"Налаштування нової категорії\"]')");
  await noOverflow('Category setup overflow at 390px'); await screenshot('category-setup-390');
  await navigate('/admin/magento/categories/new');
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Зберегти категорію')");
  await setField('Код','ZZ'); await setField('Назва','Новий тип для перевірки');
  assert.equal(requests.some((item)=>item.path==='/api/admin/category'),false);
  await click('Зберегти категорію');
  await wait("document.body.textContent.includes('Категорію створено') && document.body.textContent.includes('Характеристик ще немає')");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('category')"),'ZZ');
  const checkpointState="document.body.textContent.includes('Схему ще не опубліковано') && document.body.textContent.includes('Розрахунок ціни нового товару ще потрібно перевірити') && document.body.textContent.includes('Підключення ще потребує перевірки')";
  assert.equal(await evaluate(checkpointState),true,'Creating a category cannot imply schema, pricing or delivery readiness');
  assert.equal(await evaluate("[...document.querySelectorAll('.category-checkpoints li > span')].filter(s=>s.textContent.includes('Потрібен відповідний дозвіл')).every(s=>s.getBoundingClientRect().width>150 && s.getBoundingClientRect().height<120)"),true,'Permission-unavailable checkpoint text needs readable width and wrapping');
  await noOverflow('Created category checkpoints overflow at390px'); await screenshot('category-created-390');
  await navigate('/admin/magento/categories/new?category=ZZ');
  await wait("document.querySelector('[aria-label=\"Налаштування нової категорії\"]')?.children.length===5");
  assert.equal(await evaluate(checkpointState),true);
  assert.equal(await evaluate("document.body.textContent.includes('Категорію створено')"),false,'Reload resumes persisted checkpoints without replaying creation');
  assert.equal(requests.filter((item)=>item.path==='/api/admin/category').length,1);
  assert.equal(await evaluate("[...document.querySelectorAll('a')].find(a=>a.textContent==='Відкрити характеристики').href.includes('category=ZZ')"),true);
  checks.push({newCategory:'explicit catalog save, exact returned category',resume:'five persisted checkpoints, no invented schema/pricing/delivery readiness'});
  await navigate('/admin/magento/prepare?category=SV'); await wait("!![...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Версія для перегляду'))");
  await setField('Версія для перегляду', 'draft'); await wait("document.body.textContent.includes('Чернетка змін · ревізія 7')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Поточна інтеграція\"]').textContent.includes('Версія 3')"), true);
  await click('2. Дані Magento'); await click('Перевірити структуру');
  await wait("!!document.querySelector('[aria-label=\"Категорія Magento: root/fixture\"]')");
  assert.equal(await evaluate("[...document.querySelectorAll('h2,h3')].filter(h=>h.textContent==='Категорії Magento').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"Категорія Magento: root/fixture\"]').length"), 1);
  assert.equal(await evaluate("document.body.textContent.includes('Використань у відповідностях: 2')"), true);
  await click('Як зберігаються підготовлені зміни');
  assert.equal(await evaluate("document.body.textContent.includes('Непубліковані рішення попередньої чернетки автоматично не переносяться')"), true);
  await noOverflow('Resource workspace overflow at 390px'); await screenshot('resources-390');
  await navigate('/admin/magento/administrator'); await wait("document.body.textContent.includes('Ці дії доступні лише Адміністратору')");
  const inspectLabels = async () => {
    await wait("!![...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Значення Amber'))");
    await setField('Значення Amber', 'kind:8'); await setField('Атрибут Magento', 'fixture_choice');
    await click('Перевірити значення Magento'); await wait("document.body.textContent.includes('Безпечне оновлення недоступне без адаптера Magento')");
    assert.equal(await evaluate("document.body.textContent.includes('Old English') && document.body.textContent.includes('Boxes') && document.body.textContent.includes('успадкованою')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>/Підтвердити можливість|Підтвердити зміну назв/.test(b.textContent))"), false);
    await noOverflow('Read-only label comparison overflow at 390px');
  };
  await navigate('/admin/magento/categories/SV/labels'); await inspectLabels();
  await screenshot('delegated-label-comparison-390');
  administrator = true;
  await navigate('/admin/magento/administrator');
  await wait("[...document.querySelectorAll('a')].some(a=>a.textContent.trim()==='Контрольовані операції')");
  await wait("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Оновити підписи наявних значень')");
  for (const title of ['Оновити підписи наявних значень', 'Застосувати правила назв', 'Контрольована повторна синхронізація']) {
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()===${JSON.stringify(title)})`), true);
  }
  assert.equal(await evaluate("!![...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Дія')"), false);
  await noOverflow('Administrator workspace overflow at 390px'); await screenshot('administrator-390');
  await click('Оновити підписи наявних значень'); await inspectLabels();
  await click('До переліку дій Адміністратора'); await click('Застосувати правила назв');
  await wait("document.body.textContent.includes('Застосувати правило назв')");
  await click('Перевірити товари для контрольованої дії'); await wait("document.body.textContent.includes('AG-000022')");
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('AG-000022')).querySelector('input').disabled"), true);
  assert.equal(await evaluate("document.body.textContent.includes('Current name') && document.body.textContent.includes('New name')"), true);
  await noOverflow('Name rule workspace overflow at 390px');
  await click('До переліку дій Адміністратора'); await click('Контрольована повторна синхронізація');
  await wait("document.body.textContent.includes('Повторна синхронізація вибраних товарів')");
  await click('Перевірити товари для контрольованої дії'); await wait("document.body.textContent.includes('AG-000022')");
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('AG-000022')).querySelector('input').disabled"), true);
  assert.equal(await evaluate("!![...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Дія')"), false);
  await noOverflow('Controlled resync workspace overflow at 390px');

  // Author a conditional subcategory rule in the local draft. Discovery reads
  // the fixture tree; neither append nor local Apply sends a server write.
  await navigate('/admin/magento/rules/template?category=SV&field=categories');
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Прочитати розділи магазину')");
  await click('Прочитати розділи магазину');
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='root › fixture')");
  await setField('Розділ','new'); await click('root › fixture');
  await setField('Назва підкатегорії','Необроблений камінь');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Додати розміщення до правила').disabled"),true);
  await setField('Які товари тут розміщувати?','condition');
  await setField('Характеристика','SV.stone_processing');
  await wait("[...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Значення характеристики').querySelector('select option[value=\"0\"]')!==null");
  await setField('Значення характеристики','0');
  const writesBeforePlacement=requests.filter((item)=>item.method!=='GET').length;
  await click('Додати розміщення до правила');
  await wait("document.body.textContent.includes('Додано до заповнення: root › fixture › Необроблений камінь')");
  await noOverflow('Conditional subcategory authoring overflow at390px'); await screenshot('subcategory-conditional-390');
  await click('Застосувати до чернетки');
  await wait("document.body.textContent.includes('Незбережена чернетка') && !document.querySelector('[aria-label=\"Розміщення товарів у магазині\"]')");
  assert.equal(requests.filter((item)=>item.method!=='GET').length,writesBeforePlacement,'Local placement apply cannot create Magento categories or publish');
  checks.push({subcategory:'observed parent, explicit name and semantic condition',application:'local draft only; no write or publication'});

  // Real built UI, local fixture commands only: create -> exact membership ->
  // lost response -> reload -> GET-only recovery -> contextual rules handoff.
  const attributeRoute = '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1';
  await navigate(attributeRoute);
  await wait("!![...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Назва англійською')");
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Обов’язкове заповнення').querySelector('select').value"),'');
  for (const [label,value] of [['Назва українською','Фактура поверхні'],['Назва англійською','Surface texture'],['Код атрибута','amber_fixture_texture'],
    ['Тип значення','select'],['Значення для магазинів','global'],['Обов’язкове заповнення','false'],['Показувати на сторінці товару','true'],
    ['Використовувати в пошуку','true'],['Фільтр у каталозі','true'],['Фільтр у результатах пошуку','false']]) await setField(label,value);
  await noOverflow('New attribute explicit profile overflow at390px'); await screenshot('attribute-profile-390');
  await command('Emulation.setDeviceMetricsOverride', { width:360,height:1000,deviceScaleFactor:1,mobile:false });
  await noOverflow('New attribute profile overflow at360px');
  await command('Emulation.setDeviceMetricsOverride', { width:390,height:1000,deviceScaleFactor:1,mobile:false });
  assert.equal(requests.some((item)=>item.path.endsWith('/attributes/apply')),false);
  await click('Перевірити атрибут'); await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Створити атрибут у Magento')");
  assert.equal(requests.some((item)=>item.path.endsWith('/attributes/apply')),false,'Preview must not create an attribute');
  await click('Створити атрибут у Magento'); await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Підключити до набору')");
  assert.equal(requests.filter((item)=>item.path.endsWith('/attributes/apply')).length,1);
  await click('Підключити до набору');
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Атрибут').querySelector('select').value"),'amber_fixture_texture');
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()==='Набір атрибутів').querySelector('select').value"),'151');
  await setField('Розділ у Magento','81'); await setField('Порядок у розділі','9');
  await click('Перевірити підключення'); await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Підключити атрибут до набору')");
  assert.equal(await evaluate("document.body.textContent.includes('Підключення встановлює вибраний розділ і порядок')"),true);
  assert.equal(requests.some((item)=>item.path.endsWith('/attributes/assignment-apply')),false);
  await click('Підключити атрибут до набору'); await wait("document.body.textContent.includes('Підключення надіслано. Результат ще не підтверджено.')");
  await navigate(`${attributeRoute}&refresh=draft`);
  await wait("[...document.querySelectorAll('summary')].some(s=>s.textContent==='Збережені дії з атрибутами')");
  await evaluate("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Збережені дії з атрибутами').click()");
  await click('Перевірити результат');
  await wait("document.body.textContent.includes('Атрибут доступний у вибраному наборі.')");
  assert.equal(requests.filter((item)=>item.path.endsWith('/attributes/apply')).length,1);
  assert.equal(requests.filter((item)=>item.path.endsWith('/attributes/assignment-apply')).length,1,'Uncertain assignment must not POST twice');
  assert.equal(requests.filter((item)=>item.path.endsWith('/attributes/reconcile')).length,1);
  await noOverflow('Recovered attribute membership receipt overflow at390px'); await screenshot('attribute-recovered-390');
  await click('Налаштувати передачу характеристики');
  await wait("location.pathname.includes('/admin/magento/rules/template') && new URLSearchParams(location.search).get('field')==='amber_fixture_texture'");
  checks.push({attributeCreation:'explicit reviewed profile',membership:'separate reviewed placement',recovery:'reload exact original action, no duplicate POST',rulesHandoff:'exact attribute context'});

  await navigate('/'); await wait("!![...document.querySelectorAll('.home-category-option')].find(b=>b.textContent.includes('Сувеніри'))");
  await evaluate("[...document.querySelectorAll('.home-category-option')].find(b=>b.textContent.includes('Сувеніри')).click()");
  await click('Перевірити дані'); await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Зберегти товар')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>/Копіювати SKU|Копіювати артикул/.test(b.textContent))"), false);
  await click('Зберегти товар'); await wait("document.body.textContent.includes('AG-000021')");
  await click('Копіювати артикул'); assert.deepEqual(await evaluate('window.fixtureCopies'), ['AG-000021']);
  await noOverflow('Saved article receipt overflow at 390px'); await screenshot('saved-article-390');
  await evaluate("[...document.querySelectorAll('.home-category-option')].find(b=>b.textContent.includes('Сувеніри')).click()");
  assert.equal(await evaluate("document.body.textContent.includes('AG-000021')"), false);
  assert.deepEqual(unexpected, [], 'All API requests must have explicit local fixtures');
  assert.deepEqual(blockedExternal, [], 'Application attempted external network access');
  assert.deepEqual(browserErrors, [], 'Browser runtime errors');
  const allowedPosts = ['/api/admin/category', '/api/admin/magento-integration/discovery', '/api/admin/magento-integration/structure-check', '/api/admin/magento-integration/option-labels/inspect', '/api/preview', '/api/price-preview', '/api/save',
    ...['preview','apply','assignment-preview','assignment-apply','reconcile'].map((action)=>`/api/admin/magento-integration/attributes/${action}`)];
  const unexpectedWrites = requests.filter((request) => request.method !== 'GET'
    && !(request.method === 'POST' && allowedPosts.includes(request.path)));
  assert.deepEqual(unexpectedWrites, []);
  console.log(JSON.stringify({ result: 'passed', authentication: 'local fixture session only; no real login or human acceptance', checks,
    categoryGrouping: 'one visual path, two distinct underlying uses', receipt: 'exact authoritative article copied and reset at next creation',
    administrator: 'separate workflows, exact role gate, delegated label comparison, unavailable adapter has no attest/apply, uncertain product cannot be selected',
    requestCount: requests.length, runtimeErrors: browserErrors.length, externalRequests: blockedExternal.length,
    unexpectedFixtureRequests: unexpected.length, unexpectedWrites: unexpectedWrites.length, artifacts: directory }));
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
