// Full built-client acceptance against local HTTP fixtures only.
// No real authentication, database, Magento endpoint, or production service is used.
// node scripts/test-client-browser.mjs <installed-Chromium-or-Edge-executable>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { polishConfig, polishDecoded, polishPreview } from '../client/test/fixtures/characteristic-polish.js';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const WebSocket = require('ws');
const { materializeMagentoV1 } = require(fileURLToPath(new URL('../server/src/services/export-templates/magento-v1-definition.js', import.meta.url)));
const { hashJsonData } = require(fileURLToPath(new URL('../server/src/services/export-templates/definition.js', import.meta.url)));
const { catalog: exportTemplateCatalog } = require(fileURLToPath(new URL('../server/test/fixtures/magento-v1/contract.js', import.meta.url)));
const executable = process.argv[2];
assert.ok(executable && existsSync(executable), 'Provide an installed Chromium/Edge executable');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
assert.ok(existsSync(path.join(dist, 'index.html')), 'Build client/dist before browser acceptance');

const artifacts = mkdtempSync(path.join(tmpdir(), 'amber-application-browser-'));
const requests = [];
const unexpected = [];
let currentPersona = 'storekeeper';
let characteristicPolishFixture = false;
let characteristicPolishApplied = false;
let magentoReadinessFixture = false;
let readinessNamesApplied = false;
let readinessSizeApplied = false;
// Keep the browser recount target valid; historical invalid evidence is covered
// by rendered regressions without pretending it passes server validation.
const browserPolishQuestions = polishConfig.questions.SV.filter((question) => !question.id.startsWith('historic_'));
const browserPolishConfig = { ...polishConfig, questions: { SV: browserPolishQuestions } };
const browserPolishAnswers = (answers) => Object.fromEntries(browserPolishQuestions
  .filter((question) => Object.hasOwn(answers, question.id)).map((question) => [question.id, answers[question.id]]));

const personas = {
  storekeeper: {
    name: 'Олена Комірниця',
    roles: [{ id: 2, key: 'storekeeper', displayName: 'Комірник' }],
    permissions: ['products.view', 'products.decode', 'products.create', 'products.recount', 'products.price_change',
      'products.archive', 'history.view', 'corrections.create'],
  },
  manager: {
    name: 'Марія Керівниця',
    roles: [{ id: 3, key: 'manager', displayName: 'Керівник' }],
    permissions: ['products.view', 'products.decode', 'history.view', 'corrections.view', 'corrections.create',
      'repricing.view', 'repricing.prepare', 'repricing.apply', 'exports.view', 'exports.create', 'pricing.view'],
  },
  exportCreator: {
    name: 'Марія Керівниця',
    roles: [{ id: 3, key: 'manager', displayName: 'Керівник' }],
    permissions: ['exports.view', 'exports.create'],
  },
  exportViewer: {
    name: 'Ірина Операторка',
    roles: [{ id: 4, key: 'delegated_export_viewer', displayName: 'Оператор експорту' }],
    permissions: ['exports.view'],
  },
  correctionOperator: {
    name: 'Олена Комірниця',
    roles: [{ id: 2, key: 'storekeeper', displayName: 'Комірник' }],
    permissions: ['products.view', 'corrections.view', 'corrections.claim', 'corrections.complete'],
  },
  administrator: {
    name: 'Андрій Адміністратор',
    roles: [{ id: 1, key: 'administrator', displayName: 'Адміністратор' }],
    permissions: ['products.view', 'products.decode', 'products.create', 'products.recount', 'history.view',
      'corrections.view', 'corrections.create', 'repricing.view', 'exports.view', 'exports.create',
      'catalog.view', 'catalog.manage', 'sku_schemas.publish', 'pricing.view', 'pricing.manage',
      'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'products.delete_test',
      'users.manage', 'roles.manage', 'audit.view'],
  },
};

const product = {
  id: 7,
  publicSku: 'AG-000002',
  internalSku: 'SV227002',
  categoryCode: 'SV',
  categoryName: 'Сувеніри',
  status: 'active',
  weight: 10,
  priceUah: '1200.00',
};
const storedProduct = {
  id: product.id,
  public_sku: product.publicSku,
  full_sku: product.internalSku,
  status: 'active',
  category: 'SV',
  magento_name_review_required: false,
  weight: 10,
  total_price_uah: '1200.00',
  details: { answers: {} },
};
const category = { code: 'SV', name: 'Сувеніри', requires_weight: 1, sku_schema_version_id: 17 };
const config = { categories: { SV: category, BR: { code: 'BR', name: 'Браслети', requires_weight: 0 } },
  questions: { SV: [], BR: [] }, extraConfig: {} };
let fixtureWeight = 10;
let fixturePriceUah = 1200;
let fixtureProductStatus = 'active';
let correctionRequestSequence = 40;
const exportTemplateDefinition = materializeMagentoV1(exportTemplateCatalog());
let exportTemplateFamily = null;
const exportSessionSettings = { requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } };
const savedExportSession = { id: 'saved-a', title: 'Збережений каталог', settings: exportSessionSettings,
  configurationRevision: '7', accessEpoch: 'shared-1', isOwner: false, ownerName: 'Олена', participants: [],
  snapshotId: 'stored-a', currentAttemptId: null };
let createdExportSession = null;
const savedExportSnapshot = { id: 'stored-a', sessionId: 'saved-a', accessEpoch: 'shared-1', status: 'generated',
  generatedAt: '2026-10-02T09:00:00Z', productCount: 1, csvRowCount: 1,
  capturedRange: { fromSku: product.internalSku, toSku: product.internalSku },
  artifacts: [{ groupCode: 'SV', fileName: 'souvenirs.csv', rowCount: 1, productCount: 1,
    csvContent: `sku,store_view_code,name\r\n${product.internalSku},,Тестовий сувенір\r\n` }] };
let managedUsers = [{ id: 101, status: 'pending', displayName: 'Pending User', preferredUsername: 'pending.user',
  lastAuthenticatedAt: null, currentAssignmentId: null, role: null },
{ id: 102, status: 'active', displayName: 'Active User', preferredUsername: 'active.user',
  lastAuthenticatedAt: '2026-09-09T10:00:00.000Z', currentAssignmentId: 202,
  role: { id: 3, key: 'storekeeper', displayName: 'Комірниця', isSystem: true, status: 'active' } }];
const accessRoles = [
  { id: 1, key: 'administrator', displayName: 'Адміністратор', isSystem: true, status: 'active' },
  { id: 2, key: 'manager', displayName: 'Керівник', isSystem: true, status: 'active' },
  { id: 3, key: 'storekeeper', displayName: 'Комірниця', isSystem: true, status: 'active' },
];
const permissionCatalog = [
  { key: 'products.view', description: 'View products', reserved: false },
  { key: 'corrections.view', description: 'View corrections', reserved: false },
  { key: 'users.manage', description: 'Manage users', reserved: true },
  { key: 'roles.manage', description: 'Manage roles', reserved: true },
  { key: 'audit.view', description: 'View audit', reserved: true },
];
const administratorRole = { id: 1, key: 'administrator', displayName: 'Administrator', description: 'Protected',
  isSystem: true, isProtected: true, status: 'active', version: 1, permissionKeys: permissionCatalog.map(({ key }) => key),
  permissionCount: permissionCatalog.length, assignedUserCount: 1, activeAssignedUserCount: 1, disabledAssignedUserCount: 0 };
const managerRole = { id: 2, key: 'manager', displayName: 'Manager', description: 'Editable system role',
  isSystem: true, isProtected: false, status: 'active', version: 4, permissionKeys: ['products.view'],
  permissionCount: 1, assignedUserCount: 1, activeAssignedUserCount: 1, disabledAssignedUserCount: 0 };
let roleConflictTriggered = false;
const repricingScenario = { id: 21, category_code: 'BR', name: 'Базова матриця', priority: 1, price_mode: 'fixed_uah' };
const repricingItems = Array.from({ length: 1000 }, (_, index) => ({
  productId: 1001 + index, publicSku: `AG-${String(1001 + index).padStart(6, '0')}`, sku: `BR${1001 + index}`,
  categoryCode: 'BR', scenarioId: 21, scenarioName: repricingScenario.name, weight: 0,
  oldPriceUah: 1000 + index, newPriceUah: 1200 + index, calculatedPriceUah: 1200 + index,
  automaticPriceUah: 1200 + index, priceDeltaUah: 200, priceMode: 'fixed_uah', pricingState: 'automatic',
  status: 'changed', pricingChange: { reasonCodes: [], reasonLabels: [] },
}));
const repricingPreview = { scope: 'scenario', scenario: { id: 21, categoryCode: 'BR', name: repricingScenario.name },
  previewToken: 'fixture-repricing-preview', blockingCorrectionRequests: [],
  summary: { candidateCount: 1000, changedCount: 1000, unchangedCount: 0, skippedCount: 0, errorCount: 0 },
  items: repricingItems };
let repricingDraft = null;
let repricingApplied = false;
let correctionRequest = { id: 71, requestType: 'recount', status: 'pending', sourceProductId: 20,
  sourceSku: 'BR1001', proposedSku: 'BR1002', sourceArticle: 'AG-000020', proposedArticle: 'AG-000020',
  sourceInternalSku: 'BR1001', proposedInternalSku: 'BR1002', categoryCode: 'BR', comment: 'Перевірити розмір',
  oldPayload: { totalPriceUah: 1000, answers: {} }, proposedPayload: { totalPriceUah: 1200, answers: {} },
  pricingDecision: { mode: 'automatic' }, changes: [], claimVersion: 1,
  createdByUser: { id: 5, displayName: 'Марія Керівниця' }, createdAt: '2026-10-02T08:00:00Z', updatedAt: '2026-10-02T08:00:00Z' };
