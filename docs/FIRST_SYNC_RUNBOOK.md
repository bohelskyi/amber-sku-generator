# First sync: operator runbook

The working order for bringing existing catalog products under automatic Magento
sync. Contracts live in [first-sync fields](MAGENTO_FIRST_SYNC_FIELDS.md),
[automatic sync](MAGENTO_AUTOMATIC_SYNC.md) and [Magento integration](MAGENTO_INTEGRATION.md);
this page is the practical sequence, the CLIs and the traps already hit in production.
Every CLI below runs inside the server container (`docker compose exec -T server node
/app/scripts/<name>.js …`), is sequential, reads Magento with GET only and never
enqueues or writes Magento directly.

## Where a product stands

- `magento_product_sync_requests.state`: `synced` is done. `needs_attention` is **not**
  a retry queue; the product needs a decision and then a handoff (step 4).
- Read-only diagnosis per SKU: `first-sync.service.review(config, {sku, bindingRevisionId})`
  returns `mode` (`ordinary` = done, `first` = field decisions pending, `review` =
  blocked before fields, usually `FIRST_SYNC_HISTORY_REVIEW_REQUIRED`) plus the
  non-equal fields with Amber/Magento values.
- The products page shows synced/total per category («Синхронізовано»).

## Order of work for one category

1. **History admission** (`mode: review`, `FIRST_SYNC_HISTORY_REVIEW_REQUIRED`).
   - Ordinary legacy products: [`first-sync-history-batch.js`](FIRST_SYNC_HISTORY_BATCH.md),
     scope files of ≤50 `{sku, productId, remoteProductId}`.
     Run `--mode preview --preview-all` to see every blocker in one run, then
     `--mode apply` per scope file. Apply stops at the first non-admitted item; rerun it
     after transient `MAGENTO_TIMEOUT` (already admitted rows report `already_admitted`).
   - Products created by a correction/recount (lifecycle `hold/historical_ambiguity`
     with a correction ID): the batch reports `HISTORY_BATCH_ADMISSION_NOT_AVAILABLE`.
     Use the product problem page action «Дозволити оновлення після переобліку»
     (`stable_recount_exposure`). It records its own handoff.
