'use strict';
// Records the existing reviewed broader_resync handoff; never runs the worker.
const path = require('node:path');
const { createCommand, readJson, fail } = require('./operator-cli');
const scope = require('./operator-scope');
const c = require('../src/services/magento/binding-contract');
const MAX_SCOPE_FILES = 100;
const MAX_SCOPE_BYTES = 1024 * 1024;

function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 2000
    || /[\u0000-\u001f\u007f]/.test(value)) fail('CONTROLLED_RESYNC_INPUT_INVALID');
  return value;
}

async function readItems(input, inputFile) {
  c.command(input, ['reason'], ['items', 'scopeFiles']);
  reason(input.reason);
  if (Object.hasOwn(input, 'items') === Object.hasOwn(input, 'scopeFiles')) fail('CONTROLLED_RESYNC_INPUT_INVALID');
  if (Object.hasOwn(input, 'items')) return scope.validateItems(input.items);
  if (!Array.isArray(input.scopeFiles) || !input.scopeFiles.length || input.scopeFiles.length > MAX_SCOPE_FILES
    || Object.keys(input.scopeFiles).length !== input.scopeFiles.length
    || input.scopeFiles.some(file => typeof file !== 'string' || !file.trim() || file.length > 4096
      || /[\u0000-\u001f\u007f]/.test(file))) fail('CONTROLLED_RESYNC_INPUT_INVALID');
  const directory = path.dirname(path.resolve(inputFile));
  const files = input.scopeFiles.map(file => path.resolve(directory, file));
  if (new Set(files).size !== files.length) fail('CONTROLLED_RESYNC_DUPLICATE_SCOPE_FILE');
  const items = [];
  for (const file of files) {
    const saved = await readJson(file, MAX_SCOPE_BYTES);
    if (!saved || Object.getPrototypeOf(saved) !== Object.prototype || !Array.isArray(saved.items)) fail('CONTROLLED_RESYNC_SCOPE_INVALID');
    const selected = saved.items.map(item => {
      // Historical admission scope files may also carry remoteProductId.
      c.command(item, ['sku', 'productId'], ['remoteProductId']);
      if (item.remoteProductId !== undefined && (!Number.isSafeInteger(item.remoteProductId) || item.remoteProductId <= 0))
        fail('CONTROLLED_RESYNC_SCOPE_INVALID');
      return { sku: item.sku, productId: item.productId };
    });
    scope.validateItems(selected);
    items.push(...selected);
    scope.validateItems(items);
  }
  return scope.validateItems(items);
}

function validatePlan(payload) {
  c.command(payload, ['items', 'command', 'blockers']);
  const items = scope.validateItems(payload.items), command = payload.command;
  c.command(command, ['bindingRevisionId', 'expectedRevision', 'kind', 'productIds', 'reason', 'previewToken']);
  c.identity(command.bindingRevisionId);
  if (typeof command.expectedRevision !== 'string' || c.counter(command.expectedRevision) !== command.expectedRevision
    || command.kind !== 'broader_resync' || !/^[a-f0-9]{64}$/.test(command.previewToken || '')) fail('CONTROLLED_RESYNC_PLAN_INVALID');
  reason(command.reason);
  const ids = items.map(item => item.productId).sort((a, b) => a - b);
  if (!Array.isArray(command.productIds) || command.productIds.length !== ids.length
    || command.productIds.some((id, index) => id !== ids[index])) fail('CONTROLLED_RESYNC_PLAN_INVALID');
  if (!Array.isArray(payload.blockers) || payload.blockers.length > 1000) fail('CONTROLLED_RESYNC_PLAN_INVALID');
  for (const blocker of payload.blockers) {
    c.command(blocker, ['productId', 'code']);
    if (!ids.includes(blocker.productId) || typeof blocker.code !== 'string'
      || !/^[A-Z][A-Z0-9_]{0,159}$/.test(blocker.code)) fail('CONTROLLED_RESYNC_PLAN_INVALID');
  }
}

async function preview(input, context) {
  const editor = require('../src/services/magento/integration-editor.service');
  const controlled = require('../src/services/magento/binding-controlled-actions');
  const items = await scope.assertItems(context.databasePool, await readItems(input, context.inputFile));
  const binding = await editor.read(context.options, client => editor.selected(client, context.config));
  if (!binding || binding.state !== 'published') fail('CONTROLLED_RESYNC_NO_CURRENT_BINDING');
  const request = { bindingRevisionId: binding.id, expectedRevision: binding.revision, kind: 'broader_resync',
    productIds: items.map(item => item.productId).sort((a, b) => a - b), reason: input.reason };
  context.checkStopped();
  const report = await controlled.preview(context.config, request, context.options);
  if (!Array.isArray(report.products) || !Array.isArray(report.blockers)
    || new Set(report.products.map(product => product.productId)).size !== report.products.length
    || report.products.some(product => !items.some(item => item.productId === product.productId && item.sku === product.article))
    || (!report.blockers.length && report.products.length !== items.length)) fail('CONTROLLED_RESYNC_SCOPE_CHANGED');
  const payload = { items, command: { ...request, previewToken: report.previewToken }, blockers: report.blockers };
  validatePlan(payload);
  return payload;
}

async function apply(payload, context, journal) {
  validatePlan(payload);
  if (payload.blockers.length) fail('CONTROLLED_RESYNC_BLOCKED');
  await scope.assertItems(context.databasePool, payload.items);
  await context.authority();
  context.checkStopped();
  await journal.append({ type: 'prepared', stage: 'broader_resync', items: payload.items, command: payload.command });
  context.checkStopped();
  const result = await require('../src/services/magento/binding-controlled-actions').apply(context.config, payload.command, context.options);
  await journal.append({ type: 'receipt', stage: 'broader_resync', ...result });
  return result;
}

const command = createCommand({ name: 'controlled-resync',
  permissions: ['export_templates.manage', 'export_templates.publish', 'exports.view'], requiresMagento: true,
  preview, apply, validatePlan,
  help: 'Input: {"reason":"Reviewed resync","items":[{"sku":"AG-000003","productId":3}]} '
    + 'or {"reason":"Reviewed resync","scopeFiles":["scope.json"]}. Paths are relative to the input file; '
    + 'at most 100 files (1 MiB each), 100 distinct current products total. Apply uses the saved binding, reason, '
    + 'scope and preview token exactly. It records a local handoff; the normal worker delivers separately.' });

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  command.main().then(code => { process.exitCode = code; });
}

module.exports = { ...command, readItems, preview, apply, validatePlan };