const secondCorrectionRequest = { ...correctionRequest, id: 72, requestType: 'price_change', sourceProductId: 21,
  sourceSku: 'BR1003', proposedSku: 'BR1003', sourceArticle: 'AG-000021', proposedArticle: 'AG-000021',
  sourceInternalSku: 'BR1003', proposedInternalSku: 'BR1003', comment: 'Уточнити погоджену ціну',
  oldPayload: { totalPriceUah: 1500, answers: {} }, proposedPayload: { totalPriceUah: 1650, answers: {} },
  pricingDecision: { mode: 'manual_uah', manualPriceUah: 1650 }, createdAt: '2026-10-02T08:01:00Z', updatedAt: '2026-10-02T08:01:00Z' };
const auditEvent = { eventKey: 'application_user.role_changed', domain: 'application_user',
  occurredAt: '2026-09-10T12:00:00.000Z', actor: { status: 'recorded', id: 7, displayName: 'Історичне ім’я', preferredUsername: 'old.name' },
  subject: { type: 'application_user', id: '19' },
  details: { previousRole: { displayName: 'Manager' }, newRole: { displayName: 'Storekeeper' } } };
const magentoOverview = {
  integration: {
    configured: true,
    activePublication: { id: 'published-fixture', revision: '4', versionNumber: 3,
      templateVersionNumber: 3, publishedAt: '2026-10-01T12:00:00Z' },
    delivery: { state: 'enabled' },
    operational: { state: 'known', count: 1 },
    structureObservation: { observedAt: '2026-10-02T12:00:00Z', bindingId: 'published-fixture', state: 'published' },
    draftCount: 1,
    asOf: '2026-10-02T12:00:00Z',
  },
  categories: [{ code: 'SV', name: 'Сувеніри',
    operational: { state: 'known', count: 1, reasons: [{ code: 'MAPPING', count: 1, message: 'Потрібна перевірка відповідностей.' }] },
    preparation: { needed: false, count: 0, reasons: [] }, impact: 'unexamined' }],
};
const productTimeline = {
  querySku: product.publicSku,
  lineage: {
    integrity: 'complete', currentSku: product.internalSku, currentPublicSku: product.publicSku, warnings: [],
    products: [{ sku: product.internalSku, publicSku: product.publicSku, status: 'active',
      magentoSync: { state: 'needs_attention', reason: 'Потрібна перевірка доставки.' } }],
  },
  events: [{
    id: 'fixture-created', type: 'product.created', occurredAt: '2026-10-01T08:00:00Z',
    timestampStatus: 'recorded', actor: { status: 'recorded', displayName: personas.storekeeper.name },
    sku: product.internalSku, publicSku: product.publicSku, details: {}, changes: [], groupKey: null,
  }, {
    id: 'fixture-price-change', type: 'product.price_changed', occurredAt: '2026-10-02T08:30:00Z',
    timestampStatus: 'recorded', actor: { status: 'recorded', displayName: personas.storekeeper.name },
    sku: product.internalSku, publicSku: product.publicSku, changes: [], groupKey: null,
    details: { price: { beforeUah: 1200, afterUah: 1450 },
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 1450, marketingRoundingEnabled: false } },
  }],
  configurationEvolution: { status: 'complete', warnings: [], snapshots: [{
    id: 'fixture-configuration', ordinal: 1, isInitial: true, isCurrent: true, productStatus: 'active',
    establishingSku: product.internalSku, establishingSchemaVersion: { id: 17, version: 1, marker: '' },
    currentSku: product.internalSku, currentSchemaVersion: { id: 17, version: 1, marker: '' },
    occurredAt: '2026-10-01T08:00:00Z', timestampStatus: 'recorded', source: 'product_created',
    completeness: 'complete', fields: [{ key: 'weight', fieldLabel: 'Вага',
      value: { value: 10, label: '10 г' }, labelStatus: 'stable_domain', evidence: 'product_details', changed: false }],
    changes: [],
  }] },
};

