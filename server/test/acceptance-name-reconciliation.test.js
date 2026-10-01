const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileNames } = require('../src/services/magento/name-reconciliation');
const pair = (name) => ({ all: name, en: `EN ${name}` });
test('shared name authority uses the last confirmed common values, never timestamps', () => {
  const baseline = pair('Original');
  assert.equal(reconcileNames(baseline, baseline, pair('External')).action, 'accept_external');
  assert.equal(reconcileNames(baseline, pair('Amber'), baseline).action, 'send_amber');
  assert.equal(reconcileNames(baseline, pair('Same'), pair('Same')).action, 'confirm');
  assert.equal(reconcileNames(baseline, pair('Amber'), pair('External')).action, 'conflict');
});
test('unknown common state does not authorize overwriting an existing remote name', () => {
  assert.equal(reconcileNames(null, pair('Amber'), pair('External')).action, 'baseline_required');
  assert.equal(reconcileNames(null, pair('Same'), pair('Same')).action, 'confirm');
});
test('explicit Amber conflict resolution is bound to both reviewed sides', () => {
  const amber = pair('Amber'); const remote = pair('External');
  const resolution = { amber, remote };
  assert.equal(reconcileNames(pair('Original'), amber, remote, resolution).action, 'send_amber');
  assert.equal(reconcileNames(pair('Original'), amber, pair('Later remote'), resolution).action, 'conflict');
});
