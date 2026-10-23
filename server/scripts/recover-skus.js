'use strict';
// Exact current public SKUs through the existing UI stable-recount recovery.
const path = require('node:path');
const { createCommand, fail } = require('./operator-cli');
const scope = require('./operator-scope');
const { hash } = require('../src/services/magento/binding-contract');

const MAX_ITEMS = 50;
const KIND = 'stable_recount_exposure';
const HELP = 'node scripts/recover-skus.js --mode preview|apply --input FILE --output NEWFILE '
  + '--expected-database NAME --actor-id ID [--plan-hash SHA256]\n'
  + 'Preview input: {"skus":["AG-000001"],"reason":"Reviewed recount recovery"}. '
  + 'Apply reads the saved preview and its plan hash. At most 50 exact SKUs; Magento GET only.';
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const codeOf = error => /^[A-Z][A-Z0-9_]{0,159}$/.test(error?.code || '') ? error.code : 'RECOVER_SKUS_FAILED';
const globalFailure = error => /PERMISSION|ADMIN|AUTHORI|ACTOR|DATABASE|INTERRUPT|STOPPED|REMOTE_WRITE|GET_ONLY/.test(codeOf(error));
const reasonValid = reason => typeof reason === 'string' && reason.trim() === reason && reason.length >= 3
  && reason.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(reason);
const blockersValid = blockers => Array.isArray(blockers) && blockers.every(code => typeof code === 'string'
  && /^[A-Z][A-Z0-9_]{0,159}$/.test(code));

function validateInput(input) {
  if (!keys(input, ['skus', 'reason']) || !reasonValid(input.reason)) fail('RECOVER_SKUS_INPUT_INVALID');
  scope.validateSkus(input.skus, { limit: MAX_ITEMS });
  return { skus: [...input.skus], reason: input.reason };
}

function validateReview(item) {
  const review = item.review;
  if (!plain(review) || review.format !== 'magento-lifecycle-recovery-v1' || review.kind !== KIND
    || review.productId !== item.productId || review.article !== item.sku || review.payload?.productId !== item.productId
    || !/^[a-f0-9]{64}$/.test(item.reviewHash || '') || hash(review) !== item.reviewHash
    || !blockersValid(review.blockers) || hash(review.blockers) !== hash(item.blockers)) fail('RECOVER_SKUS_REVIEW_INVALID');
  if ((item.status === 'eligible') !== (item.blockers.length === 0)
    || review.payload.eligible !== (item.status === 'eligible')) fail('RECOVER_SKUS_REVIEW_INVALID');
}

function validatePlan(payload) {
  if (!keys(payload, ['reason', 'items']) || !reasonValid(payload.reason) || !Array.isArray(payload.items)) fail('RECOVER_SKUS_PLAN_INVALID');
  scope.validateItems(payload.items.map(item => ({ sku: item?.sku, productId: item?.productId })), { limit: MAX_ITEMS });
  for (const item of payload.items) {
    if (!['eligible', 'blocked', 'not_available', 'error'].includes(item.status) || !blockersValid(item.blockers)) fail('RECOVER_SKUS_PLAN_INVALID');
    if (['eligible', 'blocked'].includes(item.status)) {
      if (!keys(item, ['sku', 'productId', 'status', 'blockers', 'review', 'reviewHash'])) fail('RECOVER_SKUS_PLAN_INVALID');
      validateReview(item);
    } else if (!keys(item, ['sku', 'productId', 'status', 'blockers']) || !item.blockers.length) fail('RECOVER_SKUS_PLAN_INVALID');
  }
  return payload;
}

async function authorize(ctx) {
  ctx.checkStopped(); await ctx.authority(); ctx.checkStopped();
}

function createDefinition({ recovery } = {}) {
  const service = () => recovery || require('../src/services/magento/lifecycle-recovery');
  return {
    name: 'recover-skus', permissions: ['exports.reconcile'], requiresMagento: true, help: HELP, validatePlan,
    async preview(rawInput, ctx) {
      const input = validateInput(rawInput);
      await authorize(ctx);
      const pairs = await scope.resolveSkus(ctx.databasePool, input.skus, { limit: MAX_ITEMS });
      const items = [];
      for (const pair of pairs) {
        await authorize(ctx);
        let state;
        try {
          state = await service().productRecovery(ctx.config, pair.productId, { ...ctx.options,
            canRecoverJobs: false, canReconcileLifecycle: true });
        } catch (error) {
          if (globalFailure(error)) throw error;
          items.push({ ...pair, status: 'error', blockers: [codeOf(error)] }); continue;
        }
        if (state.productId !== pair.productId || state.article !== pair.sku) fail('RECOVER_SKUS_PRODUCT_MISMATCH');
        if (!state.lifecycle?.availableKinds?.includes(KIND)) {
          const blockers = [state.lifecycle?.blocker, ...(state.lifecycle?.unavailableReasons || [])].filter(Boolean);
          items.push({ ...pair, status: 'not_available', blockers: blockers.length ? blockers : ['RECOVER_SKUS_NOT_AVAILABLE'] });
          continue;
        }
        await authorize(ctx);
        try {
          const reviewed = await service().preview(ctx.config, pair.productId, { kind: KIND }, ctx.options);
          const item = { ...pair, status: reviewed.eligible ? 'eligible' : 'blocked', blockers: reviewed.blockers,
            review: reviewed.review, reviewHash: reviewed.reviewHash };
          validateReview(item); items.push(item);
        } catch (error) {
          if (globalFailure(error)) throw error;
          items.push({ ...pair, status: 'error', blockers: [codeOf(error)] });
        }
      }
      return validatePlan({ reason: input.reason, items });
    },
    async apply(payload, ctx, journal) {
      validatePlan(payload);
      await authorize(ctx);
      await scope.assertItems(ctx.databasePool, payload.items.map(({ sku, productId }) => ({ sku, productId })), { limit: MAX_ITEMS });
      const results = [];
      for (const item of payload.items) {
        ctx.checkStopped();
        if (item.status !== 'eligible') {
          const result = { sku: item.sku, productId: item.productId, status: item.status, blockers: item.blockers };
          await journal.append({ type: 'item_result', ...result }); results.push(result); continue;
        }
        await authorize(ctx);
        await scope.assertItems(ctx.databasePool, [{ sku: item.sku, productId: item.productId }], { limit: MAX_ITEMS });
        await journal.append({ type: 'item_prepared', sku: item.sku, productId: item.productId, reviewHash: item.reviewHash });
        await authorize(ctx);
        try {
          const response = await service().apply(ctx.config, item.productId,
            { review: item.review, reviewHash: item.reviewHash, reason: payload.reason }, ctx.options);
          if (response.productId !== item.productId || response.sku !== item.sku) fail('RECOVER_SKUS_RESULT_MISMATCH');
          const result = { sku: item.sku, productId: item.productId,
            status: response.alreadyApplied ? 'already_applied' : 'recovered', result: response };
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
module.exports = { ...command, createDefinition, validateInput, validatePlan, MAX_ITEMS };
