# Reviewed canonical weight repair

This offline tool reconciles a missing canonical `products.weight` with an already
recorded question answer. It is not a new measurement, repricing, recount, Magento
delivery or proof that a migration previously erased physical weight.

Forward migration [072](../server/migrations/072_reviewed_canonical_weight_repair.sql)
installs the guarded plan/receipt boundary. It writes no product or delivery data,
enrolls no historical work and changes no activation or published binding.
Production deployment and a reviewed production run are separate decisions.

## Eligible scope

The preview scans at most 1,000 current active SV products with souvenir semantic
value `5`. It includes a row only when all of these facts are proved:

- Canonical weight is exactly zero; the positive recorded answer has plain numeric
  syntax, at most three decimal places, fits `NUMERIC(14,3)` and satisfies the one
  current, unarchived, non-SKU text weight question's numeric bounds.
- This is a legacy SKU/schema product, with one current public identity, one exact
  internal SKU and the original SKU reservation. Native characteristic versions,
  TEST identities, historical/corrected versions and ambiguous identity are excluded.
- No correction lineage, active correction/price request or unfinished sync,
  media, visibility, reactivation or TEST deletion work exists for that identity.
- The exact current published template result, including effective shared names
  and existing evaluation issues, is identical before/after the proposed copy.
  A template consuming the physical field can make the row ineligible.

The answer is retained byte-for-byte in its JSON representation: a comma or leading
plus is parsed for the canonical number without rewriting `details.answers`.
Nonzero weights, invalid answers and ambiguous histories are never repaired by apply.
The earlier local count of 253 candidates is diagnostic history, not a production
selection. Generate a fresh plan on the exact production connection and review its
count, examples and explicit IDs before any application.

## Transaction and delivery boundary

An ordinary weight update changes `magento_sync_product_input` and normally creates
or advances an automatic request. Migration 072 preserves that behavior for ordinary
writes and adds a receipt-bound exception for this one bookkeeping action.

Each selected row uses the existing repair transaction, active actor permissions
`exports.reconcile` and `products.recount`, access/lifecycle locks, public identity
and sync session locks, binding lock, and product/lifecycle/request row locks.
The database, installation, origin, current publication, question/pricing metadata,
complete row and its history/delivery records are re-read against the sealed plan.

The database receipt must prove a weight-only delta to the exact positive answer.
An inverse must reference a completed original receipt and its exact untouched
post-state. The exception cannot skip normal product/media/history guards. Deferred
completion requires the final exact row/state and a matching immutable audit event
in the same transaction. Missing audit, an unexpected side effect or stale evidence
rolls back that row and its receipt.

Stored prices, answers, photographs, identity, immutable versions/snapshots, full and
price revisions, generations, jobs, confirmations and participation stay unchanged.
No worker, Magento client, exchange-rate fetch, repricing or capture is run. Existing
Attention and unconfirmed delivery states are preserved; this tool does not grant
delivery credit or clear them.

Rows commit sequentially with immutable per-row receipts. Results explicitly report
`applied`, `already_applied`, `conflicted`, `failed` and `not_attempted`; this is not
an all-or-nothing batch. Configuration or actor drift stops the remaining scope.
A stale individual row is reported without substituting its successor or another SKU.

The plan hash covers exact PostgreSQL JSON text to preserve numeric precision.
Plans are bounded to 32 MiB, row evidence to 1 MiB and preview to five minutes.
No implicit `all` selection, HTTP route, startup hook or default apply mode exists.

## Operator commands

Run from `server/` on the authorized connection. Replace all uppercase placeholders
with independently verified values. Keep plans/receipts outside the repository.
The commands below are instructions, not a production execution receipt.

```text
node scripts/canonical-weight-repair.js --expected-database EXACT_DATABASE --installation-key EXACT_INSTALLATION --binding-revision CURRENT_PUBLISHED_BINDING_UUID --actor-user-id ACTIVE_APPLICATION_USER_ID --output NEW_PLAN_FILE
```


The preview command is one line; replace placeholders before executing it. Its
output file must not exist and its private parent directory must already exist.
Do not use the earlier `sv-stone-canonical-weight-review-draft-v1` diagnostic file
as an apply plan; the committed tool generates `sv-canonical-weight-repair-v1`.

| Placeholder | Independently verified value |
| --- | --- |
| `EXACT_DATABASE` | The database name on the authorized production connection; checked against the actual database. |
| `EXACT_INSTALLATION` | The existing active installation key; do not create or substitute a new key. |
| `CURRENT_PUBLISHED_BINDING_UUID` | The current published binding UUID on that same installation. |
| `ACTIVE_APPLICATION_USER_ID` | The active application user ID with `exports.reconcile` and `products.recount`; not an OIDC subject. |
| `NEW_PLAN_FILE` | A fresh private output file outside the repository; never a production connection string or credential. |

Preview defaults to a read-only pool/transaction. It writes a new file and prints
the hash, counts and up to five examples without credentials or a private origin.
The complete artifact contains product/history evidence and should remain private.

After reviewing that fresh plan and its exact scope, explicitly apply only the
approved eligible IDs:

```text
node scripts/canonical-weight-repair.js --mode apply --expected-database EXACT_DATABASE --installation-key EXACT_INSTALLATION --binding-revision CURRENT_PUBLISHED_BINDING_UUID --actor-user-id ACTIVE_APPLICATION_USER_ID --plan REVIEWED_PLAN_FILE --confirm-plan-hash REVIEWED_SHA256 --product-ids ID1,ID2 --output NEW_RECEIPT_DIRECTORY
```

`--output` must be a fresh directory for every apply attempt. PostgreSQL receipts,
not disk files, determine whether a row already committed. If the process loses its
disk checkpoint, retry the same hash and exact selection into a new directory.
The tool verifies the actual committed post-state and does not repeat a write/audit.
Later legitimate data changes require fresh review and cannot be hidden by retry.

An inverse is a separate preview over explicit original receipt UUIDs:

```text
node scripts/canonical-weight-repair.js --mode rollback-preview --expected-database EXACT_DATABASE --installation-key EXACT_INSTALLATION --binding-revision CURRENT_PUBLISHED_BINDING_UUID --actor-user-id ACTIVE_APPLICATION_USER_ID --receipt-ids ORIGINAL_RECEIPT_UUID1,ORIGINAL_RECEIPT_UUID2 --output NEW_INVERSE_PLAN_FILE
```

Review and execute that inverse plan with the same explicit `--mode apply` command.
Rollback deliberately restores the recorded zero/answer discrepancy and preserves
both audit receipts; it does not certify a physical measurement. Changes since the
repair, a changed publication result or an existing inverse make it ineligible.
An old apply plan never silently reapplies a repair after a rollback.

Exit codes: `0` for a successful preview or complete selected application, `2` for
reported conflicts/failures/unattempted rows, and `1` for an invocation/connection/
artifact failure. Inspect the persisted per-row outcome before proceeding.

## Verification boundary

The disposable PostgreSQL regression covers the 071 upgrade checkpoint, complete
DDL rollback and repeated startup/checksums; exact dot/comma/numeric copies; source
validation and exclusions; absent/forged guards; ordinary enqueue behavior; actual
lock contention and simultaneous writers; audit rollback and deferred side-effect
failure; actor/configuration drift; lost disk recovery; exact inverse and drift
after inverse preview; and a real published template whose result changes with
physical weight. These tests use synthetic data and block external fetches.
They do not establish the current production count or authorize production apply.
