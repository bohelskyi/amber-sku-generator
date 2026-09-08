import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getMatrixPriceValidationError } from '../src/lib/number-input.js';

test('matrix price validation rejects zero but permits clearing and positive values', () => {
  assert.equal(getMatrixPriceValidationError(''), '');
  assert.equal(getMatrixPriceValidationError('125.50'), '');
  assert.match(getMatrixPriceValidationError('0'), /більшою за 0/);
  assert.match(getMatrixPriceValidationError('-1'), /більшою за 0/);
});

test('SKU manager exposes correction manual-price state to the confirmation dialog', () => {
  const source = fs.readFileSync(
    new URL('../src/hooks/useSkuManager.js', import.meta.url),
    'utf8'
  );
  const occurrences = source.match(/recountManualPriceUah/g) || [];
  const setterOccurrences = source.match(/setRecountManualPriceUah/g) || [];
  assert.ok(occurrences.length >= 2, 'manual price must be destructured and returned');
  assert.ok(setterOccurrences.length >= 2, 'manual price setter must be destructured and returned');
});

test('matrix and correction request errors have visible alert regions', () => {
  const matrixSource = fs.readFileSync(
    new URL('../src/components/admin/AdminPricingEditor.jsx', import.meta.url),
    'utf8'
  );
  const dialogSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );
  assert.match(matrixSource, /matrixValidationError/);
  assert.match(matrixSource, /role="alert"/);
  assert.match(dialogSource, /role="alert"/);
});

test('dialogs share focus trapping, Escape handling, and focus restoration', () => {
  const dialogSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );
  const hookSource = fs.readFileSync(
    new URL('../src/hooks/useDialogAccessibility.js', import.meta.url),
    'utf8'
  );
  const repricingSource = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );
  const correctionQueueSource = fs.readFileSync(
    new URL('../src/pages/CorrectionRequestsPage.jsx', import.meta.url),
    'utf8'
  );
  const drawerSource = fs.readFileSync(
    new URL('../src/components/app/RepricingRecountDrawer.jsx', import.meta.url),
    'utf8'
  );

  assert.match(hookSource, /event\.key === 'Escape'/);
  assert.match(hookSource, /event\.key !== 'Tab'/);
  assert.match(hookSource, /previousActiveElement/);
  assert.match(hookSource, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(dialogSource, /useDialogAccessibility/);
  assert.match(repricingSource, /role="dialog"/);
  assert.match(correctionQueueSource, /aria-modal="true"/);
  assert.match(drawerSource, /role="dialog"/);
});

test('dialogs and sticky summaries remain bounded on short viewports', () => {
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );
  const builderSource = fs.readFileSync(
    new URL('../src/components/app/ProductBuilder.jsx', import.meta.url),
    'utf8'
  );
  const dashboardSource = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );

  assert.match(stylesSource, /max-height: calc\(100dvh - 2rem\)/);
  assert.match(stylesSource, /\.dialog-body[\s\S]*?overflow-y-auto/);
  assert.match(stylesSource, /\.sticky-summary[\s\S]*?max-height:/);
  assert.match(builderSource, /sticky-summary/);
  assert.ok((dashboardSource.match(/sticky-summary/g) || []).length >= 2);
});

test('compact buttons override the normal button minimum height without shrinking normal actions', () => {
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );

  assert.match(stylesSource, /\.btn \{[\s\S]*?min-h-10/);
  assert.match(stylesSource, /\.btn\.btn-icon[\s\S]*?min-height: 2rem/);
  assert.match(stylesSource, /\.btn\.btn-compact[\s\S]*?min-height: 2rem/);
});

test('sticky navigation and admin anchors use shared responsive offsets', () => {
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );
  const adminSource = fs.readFileSync(
    new URL('../src/pages/AdminPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(stylesSource, /--workspace-nav-height: 70px/);
  assert.match(stylesSource, /--workspace-nav-height: 56px/);
  assert.match(stylesSource, /\.admin-section-nav[\s\S]*?top: var\(--workspace-nav-height\)/);
  assert.match(stylesSource, /\.admin-anchor-section[\s\S]*?scroll-margin-top:/);
  assert.ok((adminSource.match(/admin-anchor-section/g) || []).length >= 2);
});

test('operational placeholder inputs have explicit accessible names', () => {
  const sources = [
    '../src/components/app/ExportTools.jsx',
    '../src/components/app/HomeDashboard.jsx',
    '../src/components/app/RepricingRecountDrawer.jsx',
    '../src/components/app/RecountConfirmDialog.jsx',
    '../src/pages/CorrectionRequestsPage.jsx',
    '../src/pages/RepricingPage.jsx',
  ].map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

  for (const source of sources) {
    assert.match(source, /aria-label=/);
  }
});

test('repricing renders the same manual resolution control on later manual-price cycles', () => {
  const source = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /\['price_missing', 'manual_price'\]\.includes/);
  assert.match(source, /Залишити ручну ціну/);
  assert.match(source, /keepCurrentManualPrice\(\s*item\.productId,\s*item\.oldPriceUah\s*\)/);
  assert.match(source, /Застосувати автоматичну ціну/);
  assert.match(source, /disabled=\{!canApply\}/);
});

