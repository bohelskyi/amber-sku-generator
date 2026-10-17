# Temporary legacy SV remote retention in first sync

**Status: temporary.** This decision exists only to finish the mass first sync. It
must be removed together with the remaining legacy SKU dependencies; see
[Follow-up: remove legacy SKU dependencies](#follow-up-remove-legacy-sku-dependencies).

## Problem

For current legacy SV products (historical internal SKU and pinned SKU schema), the
old schema encodes material and colour into the internal SKU. When Amber has no
answer for such a question and Magento has a value, first sync wants to import the
Magento value, but the canonical legacy input check refuses it with
`FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED`: the stored answers would no longer
reproduce the internal SKU, and the published template's legacy source check
(`export-templates/source-support.js`, `reconstruct`) would then reject the
product's semantic fields. The field stays `review_required`, the first-sync
session cannot complete and the product never reaches ordinary delivery, so
price changes in Amber do not reach Magento.

Business decision (catalog owner, 2026-10-14): during the mass first sync Magento
keeps such values and Amber stays empty; the values are imported later, after the
legacy SKU dependencies are removed.

## Decision and receipt

The first-sync choice `retain_remote` is available (`canRetainRemote: true`) only
when all of these hold:

- current legacy SV product (`full_sku` and `sku_schema_version_id` present,
  `characteristic_version_id` absent);
- a semantic option characteristic in scope `all` with a proven mapping and no
  projection/read reason;
- Amber has no answer and the published template's output for that field is
  verified empty (`remoteRetention: legacy-sv-empty-output-v1` in the projection);
- Magento has a value that the planner would import (`EMPTY_LOCAL_UNIQUE_REMOTE_OPTION`
  or `EMPTY_LOCAL_VALID_REMOTE`) and no receipt exists yet.

The choice records the terminal state `remote_retained` with `after: null` and
`source.decision: retain_remote`. Nothing is written to the product, to delivery
requests or to Magento. Ordinary delivery omits empty outputs
(`sync-preview.js`, "never synthesize clearing blanks"), so Magento keeps its value.
Without an explicit choice the canonical import path is unchanged.

Migration [080](../server/migrations/080_first_sync_remote_retained.sql) adds the state
to the field ledger, a shape constraint (`first_sync_remote_retained_shape`) that
ties the state to the decision and its evidence, a trigger check that the product
is a current legacy SV product, and includes the state in the terminal and
completion sets. 073/075/076 remain unchanged history.

## Operator script

`server/scripts/first-sync-retain-remote.js` applies the choice sequentially, one
product at a time, through the canonical `first-sync.service` review and
`applyWithPreparedValidation`. Magento transport is GET-only. Preview only runs the
canonical review, which records nothing but takes its usual Administrator/product
locks, so both modes use the ordinary database pool (a read-only pool fails with
SQLSTATE 25006).

```text
node /app/scripts/first-sync-retain-remote.js --mode preview --server-root /app \
  --input INPUT.json --output NEW_PREVIEW.jsonl \
  --expected-database amber --actor-id ADMIN_ID --installation-key amber

node /app/scripts/first-sync-retain-remote.js --mode apply --server-root /app \
  --input INPUT.json --output NEW_APPLY.jsonl \
  --expected-database amber --actor-id ADMIN_ID --installation-key amber
```

Optional: `--allow-imports` (apply only) also commits other Magento values the fresh
plan receipts; `--schema-cache-seconds 0-600` reuses Magento schema reads within one run.

`INPUT.json` is `{ "bindingRevisionId": "...", "items": [{ "sku": "..." }] }`, the same
shape as the campaign input. Each output line is one product:

| `status` | Meaning |
| --- | --- |
| `retainable` | Preview: fields that would be retained, plus any other pending Magento imports. |
| `retained` / `already_retained` | Apply recorded the receipt (`complete` shows whether the session finished). |
| `nothing_to_retain` | No eligible field. |
| `skipped` | Product is not in first-sync mode (for example already ordinary). |
| `review` | Refused with `code`; nothing was recorded for that product. |

When the fresh plan would also commit other Magento imports (for example a missing
size), apply skips the product with `RETAIN_REMOTE_OTHER_IMPORTS_PRESENT` unless
`--allow-imports` is passed. Authority/publication failures stop the run. The fresh
prepared plan is revalidated before commit; a changed transition refuses with
`RETAIN_REMOTE_TRANSITION_CHANGED`. Retrying is safe: retained fields are terminal
and are not offered again.

After retention, run the SV campaign again; retained rows are settled receipts and
the campaign continues with names, price/weight choices, equal receipts and handoff.

## Follow-up: remove legacy SKU dependencies

Decided by the catalog owner on 2026-10-14: historical internal SKUs are kept only
as identifiers for lookup; Amber no longer decodes or regenerates them. After the
mass first sync, remove the remaining dependencies and then import retained values:

1. `server/src/services/export-templates/source-support.js` (`reconstruct`,
   `checkSourceSupport`): validate a legacy product's semantic value against its
   pinned schema question options instead of requiring the stored answers to
   rebuild the internal SKU. Needs a new evaluator version, template publication
   and binding successor.
2. `server/src/services/magento/first-sync-legacy-inputs.js` (`inspectLegacyInputs`,
   `interpretations`, weight/suffix check): allow missing-only import of legacy
   SKU-question answers and weights without SKU agreement; never change `full_sku`,
   the schema or option meanings.
3. Import the values recorded as `remote_retained` (and other legacy conflicts the
   catalog owner resolves in Magento's favour, such as SV1121001 weight 8455 g).
4. Remove the `retain_remote` decision once no new retention is needed, and update
   [SKU catalog](SKU_CATALOG.md) for the opaque legacy SKU rule.
