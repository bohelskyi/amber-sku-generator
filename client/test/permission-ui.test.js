import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getPermissionUiState, getRecountUiMode } from '../src/lib/permission-ui.js';

const commonPermissions = [
  'products.view',
  'products.decode',
  'history.view',
  'corrections.view',
  'corrections.create',
  'corrections.reject',
  'repricing.view',
  'repricing.prepare',
  'exports.view',
];

test('Manager UI is monitoring/request-oriented with read-only pricing', () => {
  const ui = getPermissionUiState([...commonPermissions, 'pricing.view']);

  assert.equal(ui.canViewPricing, true);
  assert.equal(ui.canManagePricing, false);
  assert.equal(ui.canCreateProducts, false);
  assert.equal(ui.canArchiveProducts, false);
  assert.equal(ui.canApplyDirectRecount, false);
  assert.equal(ui.canCreateExports, false);
  assert.equal(ui.canClaimCorrections, false);
  assert.equal(ui.canCompleteCorrections, false);
  assert.equal(ui.canForceReleaseCorrections, false);
  assert.equal(ui.canRejectCorrections, true);
  assert.equal(ui.canApplyRepricing, false);
  assert.equal(ui.canRollbackRepricing, false);
  assert.equal(getRecountUiMode(ui), 'request');
});

test('Storekeeper UI keeps product and correction processing but hides final administrative actions', () => {
  const ui = getPermissionUiState([
    ...commonPermissions,
    'products.create',
    'products.archive',
    'products.recount',
    'corrections.claim',
    'corrections.complete',
  ]);

  assert.equal(ui.canCreateProducts, true);
  assert.equal(ui.canArchiveProducts, true);
  assert.equal(ui.canApplyDirectRecount, true);
  assert.equal(ui.canClaimCorrections, true);
  assert.equal(ui.canCompleteCorrections, true);
  assert.equal(ui.canRejectCorrections, true);
  assert.equal(ui.canViewCatalog, false);
  assert.equal(ui.canViewPricing, false);
  assert.equal(ui.canCreateExports, false);
  assert.equal(ui.canForceReleaseCorrections, false);
  assert.equal(ui.canApplyRepricing, false);
  assert.equal(ui.canRollbackRepricing, false);
  assert.equal(getRecountUiMode(ui), 'choice');
});

test('Administrator effective permissions expose every guarded UI action', () => {
  const ui = getPermissionUiState([
    'catalog.view',
    'pricing.view',
    'pricing.manage',
    'products.create',
    'products.archive',
    'products.recount',
    'corrections.create',
    'corrections.claim',
    'corrections.complete',
    'corrections.reject',
    'corrections.force_release',
    'repricing.apply',
    'repricing.rollback',
    'exports.create',
  ]);

  assert.equal(Object.values(ui).every(Boolean), true);
  assert.equal(getRecountUiMode(ui), 'choice');
});

test('correction mutation controls are wired to effective permission flags', () => {
  const correctionSource = fs.readFileSync(
    new URL('../src/pages/CorrectionRequestsPage.jsx', import.meta.url),
    'utf8'
  );

  assert.match(correctionSource, /request\.status === 'pending'[\s\S]*?&& canClaim/);
  assert.match(correctionSource, /request\.status === 'in_progress' && !isOwnedClaim && canForceRelease/);
  assert.match(correctionSource, /canComplete && <button[\s\S]*?openCompletion/);
  assert.match(correctionSource, /request\.status === 'pending' && canReject/);
});
