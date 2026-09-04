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

test('correction dialog only applies initial focus when it opens', () => {
  const dialogSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );
  const focusCalls = dialogSource.match(/confirmButtonRef\.current\?\.focus\(\)/g) || [];

  assert.equal(focusCalls.length, 1, 'the dialog must not refocus after input state changes');
  assert.match(
    dialogSource,
    /if \(isOpen\) confirmButtonRef\.current\?\.focus\(\);\s*}, \[isOpen\]\);/,
    'initial focus must depend only on the dialog opening'
  );
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
  const repricingSource = fs.readFileSync(
    new URL('../src/pages/RepricingPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(matrixSource, /defaultValue=\{cell \? formatDecimal\(cell\.price\) : ''\}/);
  assert.match(adminHookSource, /factor: formatDecimal\(modifier\.factor\)/);
  assert.match(adminHookSource, /min_weight: formatDecimal\(band\.min_weight\)/);
  assert.match(repricingSource, /formatDecimal\(item\.newPriceUah\)/);
});

test('automatic pricing views expose calculated and final marketing-rounded UAH values', () => {
  const dashboardSource = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );
  const previewSource = fs.readFileSync(
    new URL('../src/components/app/PreviewResult.jsx', import.meta.url),
    'utf8'
  );
  const recountSource = fs.readFileSync(
    new URL('../src/components/app/RecountConfirmDialog.jsx', import.meta.url),
    'utf8'
  );

  assert.match(dashboardSource, /pricing\.calculatedPriceUah/);
  assert.match(dashboardSource, /pricing\.automaticPriceUah/);
  assert.match(previewSource, /previewData\.calculatedPriceUah/);
  assert.match(recountSource, /preview\.corrected\.autoPriceUah/);
  assert.match(dashboardSource, /Розраховано до округлення/);
});
