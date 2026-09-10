# Exports

## Supported workflow

The legacy direct CSV endpoint remains disabled with `410`. The supported workflow is:

1. create an immutable snapshot;
2. download its stored CSV;
3. explicitly confirm it.

`exports.view` permits export status and existing snapshot download. `exports.create` controls both snapshot creation and confirmation. All built-in roles currently have view; only Administrator has create/confirm.

## Range and row semantics

Requested endpoints are existing SKU anchors, but the normalized range is resolved by product ID/creation order rather than lexicographic SKU ordering. Reversed endpoints are normalized. Products with `exclude_from_export=1` are omitted.

CSV contains the SKU, stored final UAH price (including exact manual decimals), a derived bracelet/necklace size field, and configured free-text fields. Recount apply currently excludes both the corrected source and successor from the normal export queue.

## Immutable snapshots and idempotency

Snapshot payload and CSV content are written once and protected from mutation by a database trigger. Never regenerate or modify a stored snapshot after creation.

A required `Idempotency-Key` is bound to the normalized `fromSku`/`toSku` range:

- reuse with the same range returns the same snapshot;
- reuse with a different range returns `409`;
- the same conflict rule applies to the loser of a concurrent insert race.

## Confirmation and cursor

Confirmation is idempotent and row-locks the snapshot. The singleton export cursor advances with `GREATEST(exported_to_product_id)`, so concurrent or out-of-order confirmations can never move it backward. `last_snapshot_id` follows the non-regressing cursor. Legacy `export_events` remain only for status compatibility.

## CSV safety

Fields retain correct quoting/escaping for commas, quotes, and newlines. Text beginning with spreadsheet formula sigils `=`, `+`, `-`, or `@`—including after leading whitespace or a tab—is prefixed so spreadsheet software does not execute it as a formula.