2. **Field decisions** (`mode: first`). Approved owner rules so far:
   - Amber price is authoritative; whole-gram weight rounding keeps Amber; CH bead
     dimensions keep Amber: [`first-sync-keep-local.js`](FIRST_SYNC_CH_DECISIONS.md)
     with `--targets`.
   - Missing names/values come from Magento: [name completion](NAME_COMPLETION_BATCH.md),
     [initial names](FIRST_SYNC_INITIAL_NAMES.md).
   - Legacy SV characteristic empty in Amber (for example material, colour) is
     imported missing-only by ordinary first sync (opaque legacy SKU rule). The
     temporary `retain_remote` decision is removed; already retained values are
     imported with [`first-sync-retained-import.js`](FIRST_SYNC_RETAIN_REMOTE.md#importing-retained-values).
   - SV cohorts: [SV campaign](SV_CAMPAIGN.md) wraps history, names, fields and handoff.
   - Anything else (real value conflicts, populated legacy answers) is a per-product owner
     decision: fix Amber (product edit or correction) or record keep_local/accept_remote.
3. **Correcting Amber data** creates a new product version for corrections. That
   version starts on `hold/historical_ambiguity`; confirm it with step 1's recount
   action. A plain weight/size edit may also produce a correction.
4. **Handoff.** Field decisions do not wake `needs_attention` requests. Record a
   reviewed `broader_resync` through `binding-controlled-actions` (`preview` → token →
   `apply`, ≤100 products, the reason text is part of the token). History admission
   and the recount action record their own handoff.
5. **Verify.** Re-run the per-SKU review: synced products report `mode: ordinary`.

Useful flags: `--schema-cache-seconds 120` on history batch, keep-local and
retained-import reuses Magento schema/topology reads within one run (~3× faster; do not
edit Magento attributes during such a run). `--allow-imports` lets keep-local
apply when the fresh plan also receipts Magento values.

## Changing bindings or the template

Every publication has side effects on products that are **not yet synced**:

- **Legacy history admissions are per publication.** After publishing, rerun step 1
  for every unsynced product of every category (recount admissions survive since PR #99).
  Batch several binding changes into one publication.
- Never build a new template version from the current code candidate unless a diff
  against the published definition shows only intended changes; production templates
  diverge from the code candidate. Patch the published definition instead.
- `magento-successor-prepare.js --skus …` (≤100): category paths in the successor come
  **only from the evaluated sample**. When a category expression changes, include one
  product per category path (souvenir type, statuette, game, stone processing …),
  otherwise unsampled paths disappear and products lose coverage.
- A changed expression also drops carried approvals of every field it references
  (for SV categories: `suveniry`, `vyd_statuetky`, `kamin_obrobka`, `nastlni_ihry`).
  Re-approve identical decisions with `magento-carry-unchanged-reviews.js`, never by
  hand-picking in bulk.
- Before publishing, run the publication preview (`magento-publication.js --mode
  preview` or the UI check) and require **zero lost coverage** unless the loss is the
  intended outcome.
- Missing Magento categories are created from the draft through the reviewed category
  action (`configuration-category` preview/apply, one POST, hidden from menu). Category
  names containing `/` cannot be bound (the path separator); use a separate segment.
- `country_of_manufacture` labels can flip language between reads and make a draft
  look stale («Prepare a draft with fresh Magento metadata»); re-check before acting.

## Operational traps

- `docker compose` deploys wipe the container's `/tmp`. Keep scripts and journals on
  the host (`docker compose cp`) and copy them in again after each deploy.
- In an interactive shell use `set +H` before node one-liners containing `!`.
- Placeholders like `<installationKey>` must be replaced; the shell treats `<…>` as
  redirection.
- Container scripts reading `/tmp/...` inputs need the files copied first; outputs
  must be copied back before the next deploy.

## CLI index

| Script | Purpose | Doc |
| --- | --- | --- |
| `first-sync-history-batch.js` | Legacy history admission, ≤50 per scope | [history batch](FIRST_SYNC_HISTORY_BATCH.md) |
| `first-sync-keep-local.js` | Amber-wins decisions (price, rounding weight, CH dimensions) | [CH decisions](FIRST_SYNC_CH_DECISIONS.md) |
| `first-sync-retained-import.js` | Import legacy SV values left in Magento by the removed retain_remote | [retained import](FIRST_SYNC_RETAIN_REMOTE.md#importing-retained-values) |
| `name-completion-batch.js` | Fill missing names from Magento | [name completion](NAME_COMPLETION_BATCH.md) |
| `first-sync-initial-names.js` | Initial names for `NAME_BASELINE_REQUIRED` | [initial names](FIRST_SYNC_INITIAL_NAMES.md) |
| `first-sync-local-discovery.js`, `first-sync-local-batch.js` | Sealed local authority packets (≤10) | [discovery](FIRST_SYNC_LOCAL_DISCOVERY.md), [local batch](FIRST_SYNC_LOCAL_BATCH.md) |
| `first-sync-local-classify.js`, `sv-campaign.js` | SV classification and cohort campaign | [classify](FIRST_SYNC_LOCAL_CLASSIFY.md), [SV campaign](SV_CAMPAIGN.md) |
| `first-sync-campaign.js` | Generic exact-SKU campaign (no handoff) | [campaign](FIRST_SYNC_CAMPAIGN.md), [names](FIRST_SYNC_CAMPAIGN_NAMES.md) |
| `magento-successor-prepare.js` | Binding successor for a new template version | this page |
| `magento-carry-unchanged-reviews.js` | Re-approve identical successor decisions | this page |
| `magento-publication.js` | H3b publication preview/apply with handoff | [integration](MAGENTO_INTEGRATION.md#reviewed-publication-and-controlled-handoff-h3b) |
| `sv-optional-characteristics.js` | One-off SV template change (2026-10-14) | script header |
| `canonical-weight-repair.js` | Reviewed zero-weight repair | [weight repair](CANONICAL_WEIGHT_REPAIR.md) |

## Open follow-ups

- After the mass sync: run `first-sync-retained-import.js`; publish the v2 source-support
  template and binding successor for NM/AR (see [retained import](FIRST_SYNC_RETAIN_REMOTE.md)).
- `first-sync-keep-local.js` counts an equal-name
  `name_received` receipt as an import; use `--allow-imports` when the preview lists no imports.
- Successor preparation could carry unchanged reviewed category paths instead of
  relying on the sample.
