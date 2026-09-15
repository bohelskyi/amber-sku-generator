# Exports

## Supported workflow

The legacy direct CSV endpoint remains disabled with `410`. The supported workflow is:

1. create an immutable snapshot;
2. download its stored CSV;
3. explicitly confirm it.

`exports.view` permits export status and existing snapshot download. `exports.create` controls both snapshot creation and confirmation. Initial system-role mappings give all three roles view access and only Administrator create/confirm access; Manager and Storekeeper permissions can later be changed through role administration.

## Range and row semantics

Requested endpoints are existing SKU anchors, but the normalized range is resolved by product ID/creation order rather than lexicographic SKU ordering. Reversed endpoints are normalized. Products with `exclude_from_export=1` are always omitted.

CSV contains the SKU, stored final UAH price (including exact manual decimals when optional rounding was not selected), a derived bracelet/necklace size field, and configured free-text fields. Recount apply currently excludes both the corrected source and successor from the normal export queue.

A successful direct or request-completed in-place price change increments one durable revision in `product_export_revisions`. Multiple changes coalesce on that row. Normal product snapshots never add an older product merely because its price changed and never rewind the product cursor.

The dedicated price-export workflow uses `/api/price-export/*` and immutable `price_export_snapshots`. Its CSV is exactly `sku,price`, containing the current authoritative final UAH price. A revision is eligible only after `has_product_snapshot=true`, because only then may Magento have an older SKU price. A normal snapshot can establish this exposure when it legitimately contains the product; generation records immutable revision evidence but never confirms it. Only explicit normal-snapshot confirmation may advance the initial revision captured by that snapshot. After exposure, only dedicated price snapshots consume price revisions.

Price snapshot creation captures all eligible non-excluded pending products and does not accept a range or touch the normal cursor. `exclude_from_export=1` suppresses both streams without clearing pending state; excluded pending rows are reported separately. Price snapshot confirmation advances each row with `GREATEST` only to its captured revision, so later changes and concurrent or out-of-order confirmations remain pending. A duplicate idempotent update is preferred while initial normal exposure is unconfirmed.

## Immutable snapshots and idempotency

Snapshot payloads and CSV content are written once and protected from mutation by database triggers in both streams. Snapshot creation holds stable product/revision locks while capturing evidence, so a later price change cannot be mistaken for the represented version. Creator provenance is immutable, and confirmer provenance cannot change once set. Never regenerate or modify a stored snapshot after creation.

Creation stores the authenticated local application user in nullable `created_by_user_id` and appends one transactional `export_snapshot.created` event referencing the immutable snapshot with only its range and row count. Historical snapshots remain unattributed. Idempotent reuse returns the original snapshot without changing its creator or writing another event.

A nonempty idempotency key is required. The creation route accepts the `Idempotency-Key` header or `body.idempotencyKey` and binds the key to the normalized `fromSku`/`toSku` range:

- reuse with the same range returns the same snapshot;
- reuse with a different range returns `409`;
- the same conflict rule applies to the loser of a concurrent insert race.

## Confirmation and cursor

Confirmation is idempotent and row-locks the snapshot. The first confirmation stores the authenticated local application user in nullable `confirmed_by_user_id` and appends one transactional `export_snapshot.confirmed` event referencing the snapshot's exported-to product cursor. Repeated confirmation preserves the original confirmer and emits no duplicate event while retaining cursor and re-export high-water repair.

For each represented re-export, confirmation advances `confirmed_revision` with `GREATEST` only as far as the immutable revision stored in that snapshot. If the product changes again after snapshot creation, confirming the older snapshot leaves the newer revision pending. Revision rows are locked in stable product-ID order, so concurrent or out-of-order confirmations cannot clear a newer pending change. Independently, the singleton product-ID cursor still advances with `GREATEST(exported_to_product_id)` and never moves backward; `last_snapshot_id` follows the non-regressing cursor. Legacy `export_events` remain only for status compatibility.

## CSV safety

Fields retain correct quoting/escaping for commas, quotes, and newlines. Text beginning with spreadsheet formula sigils `=`, `+`, `-`, or `@`—including after leading whitespace or a tab—is prefixed so spreadsheet software does not execute it as a formula.