test('repricing exposes a server-authoritative global catalog workflow', () => {
  const source = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /Переоцінити все/);
  assert.match(source, /\/admin\/repricing\/global\/preview/);
  assert.match(source, /\/admin\/repricing\/global\/apply/);
  assert.match(source, /scenarioFilter/);
  assert.match(source, /Залишити поточні ручні ціни для всіх/);
  assert.match(source, /Застосувати автоматичну ціну/);
  assert.match(source, /keepCurrentManualPrices/);
  assert.doesNotMatch(source, /Promise\.all\([^)]*\/admin\/repricing\/preview/);
});

test('fixed-scale API decimals are compacted in editable pricing fields', () => {
  const matrixSource = fs.readFileSync(
    new URL('../src/components/admin/AdminPricingEditor.jsx', import.meta.url),
    'utf8'
  );
  const adminHookSource = fs.readFileSync(
    new URL('../src/hooks/useAdminPanel.js', import.meta.url),
    'utf8'
  );
  const adminPricingStateSource = fs.readFileSync(
    new URL('../src/lib/admin-pricing-state.js', import.meta.url),
    'utf8'
  );
  const repricingSource = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(matrixSource, /defaultValue=\{cell \? formatDecimal\(cell\.price\) : ''\}/);
  assert.match(adminHookSource, /factor: formatDecimal\(modifier\.factor\)/);
  assert.match(adminPricingStateSource, /min_weight: formatDecimal\(band\.min_weight\)/);
  assert.match(repricingSource, /formatDecimal\(item\.newPriceUah\)/);
});

test('pricing views expose calculated and authoritative final UAH values', () => {
  const dashboardSource = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );
  const builderSource = fs.readFileSync(
    new URL('../src/components/app/ProductBuilder.jsx', import.meta.url),
    'utf8'
  );
  const skuManagerSource = fs.readFileSync(
    new URL('../src/hooks/useSkuManager.js', import.meta.url),
    'utf8'
  );
  assert.match(dashboardSource, /pricing\?\.calculatedPriceUah/);
  assert.match(dashboardSource, /const finalStoredPriceUah = decodeData\.existsInDb \? pricing\?\.totalPriceUah : null/);
  assert.match(builderSource, /displayedPricing\?\.calculatedPriceUah/);
  assert.match(skuManagerSource, /previewData\?\.totalPriceUah/);
  assert.match(builderSource, /displayedPricing\?\.pricePerGramUah/);
  assert.match(builderSource, /displayedPricing\?\.pricePerGram/);
  assert.match(dashboardSource, /Розраховано до округлення/);
});

