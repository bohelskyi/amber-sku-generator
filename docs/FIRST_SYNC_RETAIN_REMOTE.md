# Legacy SV remote retention in first sync (removed) and retained-value import

**Status: the temporary decision `retain_remote` is removed** (migration
[081](../server/migrations/081_first_sync_remote_retention_closed.sql)). Receipts
recorded with it stay terminal, immutable first-sync history. Their values are
imported into Amber with the reviewed command described below.

## History

During the mass Magento first sync, current legacy SV products (historical internal
SKU and pinned SKU schema) could not import a Magento material or colour that Amber
lacked: the first-sync legacy check refused it with
`FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED` because the stored answers would no
longer rebuild the internal SKU. On 2026-10-14 the catalog owner decided that
Magento keeps such values during the mass first sync and Amber stays empty.
Migration [080](../server/migrations/080_first_sync_remote_retained.sql) added the
terminal state `remote_retained` (`after: null`, `source.decision: retain_remote`)
and the operator script `first-sync-retain-remote.js` recorded it.

The same decision made historical internal SKUs **opaque identifiers**: they are
kept only for lookup; Amber no longer decodes or regenerates them. See
[SKU and catalog](SKU_CATALOG.md#opaque-legacy-internal-skus).

## What replaced it

1. First sync imports a missing legacy SKU-question answer (for example SV
   `material`, `color`) and a missing weight without SKU agreement; see
   [missing legacy SV inputs](MAGENTO_FIRST_SYNC_FIELDS.md#missing-legacy-sv-inputs).
2. Export-template source support `historical-source-support-v2` checks a legacy
   product's stored semantic value against its pinned schema question's options
   instead of rebuilding the internal SKU; see
   [historical source support](EXPORT_TEMPLATES.md#historical-source-support).
   Published templates keep v1 until an explicit reviewed update, new template
   publication and binding successor.
3. The `retain_remote` choice, `canRetainRemote`, the `remoteRetention` projection
   marker and `first-sync-retain-remote.js` are removed. A request with
   `choice: retain_remote` is invalid. Migration 081 refuses any new
   `remote_retained` row (`FIRST_SYNC_REMOTE_RETENTION_CLOSED`); the state stays in
   the terminal and completion sets so existing sessions remain complete.

## Importing retained values

The completed first-sync ledger cannot change. `retained-remote-import`
(`server/src/services/magento/retained-remote-import.js`) therefore writes only the
Amber product, through the canonical first-sync setter (`applyFirstSyncLocal`), plus
its own audit receipt `product.magento_retained_values_imported`.

For one product it requires: Administrator with `export_templates.manage`,
`exports.view` and `products.recount`; the current published binding; a current
legacy SV product whose first sync is complete (`ordinary`) and has
`remote_retained` fields. Each retained field is checked against a fresh GET-only
Magento observation and a no-receipt projection of the current publication:

| Field status | Meaning |
| --- | --- |
| `importable` | Amber is empty, Magento still holds the retained value, and the canonical setter proves the missing-only import (pinned/current option, unchanged final price, exact forward output). |
| `already_imported` | Amber already holds the value and it equals Magento. |
| `blocked` | `code` says why, for example `REMOTE_CHANGED` (Magento differs from the retained value), `LOCAL_VALUE_PRESENT`, `FIRST_SYNC_LEGACY_SKU_ANSWER_INVALID` or `FIRST_SYNC_CANONICAL_PRICE_REVIEW_REQUIRED`. Nothing is written for it. |

Each field is proved alone and then together with the others. Apply revalidates
the product/binding snapshot, rebuilds the preview under the transaction and
refuses a changed token (`MAGENTO_RETAINED_IMPORT_PREVIEW_STALE`). It never
changes `full_sku`, `sku_registry`, the pinned schema or option meanings, names or
Magento; replaying the same token returns the recorded receipt.

### Operator script

Use the current published binding revision. SV material and colour are not
source-support targets (only `NM.extra` and `AR.size` are), so this import does not
wait for the v2 template publication; the forward output is still proved against
whichever publication is current.

```text
node /app/scripts/first-sync-retained-import.js --mode preview --server-root /app \
  --input INPUT.json --output NEW_PREVIEW.jsonl \
  --expected-database amber --actor-id ADMIN_ID --installation-key amber

node /app/scripts/first-sync-retained-import.js --mode apply --server-root /app \
  --input INPUT.json --output NEW_APPLY.jsonl \
  --expected-database amber --actor-id ADMIN_ID --installation-key amber
```

`INPUT.json` is `{ "bindingRevisionId": "...", "items": [{ "sku": "..." }] }`. List
the products from the retained receipts:

```sql
SELECT DISTINCT s.public_sku FROM magento_first_sync_fields f
JOIN magento_first_sync_sessions s ON s.id=f.session_id
WHERE f.state='remote_retained' ORDER BY 1;
```

Each output line is one product: `importable` (preview), `imported` /
`already_applied` (apply), `already_imported`, `nothing_retained`, `blocked` (no
importable field; `blocked` lists the codes) or `review` with `code`. Global
authority/publication failures stop the run. Exit code 2 means some products need
review. Retrying is safe.

## Legacy conflicts resolved in Magento's favour

A populated Amber value is never overwritten by these tools, including weight (for
example SV1121001: Magento 8455 g, Amber 123 g). For SV, weight is a pricing input,
so such a decision changes the final price and goes through the ordinary reviewed
recount workflow ([recount and corrections](RECOUNT_CORRECTIONS.md)), not first sync.
