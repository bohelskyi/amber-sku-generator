'use strict';
// Both modes are database read-only. Apply writes a new reviewed scope artifact.
const path = require('node:path');
const { createCommand, fail } = require('./operator-cli');
const scope = require('./operator-scope');

function validatePlan(payload) {
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype
    || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'items')) fail('OPERATOR_SCOPE_INVALID');
  scope.validateItems(payload.items);
}

async function preview(input, context) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'skus')) fail('OPERATOR_SCOPE_INVALID');
  return { items: await scope.resolveSkus(context.databasePool, input.skus) };
}

async function apply(payload, context) {
  validatePlan(payload);
  return { items: await scope.assertItems(context.databasePool, payload.items) };
}

const command = createCommand({ name: 'scope-from-skus', permissions: ['export_templates.view'], requiresMagento: false,
  readOnlyApply: true, artifactApply: true, preview, apply, validatePlan,
  help: 'Input: {"skus":["AG-000003"]}, 1..100 exact public articles. Preview reviews current product IDs; '
    + 'apply rechecks the reviewed IDs and creates a new {items,journal} scope file. No database or Magento writes.' });

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  command.main().then(code => { process.exitCode = code; });
}

module.exports = { ...command, preview, apply, validatePlan };
