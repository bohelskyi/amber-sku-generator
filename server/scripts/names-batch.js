'use strict';
// The ordinary UI shared-name choice; this is not missing-name completion.
const path = require('node:path');
const { createCommand, fail, readJson, readJsonLines } = require('./operator-cli');
const scope = require('./operator-scope');
const { same } = require('../src/services/magento/name-reconciliation');

const MAX_ITEMS = 50;
const HELP = 'node scripts/names-batch.js --mode preview|apply --input FILE --output NEWFILE '
  + '--expected-database NAME --actor-id ID [--plan-hash SHA256]\n'
  + 'Preview: {"items":[{"sku":"AG-000001","productId":1}]} or recover-skus preview/legacy JSONL '
  + '(only blocked DURABLE_REMOTE_ID_REQUIRED rows). Apply consumes the saved names preview. Maximum 50 products; Magento GET only.';
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const codeOf = error => /^[A-Z][A-Z0-9_]{0,159}$/.test(error?.code || '') ? error.code : 'NAMES_BATCH_FAILED';
const globalFailure = error => /PERMISSION|ADMIN|AUTHORI|ACTOR|DATABASE|INTERRUPT|STOPPED|REMOTE_WRITE|GET_ONLY/.test(codeOf(error));

function parsePreviewInput(input, { jsonLines = false } = {}) {
  if (!jsonLines && keys(input, ['items'])) {
    scope.validateItems(input.items, { limit: MAX_ITEMS });
    return { items: input.items.map(({ sku, productId }) => ({ sku, productId })) };
  }
  let rows;
  if (jsonLines) {
    if (!Array.isArray(input)) fail('NAMES_BATCH_INPUT_INVALID');
    rows = input.filter(row => row?.kind !== 'summary');
  } else if (input?.contract === 'amber-operator-review-v1' && input.command === 'recover-skus') {
    rows = require('./recover-skus').validatePlan(input.payload).items;
  } else fail('NAMES_BATCH_INPUT_INVALID');
  if (rows.some(row => !plain(row) || typeof row.status !== 'string'
    || row.status === 'blocked' && (!Array.isArray(row.blockers) || row.blockers.some(code => typeof code !== 'string')))) fail('NAMES_BATCH_INPUT_INVALID');
  scope.validateItems(rows.map(row => ({ sku: row.sku, productId: row.productId })), { limit: MAX_ITEMS });
  const items = rows.filter(row => row.status === 'blocked' && row.blockers.includes('DURABLE_REMOTE_ID_REQUIRED'))
    .map(({ sku, productId }) => ({ sku, productId }));
  scope.validateItems(items, { limit: MAX_ITEMS });
  return { items };
}

async function readPreviewInput(file) {
  const jsonLines = path.extname(file).toLowerCase() === '.jsonl';
  return parsePreviewInput(await (jsonLines ? readJsonLines(file) : readJson(file)), { jsonLines });
}

function validNames(value) {
  return plain(value) && Object.hasOwn(value, 'all') && Object.keys(value).every(key => ['all', 'en'].includes(key))
    && Object.values(value).every(name => typeof name === 'string' && name.trim() && name.length <= 1024
      && !/[\u0000-\u001f\u007f]/.test(name));
}

function validateSelection(item) {
  if (!['amber', 'magento'].includes(item.choice) || !/^[a-f0-9]{64}$/.test(item.previewToken || '')
    || !validNames(item.amber) || !validNames(item.magento)
    || !same(Object.keys(item.amber).sort(), Object.keys(item.magento).sort())
    || item.choice !== (same(item.amber, item.magento) ? 'amber' : 'magento')) fail('NAMES_BATCH_REVIEW_INVALID');
}