function json(response, data, status = 200) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ persona: currentPersona, method: request.method, path: url.pathname, search: url.search, body });
    const persona = personas[currentPersona];
    let data;
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/auth/me':
        data = { identity: { issuer: 'https://fixture.example.invalid', sub: `fixture-${currentPersona}`, name: persona.name },
          applicationUser: { id: currentPersona === 'administrator' ? 1 : currentPersona === 'manager' ? 3 : 2,
            status: 'active', displayName: persona.name },
          csrfToken: 'fixture-only', permissions: persona.permissions, roles: persona.roles };
        break;
      case 'GET /api/config': data = characteristicPolishFixture ? browserPolishConfig : config; break;
      case 'GET /api/product-timeline': data = productTimeline; break;
      case 'GET /api/products': data = [storedProduct]; break;
      case 'GET /api/products/register':
        data = { items: [product], pageInfo: { hasMore: false, nextCursor: null },
          filterOptions: { categories: [{ code: 'SV', name: 'Сувеніри' }] } };
        break;
      case 'POST /api/decode':
        if (characteristicPolishFixture) {
          const answers = browserPolishAnswers(characteristicPolishApplied
            ? polishPreview.corrected.answers : polishDecoded.product.details.answers);
          data = { ...polishDecoded,
            sku: characteristicPolishApplied ? polishPreview.corrected.fullSku : polishDecoded.sku,
            product: { ...polishDecoded.product, details: { answers, isCalibrated: 0 } },
            decodedAnswers: polishDecoded.decodedAnswers.filter((answer) => !answer.key.startsWith('historic_'))
              .map((answer) => answer.key === 'souvenir' && characteristicPolishApplied
                ? { ...answer, value_id: 2, value_label: 'Годинник' }
                : answer.key === 'kit_part' && characteristicPolishApplied
                  ? { ...answer, value_id: null, is_placeholder: true, value_label: 'Не обрано' } : answer) };
          break;
        }
        data = { sku: product.internalSku, publicSku: magentoReadinessFixture ? 'SV5111010' : product.publicSku, internalSku: product.internalSku,
          category, product: { ...storedProduct, public_sku: magentoReadinessFixture ? 'SV5111010' : product.publicSku,
            status: fixtureProductStatus, weight: fixtureWeight,
            total_price_uah: fixturePriceUah.toFixed(2) }, existsInDb: true, decodedAnswers: [], skuSchema: { version: 1 },
          suffix: { type: 'sequence', value: 2 }, calibration: { status: 'known' }, pricing: {
            totalPriceUah: fixturePriceUah, totalPrice: fixturePriceUah / 40,
            calculatedPriceUah: fixturePriceUah, pricePerGramUah: fixturePriceUah / fixtureWeight,
            pricePerGram: fixturePriceUah / fixtureWeight / 40, matrixName: 'Базова матриця',
            weight: fixtureWeight, source: 'stored', dependentKeys: ['weight'], usesWeight: true,
          } };
        break;
      case 'POST /api/recount/preview':
        if (characteristicPolishFixture) {
          data = { ...polishPreview,
            source: { ...polishPreview.source, answers: browserPolishAnswers(polishPreview.source.answers),
              decodedAnswers: polishPreview.source.decodedAnswers.filter((answer) => !answer.key.startsWith('historic_')) },
            corrected: { ...polishPreview.corrected, answers: browserPolishAnswers(polishPreview.corrected.answers) } };
          break;
        }
        data = {
        source: { sku: product.internalSku, publicSku: product.publicSku, totalPriceUah: fixturePriceUah, stateSignature: 'source-state' },
        corrected: { categoryCode: 'SV', publicSku: product.publicSku, totalPriceUah: 1300, totalPrice: 32.5,
          pricePerGramUah: 118.18, pricePerGram: 2.9545, pricingDetails: { scenario: { name: 'Базова матриця' } } },
        changes: [{ key: 'weight', from: fixtureWeight, to: Number(body?.weight || 11) }],
        previewToken: 'fixture-recount-preview', priceDeltaUah: 1300 - fixturePriceUah,
        priceDeltaUsd: 32.5 - (fixturePriceUah / 40),
      }; break;
      case 'POST /api/recount/apply':
        if (characteristicPolishFixture) {
          assert.equal(body.sourceStateSignature, polishPreview.source.stateSignature);
          assert.equal(body.answers.souvenir, 2);
          assert.equal(body.answers.is_calibrated, 0);
          characteristicPolishApplied = true;
          data = { corrected: { publicSku: polishDecoded.publicSku, sku: polishPreview.corrected.fullSku } };
          break;
        }
        fixtureWeight = Number(body?.weight || 11); fixturePriceUah = 1300;
        data = { corrected: { publicSku: product.publicSku, sku: product.internalSku } }; break;
      case 'POST /api/product-price-change/preview':
      case 'POST /api/admin/correction-requests/preview': {
        const manualPrice = Number(body?.pricingDecision?.manualPriceUah);
        const resultingPriceUah = Number.isFinite(manualPrice) && manualPrice > 0 ? manualPrice : fixturePriceUah + 100;
        data = { currentPriceUah: fixturePriceUah, resultingPriceUah,
          priceDifferenceUah: resultingPriceUah - fixturePriceUah, previewToken: 'fixture-price-preview', unchanged: false };
        break;
      }
      case 'POST /api/product-price-change/apply': fixturePriceUah = Number(body?.pricingDecision?.manualPriceUah) || fixturePriceUah + 100;
        data = { productId: product.id, sku: product.internalSku, resultingPriceUah: fixturePriceUah }; break;
      case 'POST /api/admin/correction-requests': correctionRequestSequence += 1;
        data = { request: { id: correctionRequestSequence, requestType: body?.requestType || 'recount' } }; break;
      case 'POST /api/delete': fixtureProductStatus = 'archived';
        data = { message: `Товар ${product.publicSku} перенесено в архів.` }; break;
      case 'POST /api/products/test-delete/preview': data = { state: 'preview', previewHash: 'fixture-delete-preview',
        publicSku: product.publicSku, productId: product.id }; break;
      case 'GET /api/magento/product-status/7': data = magentoReadinessFixture ? { state: 'needs_attention', nameConflict: false,
        problems: [{ code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Товар не готовий до синхронізації. Потрібно доповнити або виправити дані товару.',
          issueFields: [...(!readinessNamesApplied ? ['name'] : []), ...(!readinessSizeApplied ? ['rozmir_suveniriv'] : []), 'kamin_obrobka'] }] }
        : { state: 'pending', nameConflict: false }; break;
      case 'GET /api/magento/product-status/20': data = { state: 'not_queued', nameConflict: false }; break;
      case 'GET /api/product-names/20': data = { names: { all: 'Синтетичний сувенір', en: 'Synthetic souvenir' }, nameConflict: false }; break;
      case 'GET /api/product-names/7': data = { names: { all: 'Тестовий сувенір', en: 'Test souvenir' }, nameConflict: false }; break;
      case 'GET /api/magento/summary': data = { enabled: true, problemCount: 2 }; break;
      case 'GET /api/magento/problems/page': data = {
        items: [{ productId: product.id, article: magentoReadinessFixture ? 'SV5111010' : product.publicSku, category: product.categoryCode,
          nameConflict: false, problems: magentoReadinessFixture ? [
            { code: 'NAME_READ_UNAVAILABLE', message: 'Назви товару в Amber потрібно заповнити або виправити.', resolution: 'product' },
            { code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Товар не готовий до синхронізації. Потрібно доповнити або виправити дані товару.',
              resolution: 'product', issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'] },
          ] : [{ code: 'UNCERTAIN_WRITE',
            message: 'Amber надіслав зміну, але кінцевий стан не підтверджено.',
            resolution: 'administrator', target: 'product' }] }],
        pageInfo: { limit: 20, offset: 0, total: 1, hasPrevious: false, hasNext: false },
      }; break;
      case 'POST /api/product-magento-name/preview':
        data = body?.subjectUa ? { productId: product.id, publicSku: 'SV5111010', subjectUa: body.subjectUa,
          subjectEn: body.subjectEn, previewToken: 'fixture-name-preview', nameUa: `${body.subjectUa} з бурштину. Арт: SV5111010`,
          nameEn: `Amber ${body.subjectEn}. Art: SV5111010` }
          : { productId: product.id, publicSku: 'SV5111010', subjectUa: null, subjectEn: null, canConfirmUnchanged: false }; break;
      case 'POST /api/product-magento-name/apply': readinessNamesApplied = true; data = { productId: product.id }; break;
      case 'POST /api/product-information/preview': data = { productId: product.id, publicSku: 'SV5111010', previewToken: 'fixture-size-preview',
        changes: [{ key: 'size', before: null, after: body?.answersPatch?.size }] }; break;
      case 'POST /api/product-information/apply': readinessSizeApplied = true; data = { productId: product.id }; break;
      case 'GET /api/admin/magento-integration/overview': data = magentoOverview; break;
      case 'GET /api/admin/correction-requests': data = { requests: [], summary: { active: 3 } }; break;
      case 'GET /api/admin/correction-requests/page':
        if (currentPersona === 'correctionOperator') {
          const items = correctionRequest.status === 'completed'
            ? [secondCorrectionRequest]
            : [correctionRequest, secondCorrectionRequest];
          data = { items, pageInfo: { limit: 30, offset: 0, total: items.length, hasPrevious: false, hasNext: false },
            summary: { active: items.length, pending: (correctionRequest.status === 'pending' ? 1 : 0) + 1,
              inProgress: correctionRequest.status === 'in_progress' ? 1 : 0 } };
        } else data = { items: [], pageInfo: { hasMore: false }, summary: { active: 3 } };
        break;
      case 'POST /api/admin/correction-requests/71/claim':
        correctionRequest = { ...correctionRequest, status: 'in_progress', claimVersion: 2,
          claimedByUser: { id: 2, displayName: personas.correctionOperator.name }, updatedAt: '2026-10-02T08:05:00Z' };
        data = { request: correctionRequest };
        break;
      case 'POST /api/admin/correction-requests/71/complete':
        correctionRequest = { ...correctionRequest, status: 'completed', claimVersion: 3, updatedAt: '2026-10-02T08:10:00Z' };
        data = { request: correctionRequest, draftSyncFailures: [] };
        break;
      case 'GET /api/admin/config': case 'GET /api/admin/pricing/config': data = config; break;
      case 'GET /api/admin/sku-schema/SV': data = { active: { version: 1 }, draftChanged: true, nextVersion: 2 }; break;
      case 'POST /api/admin/sku-schema/SV/publish': data = { version: 2 }; break;
      case 'GET /api/admin/prices/SV': data = { category: 'SV', scenarios: [{
        id: 12, category_code: 'SV', name: 'Базова ціна', group_name: '', match_json: {}, axis_x_key: 'weight',
        axis_y_key: null, priority: 0, status: 'active', price_mode: 'fixed_uah', apply_modifiers: true,
        matrix: [{ x_val: 0, y_val: 0, price: '120.00' }], weight_bands: [],
      }], modifiers: [] }; break;
      case 'POST /api/admin/price-cell': data = { success: true }; break;
      case 'GET /api/admin/users': data = { users: managedUsers }; break;
      case 'GET /api/admin/users/roles': data = { roles: accessRoles }; break;
      case 'PUT /api/admin/users/102/role':
        managedUsers = managedUsers.map((user) => user.id === 102 ? { ...user, currentAssignmentId: 303, role: accessRoles.find((role) => role.id === body.roleId) } : user);
        data = {};
        break;
      case 'GET /api/admin/roles': data = { roles: [administratorRole, roleConflictTriggered
        ? { ...managerRole, displayName: 'Manager server', version: 5 }
        : managerRole] }; break;
      case 'GET /api/admin/roles/permissions': data = { permissions: permissionCatalog }; break;
      case 'PUT /api/admin/roles/2/permissions':
        roleConflictTriggered = true;
        return json(response, { code: 'ROLE_VERSION_CONFLICT', error: 'Role changed on server' }, 409);
      case 'GET /api/admin/audit-events': data = { items: [auditEvent], page: { limit: 50, hasMore: false, nextCursor: null }, filters: {} }; break;
      case 'GET /api/admin/repricing/scenarios': data = [repricingScenario]; break;
      case 'GET /api/admin/repricing/drafts': data = repricingDraft ? [repricingDraft] : []; break;
      case 'GET /api/admin/repricing/batches/page': data = { items: repricingApplied ? [{ id: 92,
        applied_at: '2026-10-02T10:00:00Z', category_code: 'BR', scenario_name: repricingScenario.name,
        status: 'completed', changed_count: 1000, can_rollback: true }] : [],
        pageInfo: { limit: 20, offset: 0, total: repricingApplied ? 1 : 0, hasPrevious: false, hasNext: false } }; break;
      case 'POST /api/admin/repricing/preview': data = repricingPreview; break;
      case 'POST /api/admin/repricing/drafts':
        repricingDraft = { id: 77, scope: body.scope, scenarioId: body.scenarioId, updatedAt: '2026-10-02T09:00:00Z',
          manualOverrides: body.manualOverrides, automaticProductIds: body.automaticProductIds,
          reviewedProductIds: body.reviewedProductIds, uiState: body.uiState };
        data = { draft: repricingDraft };
        break;
      case 'PUT /api/admin/repricing/drafts/77':
        repricingDraft = { ...repricingDraft, ...body, updatedAt: '2026-10-02T09:05:00Z' };
        data = { draft: repricingDraft };
        break;
      case 'POST /api/admin/repricing/apply':
        repricingApplied = true;
        repricingDraft = null;
        data = { batch: { id: 92, changedCount: 1000, changed_count: 1000 } };
        break;
      case 'GET /api/admin/repricing/batches/92/sync-status': data = {
        status: 'completed', total: 1000, synced: 0, pending: 990, needsAttention: 10, notTracked: 0,
      }; break;
      case 'GET /api/admin/export-templates': data = { templates: exportTemplateFamily ? [exportTemplateFamily] : [] }; break;
      case 'GET /api/admin/export-templates/sources': data = {
        productFields: ['public_sku', 'full_sku', 'weight', 'total_price_uah'], references: { questions: [], schemas: [] },
      }; break;
      case 'GET /api/admin/export-templates/activation': data = { generation: '1', implementation: 'legacy' }; break;
      case 'GET /api/admin/export-templates/candidate': data = {
        definition: exportTemplateDefinition, diagnostics: [], candidateOnly: true,
      }; break;
      case 'POST /api/admin/export-templates':
        exportTemplateFamily = { id: 'fixture-template', template_key: body.key, display_name: body.displayName,
          draft: { revision: '1', definitionHash: hashJsonData(body.definition), definition: body.definition }, versions: [] };
        data = exportTemplateFamily;
        break;
      case 'GET /api/admin/export-templates/fixture-template': data = exportTemplateFamily; break;
      case 'GET /api/export/status':
        data = { delivery: { legacyProductCsvEnabled: currentPersona === 'exportCreator', automaticSyncEnabled: true }, countSinceLastExport: 4 };
        break;
      case 'GET /api/export/template-options': data = { versions: [], activeVersionId: null }; break;
      case 'POST /api/export/sessions':
        createdExportSession = { id: 'created-session', title: body.title, settings: body.settings,
          configurationRevision: '1', accessEpoch: 'owner-1', isOwner: true, ownerName: persona.name,
          participants: [], snapshotId: null, currentAttemptId: null };
        data = createdExportSession;
        break;
      case 'GET /api/export/sessions/created-session': data = createdExportSession; break;
      case 'GET /api/export/sessions/saved-a': data = savedExportSession; break;
      case 'GET /api/export/snapshots/stored-a': data = savedExportSnapshot; break;
      case 'GET /api/price-export/status': data = { pendingCount: 5, excludedPendingCount: 0 }; break;
      default:
        unexpected.push({ method: request.method, path: url.pathname, search: url.search });
        return json(response, { error: `Unexpected local fixture API: ${request.method} ${url.pathname}` }, 404);
    }
    return json(response, data);
  }
  const filename = url.pathname.startsWith('/assets/')
    ? path.join(dist, 'assets', path.basename(url.pathname))
    : path.join(dist, 'index.html');
  if (!existsSync(filename)) { response.writeHead(404); response.end(); return; }
  const type = filename.endsWith('.js') ? 'text/javascript'
    : filename.endsWith('.css') ? 'text/css'
      : filename.endsWith('.png') ? 'image/png' : 'text/html';
  response.setHeader('Content-Type', type);
  response.end(readFileSync(filename));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchBrowser({ actualZoom = false } = {}) {
  const profile = path.join(artifacts, actualZoom ? 'profile-zoom-200' : 'profile-standard');
  if (actualZoom) {
    mkdirSync(path.join(profile, 'Default'), { recursive: true });
    writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } },
    }));
  }
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-features=Translate', '--window-size=1440,1000',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !existsSync(portFile) && attempt < 120; attempt += 1) await pause(100);
  assert.ok(existsSync(portFile), 'Headless browser did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const blockedExternal = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', (message) => {
    const data = JSON.parse(String(message));
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails);
    if (data.method === 'Fetch.requestPaused') {
      const requestedUrl = data.params.request.url;
      if (requestedUrl.startsWith(`${origin}/`) || /^(data|blob):/.test(requestedUrl)) {
        void command('Fetch.continueRequest', { requestId: data.params.requestId });
      } else {
        blockedExternal.push(requestedUrl);
        void command('Fetch.failRequest', { requestId: data.params.requestId, errorReason: 'BlockedByClient' });
      }
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result);
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Performance.enable');
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fixtureCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.fixtureCopies.push(String(text)); }
    } });
  ` });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw new Error(`Browser condition failed: ${label}\n${await evaluate('document.body.textContent')}\n${JSON.stringify(errors)}\n${JSON.stringify(requests.slice(-12))}`);
  };
  const navigate = async (route, heading) => {
    await command('Page.navigate', { url: `${origin}${route}` });
    await wait(`document.querySelector('h1')?.textContent.trim() === ${JSON.stringify(heading)}`, `${route} heading ${heading}`);
  };
  const click = async (text, scope = 'document') => evaluate(`(() => { const root=${scope};
    const target=[...root.querySelectorAll('button,a,summary')].find((element)=>element.textContent.trim()===${JSON.stringify(text)});
    if (!target) throw new Error('Missing action: '+${JSON.stringify(text)}); target.click(); })()`);
  const setValue = async (selector, value) => evaluate(`(() => { const field=document.querySelector(${JSON.stringify(selector)});
    if (!field) throw new Error('Missing field: '+${JSON.stringify(selector)});
    const prototype=field.tagName==='SELECT'?HTMLSelectElement.prototype:field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const noOverflow = async (label) => assert.equal(await evaluate(
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${label}: document overflow`);
  const screenshot = async (name) => {
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const metrics = async () => evaluate(`(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    return {
      route: location.pathname,
      domNodes: document.getElementsByTagName('*').length,
      resourceCount: resources.length,
      transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd || 0),
      loadMs: Math.round(navigation?.loadEventEnd || 0),
    };
  })()`);
  const close = async () => {
    try { await command('Browser.close'); } catch { /* socket closes during Browser.close */ }
    await Promise.race([
      new Promise((resolve) => browser.exitCode !== null ? resolve() : browser.once('exit', resolve)),
      pause(3000),
    ]);
    socket.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still release profile files */ }
  };
  return { command, evaluate, wait, navigate, click, setValue, noOverflow, screenshot, metrics, close, errors, blockedExternal };
}

const report = { personas: {}, layouts: [], performance: [], repricing: null, actualZoom: null, artifacts };
let client;
try {
  client = await launchBrowser();
  for (const width of [1440, 390, 360]) {
    await client.command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    currentPersona = 'storekeeper';
    await client.navigate('/products', 'Товари');
    await client.wait("document.body.textContent.includes('Реєстр товарів') && document.body.textContent.includes('AG-000002')", 'product register');
    await client.noOverflow(`Storekeeper products ${width}px`);
    assert.equal(await client.evaluate("getComputedStyle(document.querySelector('.app-navigation-toggle')).display === 'none'"), width > 720,
      `Navigation trigger visibility must match the sidebar mode at ${width}px`);
    const visibleDestinations = await client.evaluate("[...document.querySelectorAll('.app-sidebar .app-navigation-link')].map((link)=>link.textContent.trim())");
    assert.deepEqual(visibleDestinations, ['Товари', 'Потребує уваги']);
    if (width <= 390) {
      const logo = await client.evaluate(`(() => { const image=document.querySelector('.app-context-logo'); const box=image.getBoundingClientRect();
        return { width: box.width, height: box.height, intrinsicRatio: image.naturalWidth / image.naturalHeight }; })()`);
      assert.ok(Math.abs((logo.width / logo.height) - logo.intrinsicRatio) < 0.05,
        `Context logo must preserve its intrinsic ratio at ${width}px`);
      const attentionStrip = await client.evaluate("document.querySelector('.product-attention-link').getBoundingClientRect().toJSON()");
      const attentionLink = await client.evaluate("document.querySelector('.product-attention-link a').getBoundingClientRect().toJSON()");
      assert.ok(attentionStrip.height <= 60, `Product attention strip should stay compact at ${width}px`);
      assert.ok(attentionLink.height >= 44, `Product attention link must remain touchable at ${width}px`);
      const menu = await client.evaluate("document.querySelector('.app-navigation-toggle').getBoundingClientRect().toJSON()");
      assert.ok(menu.width >= 44 && menu.height >= 44, `Navigation trigger must be at least 44px at ${width}px`);
      await client.evaluate("document.querySelector('.app-navigation-toggle').click()");
      await client.wait("!!document.querySelector('[role=dialog] .app-navigation')", 'navigation drawer');
      assert.equal(await client.evaluate("[...document.querySelectorAll('[role=dialog] .app-navigation-link')].every((link)=>link.getBoundingClientRect().height>=44)"), true);
      await client.screenshot(`storekeeper-drawer-${width}`);
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.wait("!document.querySelector('[role=dialog]')", 'drawer closed');
      assert.equal(await client.evaluate("document.activeElement.classList.contains('app-navigation-toggle')"), true);
    }
    await client.screenshot(`storekeeper-products-${width}`);
    report.layouts.push({ persona: 'storekeeper', width, noOverflow: true, destinations: visibleDestinations });
  }

  await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  currentPersona = 'storekeeper';
  characteristicPolishFixture = true;
  await client.navigate('/products/open?article=AG-000020', 'Товар AG-000020');
  await client.wait("!!document.querySelector('.decode-field-row')", 'synthetic characteristic detail');
  const characteristicRows = await client.evaluate("[...document.querySelectorAll('.decode-field-row')].map((row)=>row.textContent)");
  assert.equal(characteristicRows.some((row) => row.includes('Не обрано')), false);
  assert.ok(characteristicRows.some((row) => row.includes('Справжній нуль')));
  assert.ok(characteristicRows.some((row) => row.includes('Числове поле0')));
  assert.ok(characteristicRows.some((row) => row.includes('Некалібрований')));
  await client.screenshot('characteristic-polish-detail');
  await client.click('Переоблік');
  await client.wait("!!document.querySelector('.recount-workspace')", 'synthetic recount editor');
  await client.click('Годинник');
  await client.wait("document.body.textContent.includes('Перераховано')", 'synthetic recount preview');
  assert.equal(await client.evaluate("document.querySelector('#recount-numeric_zero').value"), '0');
  const meaningfulRows = await client.evaluate("[...document.querySelectorAll('.recount-change-row')].map((row)=>row.textContent)");
  assert.deepEqual(meaningfulRows, ['Тип сувеніраПисьмовий набір → Годинник']);
  await client.noOverflow('Characteristic polish comparison');
  await client.screenshot('characteristic-polish-recount');
  await client.click('Продовжити');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Застосувати переоблік?')", 'synthetic recount confirmation');
  const confirmation = await client.evaluate("document.querySelector('[role=dialog]').textContent");
  assert.ok(confirmation.includes('Тип сувеніра: Письмовий набір → Годинник'));
  assert.equal(confirmation.includes('Деталь набору:'), false);
  assert.equal(confirmation.includes('Відсутнє'), false);
  await client.click('Застосувати переоблік', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('Переоблік застосовано. Артикул: AG-000020')", 'synthetic direct recount receipt');
  assert.equal(characteristicPolishApplied, true);
  report.characteristicPolish = { absentRowsOmitted: true, numericZeroVisible: true, calibrationZeroVisible: true,
    meaningfulParentChangeOnly: true, confirmationClean: true, stablePublicArticle: true, directRecountApplied: true };
  characteristicPolishFixture = false;
  await client.navigate('/products', 'Товари');
  await client.setValue('.product-register-search input', product.publicSku);
  await client.click('Знайти');
  await client.wait(`performance.getEntriesByType('resource').some((entry)=>entry.name.includes('/api/products/register?')&&entry.name.includes('search=${encodeURIComponent(product.publicSku)}'))`, 'register search request');
  await client.wait("!!document.querySelector('[aria-label=\"Скопіювати артикул AG-000002\"]')", 'public article copy action');
  await client.evaluate("document.querySelector('[aria-label=\"Скопіювати артикул AG-000002\"]').click()");
  await client.wait("window.fixtureCopies.includes('AG-000002')", 'public article copied');
  assert.equal(await client.evaluate("window.fixtureCopies.includes('SV227002')"), false, 'internal SKU must not be copied as the article');
  await client.evaluate("document.querySelector('[aria-label=\"Відкрити товар AG-000002\"]').click()");
  await client.wait("location.pathname==='/products/open' && document.body.textContent.includes('Стан у базі')", 'opened product detail');
  assert.equal(await client.evaluate("document.querySelector('h1')===document.activeElement"), true, 'pathname navigation focuses the page heading');
  await client.noOverflow('Storekeeper product detail desktop');
  await client.screenshot('storekeeper-product-detail-1440');
  await client.click('Переоблік');
  await client.wait("!!document.querySelector('#recount-weight')", 'recount editor');
  await client.setValue('#recount-weight', '11');
  await client.wait("document.body.textContent.includes('Перераховано')", 'authoritative recount preview');
  await client.click('Продовжити');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Застосувати переоблік?')", 'recount confirmation');
  await client.click('Застосувати переоблік', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('Переоблік застосовано')", 'recount receipt');
  await client.click('Змінити ціну');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Змінити ціну чинного товару')", 'direct price dialog');
  await client.setValue('[role=dialog] input[aria-label="Нова ціна UAH"], [role=dialog] label input[type=number]', '1450');
  await client.wait("[...document.querySelectorAll('[role=dialog] button')].some((button)=>button.textContent.trim()==='Змінити ціну'&&!button.disabled)", 'direct price preview');
  await client.click('Змінити ціну', "document.querySelector('[role=dialog]')");
  await client.wait(`document.body.textContent.includes('Ціну товару ${product.publicSku} змінено')`, 'direct price receipt');
  await client.click('Додаткові дії');
  await client.click('Архівувати товар');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Архівувати товар?')", 'archive confirmation');
  assert.equal(await client.evaluate("document.activeElement.textContent.trim()==='Скасувати'"), true, 'dangerous confirmation initially focuses Cancel');
  await client.click('Архівувати товар', "document.querySelector('[role=dialog]')");
  await client.wait(`location.pathname==='/products'&&document.body.textContent.includes('Товар ${product.publicSku} перенесено в архів')`, 'archive receipt');
  report.personas.storekeeper = { register: true, searched: true, publicArticleCopied: true, productOpened: true, routeFocus: true,
    directRecount: true, directPriceChange: true, archived: true };
  report.performance.push(await client.metrics());

  await client.navigate('/attention', 'Потребує уваги');
  await client.wait("document.body.textContent.includes('2зафіксованих проблем') && [...document.querySelectorAll('a')].some((link)=>link.textContent.trim()==='Переглянути проблеми')", 'storekeeper delivery attention');
  await client.click('Переглянути проблеми');
  await client.wait("location.pathname==='/sync-problems' && document.querySelector('h1')?.textContent.trim()==='Проблеми доставки до Magento'", 'storekeeper synchronization problem workspace');
  await client.wait(`document.body.textContent.includes('кінцевий стан не підтверджено') && document.body.textContent.includes(${JSON.stringify(product.publicSku)})`, 'selected synchronization problem');
  assert.equal(await client.evaluate("[...document.querySelectorAll('button,a')].some((element)=>/Повтор|Retry/.test(element.textContent))"), false,
    'An uncertain synchronization problem must not expose a resend action');
  assert.equal(await client.evaluate(`document.querySelector('a[href="/products/open?article=${product.publicSku}"]')?.textContent.trim()`), 'Відкрити товар');
  assert.equal(requests.some((entry) => entry.persona === 'storekeeper'
    && entry.method === 'GET' && entry.path === '/api/magento/problems/page'), true,
  'Storekeeper synchronization navigation must read the existing safe problem projection');
  await client.noOverflow('Storekeeper synchronization problem desktop');
  await client.screenshot('storekeeper-synchronization-problem-1440');
  report.personas.storekeeper.syncProblemOpened = true;
  report.performance.push(await client.metrics());

  for (const width of [390, 360]) {
    await client.command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    currentPersona = 'correctionOperator';
    await client.navigate('/admin/corrections', 'Запити на виправлення');
    await client.wait("document.querySelectorAll('.correction-queue-item').length===2 && document.querySelector('.correction-request-detail h2')?.textContent.includes('#71')", `correction queue ${width}px`);
    await client.noOverflow(`Correction queue ${width}px`);
    assert.equal(await client.evaluate(`(() => { const filters=document.querySelector('.correction-filter-tabs');
      return filters.querySelectorAll('button').length===7 && filters.scrollWidth<=filters.clientWidth; })()`), true,
    `All correction filters must remain visible without a horizontal strip at ${width}px`);
    await client.evaluate("document.querySelectorAll('.correction-queue-item')[1].focus()");
    assert.equal(await client.evaluate("document.activeElement===document.querySelectorAll('.correction-queue-item')[1]"), true,
      `The second correction must receive keyboard focus at ${width}px`);
    await client.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' });
    await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32 });
    await client.wait("document.querySelector('.correction-request-detail h2')?.textContent.includes('#72') && document.querySelectorAll('.correction-queue-item')[1]?.getAttribute('aria-pressed')==='true'", `keyboard-selected correction ${width}px`);
    assert.equal(await client.evaluate("new URLSearchParams(location.search).get('request')"), '72');
    await client.noOverflow(`Keyboard-selected correction detail ${width}px`);
    await client.screenshot(`correction-keyboard-detail-${width}`);

    currentPersona = 'manager';
    await client.navigate('/admin/repricing', 'Масова переоцінка');
    await client.wait("[...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Попередній перегляд')", `repricing preparation ${width}px`);
    await client.click('Попередній перегляд');
    await client.wait("location.search.includes('view=review') && document.body.textContent.includes('1–50 із 1000')", `repricing review ${width}px`);
    assert.equal(await client.evaluate("document.querySelectorAll('.repricing-workspace tbody > tr').length"), 50);
    await client.noOverflow(`Repricing 1000-row review ${width}px`);
    await client.screenshot(`repricing-review-${width}`);
    report.layouts.push({ persona: 'manager', route: 'corrections-and-repricing', width,
      noOverflow: true, keyboardSelectedCorrection: 72, repricingRows: 50 });
  }

  await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  currentPersona = 'correctionOperator';
  await client.navigate('/admin/corrections', 'Запити на виправлення');
  await client.wait("document.body.textContent.includes('AG-000020') && [...document.querySelectorAll('button')].some((button)=>button.textContent.includes('Взяти в роботу'))", 'unowned correction request');
  await client.click('Взяти в роботу');
  await client.wait("document.body.textContent.includes('Запит у роботі у вас.') && [...document.querySelectorAll('button')].some((button)=>button.textContent.includes('Перевірити й застосувати'))", 'owned correction request');
  await client.click('Перевірити й застосувати');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Застосувати зміни в Amber?') && document.querySelector('[role=dialog]')?.textContent.includes('AG-000020')", 'correction completion review');
  assert.equal(await client.evaluate("document.activeElement.textContent.trim()==='Скасувати'"), true,
    'correction completion initially focuses Cancel');
  await client.click('Виконати переоблік в Amber', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('Зміни застосовано в Amber') && document.body.textContent.includes('AG-000020')", 'correction completion receipt');
  await client.noOverflow('Correction ownership and completion desktop');
  await client.screenshot('delegated-correction-operator-completion-1440');
  report.personas.delegatedCorrectionOperator = {
    effectiveCapabilities: ['corrections.view', 'corrections.claim', 'corrections.complete'],
    correctionClaimedAndCompleted: true,
    builtInRoleGrantAssumed: false,
  };

  fixtureProductStatus = 'active';
  currentPersona = 'manager';
  await client.navigate('/attention', 'Потребує уваги');
  await client.wait("document.body.textContent.includes('3активних запитів') && document.body.textContent.includes('2зафіксованих проблем')", 'independent attention counts');
  await client.noOverflow('Manager attention desktop');
  await client.screenshot('manager-attention-1440');
  const legacyWritesBefore = requests.filter((entry) => entry.method !== 'GET').length;
  for (const width of [1440, 390, 360]) {
    await client.command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.navigate('/attention', 'Потребує уваги');
    if (width <= 720) {
      await client.evaluate("document.querySelector('.app-navigation-toggle').click()");
      await client.wait("!!document.querySelector('[role=dialog] .app-navigation')", 'manager navigation drawer');
      assert.equal(await client.evaluate("document.querySelectorAll('[role=dialog] .app-navigation a[href^=\"/exports\"]').length"), 0);
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.wait("!document.querySelector('[role=dialog]')", 'manager navigation drawer closed');
    }
    assert.equal(await client.evaluate("document.querySelectorAll('.app-navigation a[href^=\"/exports\"]').length"), 0,
      'Neither export stream may appear in primary navigation');
    assert.equal(await client.evaluate("document.querySelector('.app-navigation a[href=\"/archive\"]')"), null,
      'Legacy export must not be replaced by a prominent archive destination');
    await client.evaluate("document.querySelector('.app-account-menu button').click()");
    await client.wait("!!document.querySelector('.ui-action-menu-popup a[href=\"/exports\"]') && getComputedStyle(document.querySelector('.ui-action-menu-popup')).visibility==='visible'", 'secondary legacy account access');
    await client.noOverflow(`Legacy account menu ${width}px`);
    await client.screenshot(`legacy-account-menu-${width}`);
    await client.click('Історичний експорт', "document.querySelector('.ui-action-menu-popup')");
    await client.wait("location.pathname==='/exports' && document.querySelector('h1')?.textContent.trim()==='Історичний експорт' && document.body.textContent.includes('CSV товарів вимкнено')", 'legacy export overview');
    assert.equal(await client.evaluate("document.querySelector('.export-destination-list a').getAttribute('href')"), '/exports/history');
    assert.equal(await client.evaluate("!!document.querySelector('a.btn-primary[href=\"/exports/prices\"]')"), false);
    await client.click('Стан сумісного потоку цін');
    await client.wait("document.body.textContent.includes('5 змін у сумісній черзі експорту цін')", 'compatibility price evidence on demand');
    await client.noOverflow(`Legacy export overview ${width}px`);
    await client.screenshot(`legacy-export-overview-${width}`);
    await client.click('Експорт цін (сумісність)');
    await client.wait("location.pathname==='/exports/prices' && document.querySelector('h2')?.textContent.includes('Експорт цін (сумісність)')", 'legacy price URL');
    await client.noOverflow(`Legacy price export ${width}px`);
  }
  assert.equal(requests.filter((entry) => entry.method !== 'GET').length, legacyWritesBefore,
    'Discovering legacy routes must not issue commands');
  report.legacyNavigation = { primaryExport: false, accountEntry: true, historicalFilesFirst: true,
    priceCompatibilityUrl: true, widths: [1440, 390, 360], implicitWrites: 0 };
  await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await client.navigate(`/products/open?article=${encodeURIComponent(product.publicSku)}`, `Товар ${product.publicSku}`);
  await client.wait("document.body.textContent.includes('Стан у базі')", 'manager product detail');
  await client.click('Історія товару');
  await client.wait("location.pathname==='/products/history' && document.querySelector('h1')?.textContent.trim()==='Історія товару'", 'manager product history route');
  await client.wait(`document.querySelector('[aria-label="Поточний стан товару"]')?.textContent.includes(${JSON.stringify(product.publicSku)}) && document.body.textContent.includes('Ціну товару змінено')`, 'authoritative product timeline');
  assert.equal(requests.some((entry) => entry.persona === 'manager'
    && entry.method === 'GET' && entry.path === '/api/product-timeline'
    && new URLSearchParams(entry.search).get('sku') === product.publicSku), true,
  'Manager product history must use the exact timeline read projection');
  await client.click('Версії та технічні деталі');
  await client.wait(`document.body.textContent.includes('Внутрішній SKU:') && document.body.textContent.includes(${JSON.stringify(product.internalSku)})`, 'timeline technical identity on demand');
  await client.noOverflow('Manager product history desktop');
  await client.screenshot('manager-product-history-1440');
  report.performance.push(await client.metrics());
  await client.evaluate('history.back()');
  await client.wait(`location.pathname==='/products/open' && document.querySelector('h1')?.textContent.trim()===${JSON.stringify(`Товар ${product.publicSku}`)}`, 'return from product history');
  await client.wait("document.body.textContent.includes('Стан у базі')", 'manager product detail restored');
  await client.click('Змінити ціну');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Змінити ціну чинного товару')", 'price request dialog');
  await client.wait("[...document.querySelectorAll('[role=dialog] button')].some((button)=>button.textContent.trim()==='Створити запит на зміну ціни'&&!button.disabled)", 'price request preview');
  await client.click('Створити запит на зміну ціни', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('Створено запит на зміну ціни #41')", 'price request receipt');
  report.personas.manager = { attentionCounts: { corrections: 3, delivery: 2 }, legacyExportsInspected: true,
    productHistoryInspected: true, priceRequestCreated: true };
  report.performance.push(await client.metrics());

  const repricingStartedAt = await client.evaluate('Date.now()');
  await client.navigate('/admin/repricing', 'Масова переоцінка');
  await client.wait("[...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Попередній перегляд')", 'repricing preparation');
  const repricingPreviewStartedAt = await client.evaluate('Date.now()');
  await client.click('Попередній перегляд');
  await client.wait("location.search.includes('view=review') && document.body.textContent.includes('1–50 із 1000')", '1000-row repricing review');
  const repricingRenderedAt = await client.evaluate('Date.now()');
  const repricingRender = await client.evaluate(`({
    rows: document.querySelectorAll('.repricing-workspace tbody > tr').length,
    domNodes: document.getElementsByTagName('*').length,
    summary: document.querySelector('.action-summary-bar')?.textContent || ''
  })`);
  assert.equal(repricingRender.rows, 50, 'The 1000-row repricing review must mount only one 50-row page');
  assert.ok(repricingRender.summary.includes('Рядків на цій сторінці: 50 із 1000'));
  const repricingPreviewLatencyMs = Math.round(repricingRenderedAt - repricingPreviewStartedAt);
  assert.ok(repricingPreviewLatencyMs < 3000, `Fixture repricing review should render within 3s, received ${repricingPreviewLatencyMs}ms`);
  await client.click('Далі', "document.querySelector('.repricing-workspace')");
  await client.wait("document.body.textContent.includes('51–100 із 1000') && document.querySelector('.repricing-workspace tbody th .font-mono')?.textContent.trim()==='AG-001051'", 'second repricing presentation page');
  const repricingSecondPage = await client.evaluate(`({
    rows: document.querySelectorAll('.repricing-workspace tbody > tr').length,
    summary: document.querySelector('.action-summary-bar')?.textContent || ''
  })`);
  assert.equal(repricingSecondPage.rows, 50, 'The second repricing page must retain the 50-row DOM bound');
  assert.ok(repricingSecondPage.summary.includes('Застосування охопить усі 1000 підготовлені зміни.'),
    'Changing the presentation page must retain the full authoritative apply scope');
  await client.click('Назад', "document.querySelector('.repricing-workspace')");
  await client.wait("document.body.textContent.includes('1–50 із 1000') && document.querySelector('.repricing-workspace tbody th .font-mono')?.textContent.trim()==='AG-001001'", 'first repricing presentation page restored');
  assert.equal(await client.evaluate("document.querySelectorAll('.repricing-workspace tbody > tr').length"), 50,
    'Returning to the first repricing page must retain the 50-row DOM bound');
  await client.click('Позначити');
  await client.wait("document.body.textContent.includes('Чернетка #77') && document.body.textContent.includes('Переглянуто: 1')", 'saved repricing draft');
  await client.click('Застосувати переоцінку');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Застосувати переоцінку?')", 'repricing apply review');
  assert.equal(await client.evaluate("document.activeElement.textContent.trim()==='Скасувати'"), true,
    'repricing apply initially focuses Cancel');
  await client.click('Застосувати переоцінку', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('Переоцінку застосовано в Amber') && document.body.textContent.includes('Magento') && document.body.textContent.includes('0 / 1000 синхронізовано')", 'separate repricing delivery state');
  await client.noOverflow('Repricing review desktop');
  await client.screenshot('manager-repricing-batch-delivery-1440');
  report.personas.manager.repricingDraftReviewedAndApplied = true;
  report.repricing = { previewItems: 1000, renderedRows: repricingRender.rows, domNodes: repricingRender.domNodes,
    navigationAndDataMs: Math.round(repricingRenderedAt - repricingStartedAt), previewToReviewMs: repricingPreviewLatencyMs,
    paginationPreservedFullScope: true, amberApplied: true,
    delivery: { synced: 0, pending: 990, needsAttention: 10 } };

  currentPersona = 'exportCreator';
  await client.navigate('/', 'Історичний експорт');
  assert.equal(await client.evaluate("document.querySelectorAll('.app-navigation-link').length"), 0,
    'Export-only root fallback must not create a primary export destination');
  await client.navigate('/exports/new/template', 'Історичний експорт');
  await client.wait("document.body.textContent.includes('Створити свій експорт')", 'delegated export create form');
  await client.setValue('input[maxlength="160"]', 'Щотижневий каталог');
  await client.click('Створити приватний експорт');
  await client.wait("location.pathname==='/exports/sessions/created-session' && document.body.textContent.includes('Щотижневий каталог')", 'saved delegated export workspace');
  assert.equal(requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/export/sessions').length, 1);
  assert.equal(requests.some((entry) => /\/api\/export\/sessions\/created-session\/(preview|prepare|generate)$/.test(entry.path)), false,
    'saving a delegated export workspace must not preview, prepare, or generate files');

  currentPersona = 'exportViewer';
  await client.navigate('/exports/sessions/saved-a', 'Історичний експорт');
  await client.wait("document.body.textContent.includes('Збережені файли') && document.body.textContent.includes('Очікує підтвердження')", 'view-only stored export result');
  assert.equal(await client.evaluate("[...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Завершити експорт')"), false,
    'view-only delegated access must not expose confirmation');
  assert.equal(requests.some((entry) => entry.path === '/api/export/snapshots/stored-a/confirm'), false,
    'reading a delegated result must not confirm it');
  await client.noOverflow('Delegated view-only stored export desktop');
  await client.screenshot('delegated-viewer-stored-export-1440');
  report.personas.delegatedExport = { workspaceCreatedWithoutFiles: true, storedResultReadable: true,
    viewOnlyCannotConfirm: true, readDidNotConfirm: true };

  currentPersona = 'administrator';
  magentoReadinessFixture = true;
  readinessNamesApplied = false;
  readinessSizeApplied = false;
  fixtureProductStatus = 'active';
  const readinessRequestStart = requests.length;
  await client.navigate('/sync-problems', 'Проблеми доставки до Magento');
  await client.wait("document.body.textContent.includes('Товар не готовий до синхронізації') && document.body.textContent.includes('SV5111010')", 'readiness problem guidance');
  assert.equal(await client.evaluate("document.body.textContent.includes('Не вдалося прочитати назву Magento')"), false);
  assert.equal(await client.evaluate("['Розмір','Назва українською та англійською','Обробка каменю'].every((label)=>document.body.textContent.includes(label))"), true);
  assert.equal(await client.evaluate("[...document.querySelectorAll('button,a')].some((node)=>/Повторити|Надіслати повторно/.test(node.textContent))"), false);
  await client.click('Технічні деталі', "document.querySelectorAll('.sync-problem-detail section')[1]");
  await client.wait("document.body.textContent.includes('PRODUCT_EVALUATION_NOT_READY') && document.body.textContent.includes('kamin_obrobka, name, rozmir_suveniriv')", 'raw readiness diagnostics');
  await client.click('Виправити дані товару');
  await client.wait("document.body.textContent.includes('Товар SV5111010') && document.body.textContent.includes('Потребує уваги')", 'legacy product readiness detail');
  await client.click('Заповнити назви');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Назви для Magento · SV5111010')", 'missing-name repair workspace');
  await client.setValue('[role=dialog] input[id$="-ua"]', 'Сувенірний камінь');
  await client.setValue('[role=dialog] input[id$="-en"]', 'Souvenir stone');
  await client.click('Переглянути зміни', "document.querySelector('[role=dialog]')");
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Попередній перегляд')", 'name preview');
  await client.click('Зберегти назви', "document.querySelector('[role=dialog]')");
  await client.wait("!document.querySelector('[role=dialog]') && ![...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Заповнити назви')", 'name repair applied');
  await client.click('Заповнити розмір');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Розмір товару · SV5111010')", 'size information workspace');
  await client.setValue('[role=dialog] input', '12 × 8 см');
  await client.click('Переглянути зміну', "document.querySelector('[role=dialog]')");
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Попередній перегляд')", 'size preview');
  await client.click('Зберегти розмір', "document.querySelector('[role=dialog]')");
  await client.wait("!document.querySelector('[role=dialog]') && ![...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Заповнити розмір')", 'size repair applied');
  const readinessRequests = requests.slice(readinessRequestStart);
  for (const path of ['/api/product-magento-name/preview', '/api/product-magento-name/apply',
    '/api/product-information/preview', '/api/product-information/apply']) {
    assert.ok(readinessRequests.some((entry) => entry.path === path), `Readiness flow must call ${path}`);
  }
  assert.equal(readinessRequests.some((entry) => entry.path.startsWith('/api/recount/')), false,
    'Completing names and size must not start a recount');
  report.magentoReadinessRecovery = { publicArticle: 'SV5111010', rawDiagnosticsAvailable: true,
    nameWorkflow: true, informationWorkflow: true, recountWrites: 0, resendAction: false };
  magentoReadinessFixture = false;
  await client.navigate(`/products/open?article=${encodeURIComponent(product.publicSku)}`, `Товар ${product.publicSku}`);
  await client.wait("document.body.textContent.includes('Стан у базі')", 'administrator product detail');
  await client.click('Додаткові дії');
  await client.click('Видалити тестовий товар');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Видалити тестовий товар')", 'test deletion dialog');
  await client.click('Перевірити можливість видалення', "document.querySelector('[role=dialog]')");
  await client.wait(`document.querySelector('[role=dialog]')?.textContent.includes('Введіть точно ${product.publicSku}')`, 'test deletion inspection');
  assert.equal(requests.some((entry) => entry.path === '/api/products/test-delete/apply'), false,
    'inspection must not send the irreversible external action');
  await client.click('Закрити', "document.querySelector('[role=dialog]')");
  await client.navigate('/administration', 'Адміністрування');
  const adminLinks = await client.evaluate("[...document.querySelectorAll('.workspace-directory-link')].map((link)=>link.textContent.trim())");
  assert.equal(adminLinks.length, 3, 'Administrator directory exposes users, roles, and audit');
  await client.navigate('/admin/users', 'Користувачі застосунку');
  await client.wait("!!document.querySelector('[aria-label=\"Відкрити Active User\"]')", 'managed user list');
  await client.evaluate("document.querySelector('[aria-label=\"Відкрити Active User\"]').click()");
  await client.wait("!!document.querySelector('[role=dialog] select[aria-label=\"Роль для Active User\"]')", 'selected-user drawer');
  await client.setValue('[role=dialog] select[aria-label="Роль для Active User"]', '2');
  await client.click('Переглянути зміну ролі', "document.querySelector('[role=dialog]')");
  await client.wait("[...document.querySelectorAll('[role=dialog]')].some((dialog)=>dialog.textContent.includes('Змінити роль для «Active User»?'))", 'reviewed role change');
  assert.equal(await client.evaluate("document.activeElement.textContent.trim()==='Скасувати'"), true,
    'reviewed user-role change initially focuses Cancel');
  await client.click('Змінити роль', "[...document.querySelectorAll('[role=dialog]')].find((dialog)=>dialog.textContent.includes('Змінити роль для «Active User»?'))");
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Роль для Active User оновлено.')", 'user role receipt inside the active drawer');
  await client.noOverflow('Users administration desktop');
  await client.screenshot('administrator-users-role-review-1440');

  await client.navigate('/admin/roles', 'Ролі та дозволи');
  await client.wait("!![...document.querySelectorAll('.role-list-item')].find((button)=>button.textContent.includes('Manager'))", 'role list');
  await client.evaluate("[...document.querySelectorAll('.role-list-item')].find((button)=>button.textContent.includes('Manager')).click()");
  await client.wait("!![...document.querySelectorAll('input[type=checkbox]')].find((input)=>input.closest('label')?.textContent.includes('Перегляд товарів'))", 'role permission editor');
  await client.evaluate("[...document.querySelectorAll('input[type=checkbox]')].find((input)=>input.closest('label')?.textContent.includes('Перегляд товарів')).click()");
  await client.wait("document.body.textContent.includes('Запропоновані зміни') && document.body.textContent.includes('Вилучаються: Перегляд товарів')", 'role change summary');
  await client.click('Зберегти зміни');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Змінити дозволи ролі «Manager»?')", 'role impact confirmation');
  assert.equal(await client.evaluate("document.activeElement.textContent.trim()==='Скасувати'"), true,
    'permission removal initially focuses Cancel');
  await client.click('Змінити дозволи', "document.querySelector('[role=dialog]')");
  await client.wait("document.body.textContent.includes('На сервері є новіша версія ролі') && document.body.textContent.includes('Manager server')", 'role conflict evidence');
  assert.equal(await client.evaluate("[...document.querySelectorAll('button')].find((button)=>button.textContent.trim()==='Зберегти зміни').disabled"), true,
    'role conflict blocks blind resave');
  await client.noOverflow('Roles proposed-change conflict desktop');
  await client.screenshot('administrator-roles-conflict-1440');

  await client.navigate('/admin/audit', 'Глобальний аудит');
  await client.wait("document.body.textContent.includes('Роль користувача змінено') && document.body.textContent.includes('Історичне ім’я')", 'dense audit chronology');
  assert.equal(await client.evaluate("document.body.textContent.includes('application_user.role_changed')"), false,
    'technical audit key stays hidden from the chronology');
  await client.click('Відкрити');
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('Manager')", 'selected audit evidence');
  await client.click('Технічні деталі', "document.querySelector('[role=dialog]')");
  await client.wait("document.querySelector('[role=dialog]')?.textContent.includes('application_user.role_changed')", 'technical audit disclosure');
  await client.noOverflow('Audit selected evidence desktop');
  await client.screenshot('administrator-audit-evidence-1440');
  await client.evaluate("document.querySelector('[role=dialog] [aria-label=\"Закрити\"]').click()");
  await client.navigate('/settings', 'Налаштування');
  const settingLinks = await client.evaluate("[...document.querySelectorAll('.workspace-directory-link')].map((link)=>link.getAttribute('href'))");
  assert.deepEqual(settingLinks, ['/admin/catalog', '/admin/pricing', '/admin/magento', '/admin/export-templates']);
  assert.equal(await client.evaluate("!![...document.querySelectorAll('.workspace-directory-link')].find((link)=>link.textContent.includes('Шаблони інтеграції'))"), true);
  assert.equal(await client.evaluate("document.querySelectorAll('.workspace-directory a[href^=\"/exports\"]').length"), 0);
  await client.noOverflow('Administrator settings desktop');
  await client.screenshot('administrator-settings-1440');
  await client.navigate('/admin/catalog', 'Каталог');
  await client.wait("!![...document.querySelectorAll('.catalog-category-tab')].find((button)=>button.textContent.includes('Сувеніри'))", 'catalog category');
  await client.evaluate("[...document.querySelectorAll('.catalog-category-tab')].find((button)=>button.textContent.includes('Сувеніри')).click()");
  await client.wait("[...document.querySelectorAll('button')].some((button)=>button.textContent.trim()==='Опублікувати V2')", 'publishable SKU schema');
  await client.click('Опублікувати V2');
  await client.wait("document.body.textContent.includes('Схему SKU для «Сувеніри» опубліковано')", 'schema publication receipt');
  await client.noOverflow('Catalog workspace desktop');
  await client.screenshot('administrator-catalog-1440');
  await client.navigate('/admin/pricing', 'Ціноутворення');
  await client.wait("!![...document.querySelectorAll('.catalog-category-tab')].find((button)=>button.textContent.includes('Сувеніри'))", 'pricing category');
  await client.evaluate("[...document.querySelectorAll('.catalog-category-tab')].find((button)=>button.textContent.includes('Сувеніри')).click()");
  await client.wait("!![...document.querySelectorAll('.pricing-master-row')].find((button)=>button.textContent.includes('Базова ціна'))", 'pricing scenario');
  await client.evaluate("[...document.querySelectorAll('.pricing-master-row')].find((button)=>button.textContent.includes('Базова ціна')).click()");
  await client.wait("!!document.querySelector('.pricing-matrix-table input')", 'pricing matrix cell');
  await client.setValue('.pricing-matrix-table input', '125.50');
  await client.evaluate("document.querySelector('.pricing-matrix-table input').focus();document.querySelector('.pricing-matrix-table input').blur()");
  await client.wait("document.body.textContent.includes('Збережено')", 'pricing cell save state');
  await client.noOverflow('Pricing workspace desktop');
  await client.screenshot('administrator-pricing-1440');
  await client.navigate('/admin/export-templates', 'Шаблони експорту');
  await client.wait("document.body.textContent.includes('Шаблонів ще немає')", 'empty export template registry');
  await client.click('Створити шаблон');
  await client.wait("document.querySelector('h1')?.textContent.trim()==='Новий шаблон'", 'new export template form');
  await client.setValue('input[placeholder="Наприклад, Основний каталог"]', 'Основний каталог');
  await client.click('Створити й зберегти чернетку');
  await client.wait("document.querySelector('h1')?.textContent.trim()==='Основний каталог' && document.body.textContent.includes('Збережено · редакція 1')", 'saved export template draft');
  assert.equal(requests.some((entry) => entry.path.startsWith('/api/admin/export-templates/') && entry.path.endsWith('/publish')), false,
    'draft authoring must not publish a template');
  assert.equal(requests.some((entry) => entry.method === 'PUT' && entry.path === '/api/admin/export-templates/activation'), false,
    'draft authoring must not activate a template');
  await client.noOverflow('Export template authoring desktop');
  await client.screenshot('administrator-export-template-draft-1440');
  report.personas.administrator = { administrationDirectory: adminLinks.length, settingsDestinations: settingLinks,
    testDeletionInspectedWithoutApply: true, reviewedUserRoleChange: true, roleConflictBlocksResave: true,
    auditEvidenceOnDemand: true, skuSchemaPublished: true, pricingCellSaved: true,
    exportTemplateDraftCreatedWithoutPublication: true };
  report.performance.push(await client.metrics());
  assert.deepEqual(client.blockedExternal, [], 'Browser attempted an external request');
  assert.deepEqual(client.errors, [], 'Browser emitted an uncaught runtime exception');
  report.verification = { runtimeErrors: client.errors.length, externalRequests: client.blockedExternal.length };
  await client.close();
  client = null;

  const zoomClient = await launchBrowser({ actualZoom: true });
  client = zoomClient;
  currentPersona = 'administrator';
  await zoomClient.navigate('/settings', 'Налаштування');
  const zoom = await zoomClient.evaluate(`({ outerWidth, innerWidth, devicePixelRatio,
    clientWidth: document.documentElement.clientWidth, visualScale: visualViewport.scale })`);
  assert.equal(zoom.outerWidth, 1440);
  assert.ok(zoom.innerWidth >= 680 && zoom.innerWidth <= 740, `Expected a real 200% CSS viewport near 720px, received ${zoom.innerWidth}`);
  assert.ok(zoom.clientWidth >= 680 && zoom.clientWidth <= 740);
  assert.equal(zoom.devicePixelRatio, 2);
  assert.equal(zoom.visualScale, 1);
  await zoomClient.noOverflow('Administrator settings at actual 200% zoom');
  assert.equal(await zoomClient.evaluate("getComputedStyle(document.querySelector('.app-sidebar')).display"), 'none');
  const zoomMenuBox = await zoomClient.evaluate("document.querySelector('.app-navigation-toggle').getBoundingClientRect().toJSON()");
  assert.ok(zoomMenuBox.width >= 44 && zoomMenuBox.height >= 44);
  await zoomClient.evaluate("document.activeElement?.blur()");
  await zoomClient.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await zoomClient.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await zoomClient.evaluate("document.activeElement.getAttribute('aria-label')"), 'Відкрити навігацію');
  const focusStyle = await zoomClient.evaluate(`(() => { const style=getComputedStyle(document.activeElement);
    return { width: parseFloat(style.outlineWidth), color: style.outlineColor }; })()`);
  assert.ok(focusStyle.width >= 2);
  assert.equal(focusStyle.color, 'rgb(221, 151, 74)');
  await zoomClient.screenshot('administrator-settings-actual-200-percent');
  await zoomClient.navigate('/admin/magento', 'Інтеграція Magento');
  await zoomClient.wait("document.body.textContent.includes('Проблеми поточної доставки')", 'Magento issue-first overview at actual zoom');
  const magentoIssueTop = await zoomClient.evaluate("document.getElementById('magento-operational-title').getBoundingClientRect().top");
  const zoomViewportHeight = await zoomClient.evaluate('window.innerHeight');
  assert.ok(magentoIssueTop < zoomViewportHeight,
    `Magento delivery problems should begin within the first actual-zoom viewport: top=${magentoIssueTop}, viewport=${zoomViewportHeight}`);
  assert.equal(await zoomClient.evaluate("document.querySelector('.magento-context-toggle').getAttribute('aria-expanded')"), 'false');
  await zoomClient.noOverflow('Magento overview at actual 200% zoom');
  await zoomClient.screenshot('administrator-magento-actual-200-percent');
  report.actualZoom = { ...zoom, noOverflow: true, touchTarget: zoomMenuBox, focusStyle,
    magentoIssueTop, zoomViewportHeight, magentoContextCollapsed: true };
  report.performance.push(await zoomClient.metrics());
  assert.deepEqual(zoomClient.blockedExternal, [], '200% browser attempted an external request');
  assert.deepEqual(zoomClient.errors, [], '200% browser emitted an uncaught runtime exception');
  report.verification.runtimeErrors += zoomClient.errors.length;
  report.verification.externalRequests += zoomClient.blockedExternal.length;
  await zoomClient.close();
  client = null;

  const allowedFixtureWrites = new Set(['/api/decode', '/api/recount/preview', '/api/recount/apply',
    '/api/product-price-change/preview', '/api/product-price-change/apply', '/api/admin/correction-requests/preview',
    '/api/admin/correction-requests', '/api/delete', '/api/products/test-delete/preview',
    '/api/admin/sku-schema/SV/publish', '/api/admin/price-cell', '/api/admin/export-templates', '/api/export/sessions']);
  allowedFixtureWrites.add('/api/admin/users/102/role');
  allowedFixtureWrites.add('/api/admin/roles/2/permissions');
  allowedFixtureWrites.add('/api/admin/correction-requests/71/claim');
  allowedFixtureWrites.add('/api/admin/correction-requests/71/complete');
  allowedFixtureWrites.add('/api/admin/repricing/preview');
  allowedFixtureWrites.add('/api/admin/repricing/drafts');
  allowedFixtureWrites.add('/api/admin/repricing/drafts/77');
  allowedFixtureWrites.add('/api/admin/repricing/apply');
  allowedFixtureWrites.add('/api/product-magento-name/preview');
  allowedFixtureWrites.add('/api/product-magento-name/apply');
  allowedFixtureWrites.add('/api/product-information/preview');
  allowedFixtureWrites.add('/api/product-information/apply');
  const unexpectedWrites = requests.filter((entry) => entry.method !== 'GET' && !allowedFixtureWrites.has(entry.path));
  assert.deepEqual(unexpectedWrites, [], 'Local fixture observed an unexpected write');
  assert.deepEqual(unexpected, [], 'The application requested an unimplemented fixture API');
  Object.assign(report.verification, { requestCount: requests.length,
    unexpectedFixtureRequests: unexpected.length, unexpectedWrites: unexpectedWrites.length });
  console.log(JSON.stringify({ result: 'passed', ...report }, null, 2));
} finally {
  if (client) await client.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
