const { test } = require('node:test');
const assert = require('node:assert/strict');
const { structureReport, check } = require('../src/services/magento/integration-structure-check');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const editor = require('../src/services/magento/integration-editor.service');

function fixture() {
  const schema = normalizeSchema({ storeCode: 'all', storeTopology: { websites: [], storeGroups: [], storeViews: [] },
    attributeSets: [{ attribute_set_id: 7, attribute_set_name: 'Bracelets', attributeCodes: ['color'] }],
    attributes: [{ attribute_id: 8, attribute_code: 'color', default_frontend_label: 'Колір', frontend_input: 'select',
      options: [{ value: '9', label: 'Медовий' }] }] });
  const revision = { id: 'published', revision: '1', schema, schemaFingerprint: hash(schema), topologyFingerprint: hash(schema.storeTopology),
    bindings: { routes: [{ routeKey: 'BR:all', setId: 7, enabled: true, reviewState: 'approved' }],
      attributes: [{ bindingKey: 'color', routeKey: 'BR:all', target: 'color', attributeCode: 'color', reviewState: 'approved', evidence: {} }],
      options: [{ bindingKey: 'color', optionId: '9', reviewState: 'approved' }] } };
  return { revision, observation: { observedAt: '2026-10-04T10:00:00Z', schema: structuredClone(schema), categories: [] } };
}
test('fresh structure evidence is scoped and never asserts product delivery', () => {
  const { revision, observation } = fixture(); const result = structureReport(revision, observation);
  assert.equal(result.state, 'checked'); assert.equal(result.productChecks, 0); assert.equal(result.routesChecked, 1);
  assert.equal(structureReport(null, observation).state, 'unavailable');
});
test('exact missing option names its category and attribute while refused future values do not become failures', () => {
  const { revision, observation } = fixture();
  revision.bindings.options.push({ bindingKey: 'color', optionId: 'future', reviewState: 'blocked' });
  observation.schema.attributes[0].options = [];
  const result = structureReport(revision, observation);
  assert.equal(result.state, 'needs_review'); assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, 'OPTION_ID_MISSING'); assert.equal(result.findings[0].categoryCode, 'BR');
  assert.equal(result.findings[0].label, 'Колір');
});
test('category identity and full path must both match the approved placement', () => {
  const { revision, observation } = fixture();
  revision.bindings.attributes[0].evidence.categories = [{ categoryId: '42', normalizedPath: 'Store/Bracelets', reviewState: 'approved' }];
  observation.categories = [{ categoryId: '42', normalizedPath: 'Store/Other', comparable: true }];
  assert.equal(structureReport(revision, observation).findings[0].code, 'CATEGORY_PATH_CHANGED');
});
test('source metadata and new required set members cannot be reported as clean', () => {
  const { revision, observation } = fixture();
  observation.schema.attributes[0].source_model = 'CustomSource';
  assert.equal(structureReport(revision, observation).findings[0].code, 'ATTRIBUTE_METADATA_CHANGED');
  const added = fixture();
  added.observation.schema.attributeSets[0].attributeCodes.push('required_text');
  added.observation.schema.attributes.push({ attribute_id: 15, attribute_code: 'required_text', frontend_input: 'text', is_required: true, options: [] });
  assert.equal(structureReport(added.revision, added.observation).findings[0].code, 'REQUIRED_ATTRIBUTE_ADDED');
  added.revision.bindings.routes[0].enabled = false;
  assert.equal(structureReport(added.revision, added.observation).state, 'unavailable');
});
test('publication change during remote GETs invalidates result and every local read finishes first', async () => {
  const { revision, observation } = fixture(); const original = { read: editor.read, selected: editor.selected, discovery: editor.discovery };
  let transaction = false, reads = 0;
  editor.read = async (_options, fn) => { transaction = true; try { return await fn({}); } finally { transaction = false; } };
  editor.selected = async () => ++reads === 1 ? revision : { ...revision, id: 'changed' };
  editor.discovery = async () => { assert.equal(transaction, false); return observation; };
  try { assert.equal((await check({})).comparison.state, 'stale'); assert.equal(reads, 2); }
  finally { Object.assign(editor, original); }
});
