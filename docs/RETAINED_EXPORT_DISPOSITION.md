# Retained export disposition

Legacy product CSV files that Amber generated and kept (`export_snapshots`) block
first-sync history admission for every product they list
(`FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED`): the file may have been imported into
Magento, and nothing local proves it. Once legacy product CSV is retired, the
held-product reconciliation dispositions no longer apply to ordinary products. This
tool records, from current Magento evidence, that one such file was imported.

Migration 082 stores one permanent row per file in `retained_export_dispositions`
(`consumed_and_reconciled`, basis `magento_readback_v1`). It binds the exact stored
CSV bytes, the Magento origin, the evidence hash and an
`export.retained_disposition_recorded` audit event. Nothing else changes: snapshots,
membership, products, prices and Magento are untouched, and no export is
acknowledged.

## Evidence rule (`magento_readback_v1`)

For a legacy file (no full-product lifecycle version) with no unresolved retained-index
diagnostics, every **current** product (active, not corrected) resolved from the file's
CSV must:

- exist in Magento under the file's SKU exactly once (GET only);
- have a Magento `created_at` (UTC) between 24 hours before and 7 days after the
  file's `generated_at`.

A superseded member (a corrected or archived version) may be absent from Magento: its
correction may have replaced or removed that SKU later. It is recorded with
`resolved: false` and reported in the preview as `unresolvedSuperseded`; a found
superseded member must pass the same checks. Evidence format
`retained-export-disposition-v2` lists every member with `current` and `resolved`.

Values that changed later (for example a price) are not compared: ordinary
synchronization owns current values. Any missing, ambiguous or out-of-window product
blocks the whole file; there is no partial disposition.

## Effect on history admission

`first-sync-cutover-admission` treats membership in a file as resolved only when a
disposition exists for this origin, the file's current bytes hash to the recorded
`csv_sha256`, and the disposition lists this product as `resolved`. A product listed in another file without a disposition stays blocked.
The disposition is sealed into the admission's `retainedHash`; proofs of products
outside disposed files are unchanged. Then run the
[history admission batch](FIRST_SYNC_HISTORY_BATCH.md) for the products.

## Commands

Run inside the server container. Preview is read-only (read-only database role and
Magento GET only); apply needs an active Administrator.

```text
node /app/scripts/retained-export-disposition.js --mode preview --snapshot-id ID --expected-database NAME
node /app/scripts/retained-export-disposition.js --mode apply --snapshot-id ID --expected-database NAME \
  --actor-user-id ID --preview-token SHA256 --reason "TEXT (10-1000 characters)"
```

Preview prints the member count, the Magento creation range, blockers and, only
without blockers, `previewToken`. Apply rereads Magento and the stored file and
records nothing unless the fresh evidence reproduces the token
(`RETAINED_DISPOSITION_CHANGED` otherwise). Repeating apply with the same token
returns `alreadyApplied: true`; a different token for a recorded file is refused.