test('product builder uses compact ordered rows and keeps operational status in the summary', () => {
  const builderSource = fs.readFileSync(
    new URL('../src/components/app/ProductBuilder.jsx', import.meta.url),
    'utf8'
  );
  const appSource = fs.readFileSync(
    new URL('../src/pages/AppPage.jsx', import.meta.url),
    'utf8'
  );
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );

  assert.match(builderSource, /visibleQuestions\.map\(\(question\)/);
  assert.match(builderSource, /builder-field-row/);
  assert.match(builderSource, /className="required-marker"/);
  assert.match(builderSource, /className="builder-blockers"/);
  assert.match(builderSource, /label="Розрахункова"/);
  assert.match(builderSource, /label="Фінальна"/);
  assert.match(builderSource, /Змінити ціну/);
  assert.match(builderSource, /label="SKU"/);
  assert.match(builderSource, /verificationAttempt > 0/);
  assert.match(builderSource, /validationVisible \? fieldBlockers : \[\]/);
  assert.match(builderSource, /Не перевірено/);
  assert.match(builderSource, /Потрібна увага/);
  assert.match(builderSource, /data-builder-blocker/);
  assert.match(builderSource, /scrollIntoView/);
  assert.doesNotMatch(builderSource, /Крок 1/);
  assert.doesNotMatch(builderSource, /Поля показуються за чинною конфігурацією/);
  assert.doesNotMatch(builderSource, /className="field-group"/);
  assert.doesNotMatch(appSource, /PreviewResult/);
  assert.match(appSource, /\{sku\.selectedCat && \(/);
  assert.doesNotMatch(stylesSource, /builder-field-row:focus-within/);
  assert.match(builderSource, /getFinalPriceUsd\(displayedFinalPriceUah, displayedPricing\.uahRate\)/);
});

test('product builder live pricing refreshes after answer and weight edits without unlocking save', () => {
  const builderSource = fs.readFileSync(
    new URL('../src/components/app/ProductBuilder.jsx', import.meta.url),
    'utf8'
  );
  const skuManagerSource = fs.readFileSync(
    new URL('../src/hooks/useSkuManager.js', import.meta.url),
    'utf8'
  );
  const appSource = fs.readFileSync(
    new URL('../src/pages/AppPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(skuManagerSource, /api\.post\('\/price-preview'/);
  assert.match(
    skuManagerSource,
    /\[selectedCat, config, answers, weight, isCalibrated, isWeightRequired\]/,
    'live pricing must react to both answer and weight changes'
  );
  assert.match(skuManagerSource, /const handleAnswer[\s\S]*?beginLivePriceRefresh\(\);/);
  assert.match(skuManagerSource, /const handleWeightChange[\s\S]*?beginLivePriceRefresh\(\);/);
  assert.match(appSource, /livePriceData=\{sku\.livePriceData\}/);
  assert.match(
    builderSource,
    /const displayedPricing = previewData \|\| \(fieldBlockers\.length === 0 \? livePriceData : null\)/
  );
  assert.match(builderSource, /displayedPricing\?\.totalPriceUah/);
  assert.match(builderSource, /const isVerified = Boolean\(previewData\)/);
  assert.match(builderSource, /\{isVerified \? \(/);
  assert.match(builderSource, /verificationAttempt > 0 && !isVerified/);
  assert.match(builderSource, /validationVisible \? fieldBlockers : \[\]/);
});

test('product, decode, and normal preview pre-rounded UAH labels use whole-hryvnia formatting', () => {
  const sources = [
    '../src/components/app/HomeDashboard.jsx',
    '../src/components/app/ProductBuilder.jsx',
  ].map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
  const recountConfirmSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );

  for (const source of sources) {
    assert.doesNotMatch(source, /округлення: \{formatUah\(/i);
  }
  assert.ok(
    sources.every((source) => /formatWholeUah/.test(source)),
    'every product/decode pre-rounded price view must use the whole-UAH formatter'
  );
  assert.doesNotMatch(recountConfirmSource, /До округлення/);
  assert.doesNotMatch(recountConfirmSource, /formatWholeUah/);
});

test('decode result keeps authoritative pricing drivers highlighted in a compact operational workspace', () => {
  const source = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );
  const decodeSource = source.slice(
    source.indexOf('export function DecodeWorkspace'),
    source.indexOf('function RecountPanel')
  );

  assert.match(decodeSource, /decodeData\.pricing\?\.dependentKeys\?\.includes\(item\.key\)/);
  assert.match(decodeSource, /decode-field-row builder-field-row/);
  assert.match(decodeSource, /isPriceDriver \? 'is-price-driver' : ''/);
  assert.match(decodeSource, /Впливає на ціну/);
  assert.match(decodeSource, /decode-readonly-value/);
  assert.match(decodeSource, /builder-summary/);
  assert.match(decodeSource, /sticky-summary-container/);
  assert.match(decodeSource, /label="SKU"/);
  assert.match(decodeSource, /Стан у базі/);
  assert.match(decodeSource, /Розраховано до округлення/);
  assert.match(decodeSource, /Фінальна збережена/);
  assert.doesNotMatch(decodeSource, /decode-rounding-note/);
  assert.doesNotMatch(decodeSource, /formatWholeUah\(calculatedPriceUah\)\s*→/);
  assert.match(decodeSource, /Розрахункова ціна за грам/);
  assert.match(decodeSource, /label="Матриця"/);
  assert.match(decodeSource, /label="Вага"/);
  assert.match(decodeSource, /<details className="decode-details">/);
  assert.match(decodeSource, /Деталі розрахунку/);
  assert.ok(
    decodeSource.indexOf('Деталі розрахунку') < decodeSource.indexOf('item.value_id'),
    'internal option values must remain inside calculation details'
  );
  assert.match(decodeSource, /const pricing = decodeData\.pricing/);
  assert.doesNotMatch(decodeSource, /api\.(get|post|put|delete)/);
});

test('home and decode presentation share aligned columns and compact authoritative final pricing', () => {
  const homeSource = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );
  const headerSource = fs.readFileSync(
    new URL('../src/components/app/PageHeader.jsx', import.meta.url),
    'utf8'
  );
  const navSource = fs.readFileSync(
    new URL('../src/components/app/WorkspaceNav.jsx', import.meta.url),
    'utf8'
  );
  const builderSource = fs.readFileSync(
    new URL('../src/components/app/ProductBuilder.jsx', import.meta.url),
    'utf8'
  );
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );

  assert.match(homeSource, /home-top-workspace/);
  assert.match(homeSource, /home-side-workspace/);
  assert.match(homeSource, /decode-result-workspace/);
  assert.equal((homeSource.match(/operational-split-layout/g) || []).length, 2, 'decode and recount must share the operational split');
  assert.match(builderSource, /className="operational-split-layout"/);
  assert.match(stylesSource, /\.home-top-workspace,[\s\S]*?\.operational-split-layout[\s\S]*?360px/);
  assert.match(homeSource, /const finalStoredPriceUsd = decodeData\.existsInDb \? pricing\?\.totalPrice : null/);
  assert.match(homeSource, /formatOptionalValue\(finalStoredPriceUsd, formatUsd\)/);
  assert.doesNotMatch(homeSource, /decode-rounding-note/);
  assert.doesNotMatch(homeSource, /formatWholeUah\(calculatedPriceUah\)\s*→/);
  assert.doesNotMatch(homeSource, /Округлення:/);
  assert.doesNotMatch(homeSource, /formatSignedRoundedUah/);
  assert.doesNotMatch(headerSource, /Операційна консоль|останніх записів|категорій/);
  assert.match(navSource, /amber-logo-white-orange\.png/);
  assert.match(navSource, /<img src=\{amberLogo\}/);
  assert.doesNotMatch(navSource, /workspace-brand-mark|workspace-brand-copy/);
  assert.match(stylesSource, /--workspace-nav-height: 70px/);
  assert.match(stylesSource, /\.workspace-brand-logo \{ @apply block h-9 w-auto sm:h-12; \}/);
});

test('recount uses a Builder-aligned editor with one authoritative comparison summary', () => {
  const source = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );
  const stylesSource = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );
  const recountSource = source.slice(source.indexOf('function RecountPanel'));

  assert.match(recountSource, /builder-workspace/);
  assert.match(recountSource, /builder-field-list/);
  assert.match(recountSource, /builder-field-row/);
  assert.match(recountSource, /sticky-summary-container/);
  assert.match(recountSource, /recount-comparison-header/);
  assert.match(recountSource, /Зараз/);
  assert.match(recountSource, /Після/);
  assert.match(
    recountSource,
    /label="SKU"[\s\S]*label="Ціна виробу"[\s\S]*label="Ціна за грам"[\s\S]*label="Матриця"[\s\S]*className="recount-comparison-difference"[\s\S]*Різниця в ціні/
  );
  assert.doesNotMatch(recountSource, /label="Джерело"/);
  assert.match(recountSource, /Різниця в ціні/);
  assert.match(recountSource, /Змінені атрибути/);
  assert.match(recountSource, /isChanged \? 'is-changed' : ''/);
  assert.match(recountSource, /getAnswerValueLabel[\s\S]*?→[\s\S]*?getAnswerValueLabel/);
  assert.doesNotMatch(recountSource, /PreviousPricingSnapshot/);
  assert.doesNotMatch(recountSource, /Початкові цінові параметри/);
  assert.doesNotMatch(recountSource, /pricing\.weight/);
  assert.doesNotMatch(recountSource, /className="chip"/);
  assert.match(recountSource, /formatOptionalValue\(usd, formatRecountUsd\)/);
  assert.match(recountSource, /\$\{amount\.toFixed\(2\)\}/);
  assert.match(recountSource, /Math\.abs\(amount\)\.toFixed\(2\)/);
  assert.match(recountSource, /className="recount-money-usd"/);
  assert.match(recountSource, /className="recount-price-delta-usd"/);
  assert.match(stylesSource, /\.recount-money-value > \.recount-money-usd \{ @apply mt-1 text-xs font-semibold text-slate-500; \}/);
  assert.match(stylesSource, /\.recount-price-delta > \.recount-price-delta-usd \{[\s\S]*text-sm font-semibold text-\[#713b10\]/);
});

test('catalog structure uses category tabs and a dense question master-detail workspace', () => {
  const source = fs.readFileSync(
    new URL('../src/components/admin/AdminStructureEditor.jsx', import.meta.url),
    'utf8'
  );
  const templateSource = fs.readFileSync(
    new URL('../src/components/admin/SkuTemplatePreview.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /role="tablist"/);
  assert.match(source, /catalog-category-tab/);
  assert.match(source, /catalog-workspace/);
  assert.match(source, /catalog-master/);
  assert.match(source, /catalog-detail/);
  assert.match(source, /currentCatQuestions\.map\(\(question\)/);
  assert.match(source, /draggable/);
  assert.match(source, /reorderQuestions\(nextQuestions\)/);
  assert.match(source, /Обовʼязкове/);
  assert.match(source, /За умовою/);
  assert.match(source, /Видимість та умови/);
  assert.match(source, /Архівні варіанти/);
  assert.match(source, /isArchivedOptionsOpen/);
  assert.match(source, /publishSkuSchema/);
  assert.ok(
    source.indexOf('<SkuTemplatePreview') < source.indexOf('<section className="catalog-workspace">'),
    'the SKU template must stay in category context above the question workspace'
  );
  assert.match(templateSource, /catalog-sku-template-details/);
  assert.doesNotMatch(source, /xl:grid-cols-3/);
  assert.doesNotMatch(source, /1\. Категорії|2\. Питання|3\. Варіанти/);
});

test('pricing uses selected scenario and modifier master-detail editors', () => {
  const source = fs.readFileSync(
    new URL('../src/components/admin/AdminPricingEditor.jsx', import.meta.url),
    'utf8'
  );
  const styles = fs.readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8'
  );

  assert.match(source, /pricing-workspace/);
  assert.match(source, /pricing-master/);
  assert.match(source, /pricing-detail/);
  assert.match(source, /scenarioQuery/);
  assert.match(source, /scenarioStatusFilter/);
  assert.match(source, /groupScenarios\(filteredScenarios\)/);
  assert.match(source, /scenario=\{selectedScenario\}/);
  assert.match(source, />Матриця</);
  assert.match(source, />Налаштування</);
  assert.match(source, /isNewScenario/);
  assert.match(source, /duplicateScenario\(selectedScenario\.id\)/);
  assert.match(source, /workspaceMode === 'modifiers'/);
  assert.match(source, /selectedModifier/);
  assert.match(source, /isNewModifier/);
  assert.match(source, /handlePriceChange\(scenario\.id, xOption\.id, yOption\.id, null\)/);
  assert.match(source, /getMatrixPriceValidationError\(normalizedPrice\)/);
  assert.match(source, /role="alert"/);
  assert.match(styles, /\.pricing-matrix-table thead th[\s\S]*?sticky top-0/);
  assert.match(styles, /\.pricing-matrix-table tbody th[\s\S]*?sticky left-0/);
  assert.doesNotMatch(source, /space-y-6 border-t border-slate-200 p-4/);
  assert.doesNotMatch(source, /Модифікатори \(Знижки \/ Націнки\)/);
});

test('correction queue wires exclusive browser claims and shared polling into the UI', () => {
  const source = fs.readFileSync(
    new URL('../src/pages/CorrectionRequestsPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /createVisibilityAwarePoller/);
  assert.match(source, /createLatestRequestGate/);
  assert.match(source, /Робоча область/);
  assert.match(source, /nextFilter === 'workspace' \? 'active'/);
  assert.match(source, /getCorrectionRequestsForView/);
  assert.match(source, /isCorrectionClaimConflict/);
  assert.match(source, /\/correction-requests\/\$\{request\.id\}\/claim/);
  assert.match(source, /X-Correction-Claim-Token/);
  assert.match(source, /В роботі у вас/);
  assert.match(source, /В роботі в іншому браузері/);
  assert.doesNotMatch(source, /В роботі іншим працівником/);
  assert.match(source, /Примусово повернути/);
  assert.match(source, /window\.confirm/);
});