function validatePlan(payload) {
  if (!keys(payload, ['items']) || !Array.isArray(payload.items)) fail('NAMES_BATCH_PLAN_INVALID');
  scope.validateItems(payload.items.map(item => ({ sku: item?.sku, productId: item?.productId })), { limit: MAX_ITEMS });
  for (const item of payload.items) {
    if (item.status === 'eligible') {
      if (!keys(item, ['sku', 'productId', 'status', 'choice', 'amber', 'magento', 'previewToken'])) fail('NAMES_BATCH_PLAN_INVALID');
      validateSelection(item);
    } else if (item.status !== 'error' || !keys(item, ['sku', 'productId', 'status', 'code'])
      || !/^[A-Z][A-Z0-9_]{0,159}$/.test(item.code || '')) fail('NAMES_BATCH_PLAN_INVALID');
  }
  return payload;
}

async function authorize(ctx) {
  ctx.checkStopped(); await ctx.authority(); ctx.checkStopped();
}

function createDefinition({ names } = {}) {
  const service = () => names || require('../src/services/magento/name-resolution.service');
  const preview = async (pair, choice, ctx) => {
    await authorize(ctx);
    const value = await service().preview({ productId: pair.productId, choice }, ctx.options);
    if (value.productId !== pair.productId || value.article !== pair.sku || value.choice !== choice
      || !/^[a-f0-9]{64}$/.test(value.previewToken || '') || !validNames(value.amber) || !validNames(value.magento)) fail('NAMES_BATCH_PREVIEW_INVALID');
    return value;
  };
  return {
    name: 'names-batch', permissions: ['exports.create'], requiresMagento: true, help: HELP, readPreviewInput, validatePlan,
    async preview(rawInput, ctx) {
      const input = parsePreviewInput(rawInput);
      await authorize(ctx);
      const pairs = await scope.assertItems(ctx.databasePool, input.items, { limit: MAX_ITEMS });
      const items = [];
      for (const pair of pairs) {
        // Authorization failures, including revocation between the two reads, stop the whole preview.
        await authorize(ctx);
        try {
          let value = await preview(pair, 'magento', ctx);
          if (same(value.amber, value.magento)) {
            const first = value;
            value = await preview(pair, 'amber', ctx);
            if (!same(value.amber, first.amber) || !same(value.magento, first.magento)) fail('NAMES_BATCH_PREVIEW_CHANGED');
          }
          const item = { ...pair, status: 'eligible', choice: value.choice, amber: value.amber,
            magento: value.magento, previewToken: value.previewToken };
          validateSelection(item); items.push(item);
        } catch (error) {
          if (globalFailure(error)) throw error;
          items.push({ ...pair, status: 'error', code: codeOf(error) });
        }
      }
      return validatePlan({ items });
    },
    async apply(payload, ctx, journal) {
      validatePlan(payload);
      await authorize(ctx);
      await scope.assertItems(ctx.databasePool, payload.items.map(({ sku, productId }) => ({ sku, productId })), { limit: MAX_ITEMS });
      const results = [];
      for (const item of payload.items) {
        ctx.checkStopped();
        if (item.status !== 'eligible') {
          await journal.append({ type: 'item_result', ...item }); results.push(item); continue;
        }
        await authorize(ctx);
        await scope.assertItems(ctx.databasePool, [{ sku: item.sku, productId: item.productId }], { limit: MAX_ITEMS });
        await journal.append({ type: 'item_prepared', sku: item.sku, productId: item.productId,
          choice: item.choice, previewToken: item.previewToken });
        await authorize(ctx);
        try {
          const response = await service().apply({ productId: item.productId, choice: item.choice,
            previewToken: item.previewToken }, ctx.options);
          if (response.productId !== item.productId || response.choice !== item.choice) fail('NAMES_BATCH_RESULT_MISMATCH');
          const result = { sku: item.sku, productId: item.productId, status: 'applied', result: response };
          await journal.append({ type: 'item_result', ...result }); results.push(result);
        } catch (error) {
          await journal.append({ type: 'item_result', sku: item.sku, productId: item.productId,
            status: 'error', code: codeOf(error), outcome: 'unconfirmed' });
          throw error;
        }
      }
      return { items: results, directRemoteWrites: 0 };
    },
  };
}

const command = createCommand(createDefinition());
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  command.main().then(code => { process.exitCode = code; });
}
module.exports = { ...command, createDefinition, readPreviewInput, parsePreviewInput, validatePlan, MAX_ITEMS };
