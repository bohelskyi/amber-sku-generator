import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildScenarioEditorDraft,
  findScenarioById,
  getScenarioMatrixCellKey,
} from '../src/lib/admin-pricing-state.js';

const editorSource = fs.readFileSync(
  new URL('../src/components/admin/AdminPricingEditor.jsx', import.meta.url),
  'utf8'
);
const pricingFormsSource = fs.readFileSync(
  new URL('../src/components/admin/AdminPricingForms.jsx', import.meta.url),
  'utf8'
);
const hookSource = fs.readFileSync(
  new URL('../src/hooks/admin/useAdminPricingController.js', import.meta.url),
  'utf8'
);

test('same-group scenarios use independent matrix cell identities', () => {
  const scenarioA = { id: 11, group_name: 'Natural', axis_x_key: 'quality', axis_y_key: 'size' };
  const scenarioB = { id: 12, group_name: 'Natural', axis_x_key: 'quality', axis_y_key: 'size' };

  assert.notEqual(
    getScenarioMatrixCellKey(scenarioA.id, 1, 2, '100.0000'),
    getScenarioMatrixCellKey(scenarioB.id, 1, 2, '100.0000')
  );
  assert.match(
    pricingFormsSource,
    /key=\{getScenarioMatrixCellKey\(scenario\.id, xOption\.id, yOption\.id, cell\?\.price\)\}/
  );
});

test('a refreshed persisted value replaces the stale matrix cell identity', () => {
  assert.notEqual(
    getScenarioMatrixCellKey(11, 1, 2, '100.0000'),
    getScenarioMatrixCellKey(11, 1, 2, '125.0000')
  );
  assert.match(
    hookSource,
    /api\.post\('\/admin\/price-cell',[\s\S]*?\.then\(\(\) => fetchPricesForCategory\(categoryCode\)\)/
  );
});

test('scenario settings save keeps the refreshed scenario selected and editable', () => {
  const refreshedPrices = {
    scenarios: [
      { id: 12, name: 'Other' },
      {
        id: 11,
        name: 'Saved scenario',
        group_name: 'Moved group',
        match_json: { quality: 2 },
        axis_x_key: 'quality',
        axis_y_key: 'size',
        priority: 7,
        status: 'active',
        price_mode: 'fixed_uah',
        apply_modifiers: true,
        weight_bands: [],
      },
    ],
  };
  const savedScenario = findScenarioById(refreshedPrices, 11);
  const editorDraft = buildScenarioEditorDraft(savedScenario);

  assert.equal(savedScenario.name, 'Saved scenario');
  assert.equal(editorDraft.id, 11);
  assert.equal(editorDraft.group_name, 'Moved group');
  assert.equal(editorDraft.match_json, '{"quality":2}');
  assert.match(editorSource, /onSave=\{saveScenarioSettings\}/);
  assert.match(
    editorSource,
    /setScenarioSelection\(\{ categoryCode: selectedCat\.code, id: savedScenario\.id \}\)/
  );
  assert.doesNotMatch(
    hookSource,
    /api\.put\('\/admin\/scenario',[\s\S]*?\.then\(\(\) => \{\s*setEditScenario\(null\)/
  );
});
