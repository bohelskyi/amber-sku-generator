# First sync: operator runbook

The working order for bringing existing catalog products under automatic Magento
sync. Contracts live in [first-sync fields](MAGENTO_FIRST_SYNC_FIELDS.md),
[automatic sync](MAGENTO_AUTOMATIC_SYNC.md) and [Magento integration](MAGENTO_INTEGRATION.md);
this page is the practical sequence, the CLIs and the traps already hit in production.
The scripts below run from `server/` or a matching server container
(`docker compose exec -T server node /app/scripts/<name>.js …`). Their Magento
transport is GET-only, but apply modes can change local data, stage ordinary
automatic requests or record controlled handoff. An enabled worker can then
deliver those products. In particular, publication and the SV campaign include
handoff; they are not read-only operations. Use the [complete CLI index](CLI_SCRIPTS.md)
for modes, side effects and the distinction between commands and support modules.

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
     Run `--mode preview --preview-all` with the required input SHA-256, database,
     actor and new output path to collect per-item blockers, then
     `--mode apply` per scope file. Apply stops at the first non-admitted item; rerun it
     after transient `MAGENTO_TIMEOUT` (already admitted rows report `already_admitted`).
   - Ordinary legacy products listed in a retained legacy export file report
     `FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED` in the review assessment. Record the
     file's disposition from Magento readback with
     [`retained-export-disposition.js`](RETAINED_EXPORT_DISPOSITION.md), then run the
     history batch for them.
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
   - Legacy SV zero canonical weight with no recorded answer (`decor_weight`
     `FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED`): take Magento `decor_weight` with
     [`canonical-weight-repair.js --source magento-readback`](CANONICAL_WEIGHT_REPAIR.md#magento-readback-source),
     then the step 4 handoff.
   - Legacy SV characteristic empty in Amber and not emitted by the template:
     [`first-sync-retain-remote.js`](FIRST_SYNC_RETAIN_REMOTE.md) (temporary).
   - SV cohorts: [SV campaign](SV_CAMPAIGN.md) wraps history, names, fields and handoff.
   - Anything else (real value conflicts, SKU-driving answers) is a per-product owner
     decision: fix Amber (product edit or correction) or record keep_local/accept_remote.
3. **Correcting Amber data** creates a new product version for corrections. That
   version starts on `hold/historical_ambiguity`; confirm it with step 1's recount
   action. A plain weight/size edit may also produce a correction.
   - Owner-verified corrections for many legacy products: `legacy-answer-recount-batch.js`
     (≤50 SKUs). It fills an absent option answer (`"answers":{"stone_processing":1}`)
     and/or restores the exact physical weight from `answers.weight` when `products.weight`
     holds its truncated/rounded integer (`"weightFromAnswer":true`). Per item it runs the
     same recount as the UI and then the same «Дозволити оновлення після переобліку»
     (`stable_recount_exposure`), which records its own handoff. See
     [recount batch](RECOUNT_CORRECTIONS.md#reviewed-legacy-answer-recount-batch).
4. **Handoff.** Field decisions do not wake `needs_attention` requests. Record a
   reviewed `broader_resync` through `binding-controlled-actions` (`preview` → token →
   `apply`, ≤100 products, the reason text is part of the token). The history batch
   records admission evidence only; it does not wake a request or record handoff.
   The stable-recount action records its own handoff. Name/source updates can also
   stage ordinary automatic requests; inspect the resulting request state before
   planning a separate handoff.
5. **Verify.** Re-run the per-SKU review: synced products report `mode: ordinary`.

Useful flags: `--schema-cache-seconds 120` on history batch, keep-local and
retain-remote reuses Magento schema/topology reads within one run (~3× faster; do not
edit Magento attributes during such a run). `--allow-imports` lets keep-local/retain
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

- `MAGENTO_PREVIEW_PRODUCT_NOT_UNIQUE` / «Amber SKU is not unique» on a product-ID preview
  (controlled resync, weight repair, product edit) means another row shares the internal
  SKU. Retired archived copies are accepted when the SKU reservation belongs to the
  selected current product and no copy is current, in correction lineage or carrying
  unfinished sync work; anything else remains a real conflict.
- Container replacement does not retain `/tmp`. The checked-in server Dockerfile
  includes repository `server/scripts/` in the image; verify the deployed image's
  commit before use. Keep input files, reviewed plans and journals on persistent
  host storage, copy inputs into the container when needed, and copy results back
  before replacement. Host-only helpers and scripts from an unmerged branch are
  not provided by that image.
- In an interactive shell use `set +H` before node one-liners containing `!`.
- Placeholders like `<installationKey>` must be replaced; the shell treats `<…>` as
  redirection.
- Container scripts reading `/tmp/...` inputs need the files copied first; outputs
  must be copied back before the next deploy.

## CLI index

This is the first-sync subset. [All server scripts](CLI_SCRIPTS.md) also covers
diagnosis, bindings, cutover, repair and helper-only files; its mode column matters
because not every command accepts `--mode preview|apply`.

| Script | Purpose | Doc |
| --- | --- | --- |
| `first-sync-history-batch.js` | Legacy history admission, ≤50 per scope | [history batch](FIRST_SYNC_HISTORY_BATCH.md) |
| `retained-export-disposition.js` | Record a retained export file as imported, from Magento readback | [retained export disposition](RETAINED_EXPORT_DISPOSITION.md) |
| `first-sync-keep-local.js` | Amber-wins decisions (price, rounding weight, CH dimensions) | [CH decisions](FIRST_SYNC_CH_DECISIONS.md) |
| `first-sync-retain-remote.js` | Temporary legacy SV retain_remote | [retain remote](FIRST_SYNC_RETAIN_REMOTE.md) |
| `name-completion-batch.js` | Fill missing names from Magento | [name completion](NAME_COMPLETION_BATCH.md) |
| `first-sync-initial-names.js` | Initial names for `NAME_BASELINE_REQUIRED` | [initial names](FIRST_SYNC_INITIAL_NAMES.md) |
| `first-sync-local-discovery.js`, `first-sync-local-batch.js` | Sealed local authority packets (≤10) | [discovery](FIRST_SYNC_LOCAL_DISCOVERY.md), [local batch](FIRST_SYNC_LOCAL_BATCH.md) |
| `first-sync-local-classify.js`, `sv-campaign.js` | SV classification and cohort campaign | [classify](FIRST_SYNC_LOCAL_CLASSIFY.md), [SV campaign](SV_CAMPAIGN.md) |
| `first-sync-campaign.js` | Generic exact-SKU campaign (no handoff) | [campaign](FIRST_SYNC_CAMPAIGN.md), [names](FIRST_SYNC_CAMPAIGN_NAMES.md) |
| `magento-successor-prepare.js` | Binding successor for a new template version | this page |
| `magento-carry-unchanged-reviews.js` | Re-approve identical successor decisions | this page |
| `magento-publication.js` | H3b publication preview/apply with handoff | [integration](MAGENTO_INTEGRATION.md#reviewed-publication-and-controlled-handoff-h3b) |
| `sv-optional-characteristics.js` | One-off SV template change (2026-10-14) | script header |
| `legacy-answer-recount-batch.js` | Reviewed UI recount + stable recount exposure for an absent answer or truncated weight, ≤50 | [recount batch](RECOUNT_CORRECTIONS.md#reviewed-legacy-answer-recount-batch) |
| `canonical-weight-repair.js` | Reviewed zero-weight repair from the recorded answer or (`--source magento-readback`) Magento `decor_weight` | [weight repair](CANONICAL_WEIGHT_REPAIR.md), [Magento source](CANONICAL_WEIGHT_REPAIR.md#magento-readback-source) |
| `recover-skus.js` | Review and apply the UI stable recount exposure action, ≤50 exact current public SKUs | [reviewed wrappers](#reviewed-operator-wrappers) |
| `names-batch.js` | Review ordinary name resolution from Magento (equal pairs retain Amber), ≤50 products | [reviewed wrappers](#reviewed-operator-wrappers) |
| `scope-from-skus.js` | Resolve exact current public SKUs and materialize a reviewed scope file, ≤100 | [reviewed wrappers](#reviewed-operator-wrappers) |
| `controlled-resync.js` | Record a reviewed broader-resync handoff for the current installation's publication, ≤100 products | [reviewed wrappers](#reviewed-operator-wrappers) |

## Reviewed operator wrappers

These four scripts require an active Administrator, `--actor-id` and an exact
`--expected-database`. Recovery additionally requires `exports.reconcile`; names
require `exports.create`; scope requires `export_templates.view`; controlled resync
requires `export_templates.manage`, `export_templates.publish` and `exports.view`.
The same server authorization services used by the UI enforce these permissions.

Every command requires `--mode preview|apply --input FILE --output NEWFILE`.
Preview uses a dedicated read-only PostgreSQL pool and allows only Magento GETs.
It creates a new JSON review and prints its `planHash`. Review its products, actions
and blockers before apply. Apply takes that exact review as `--input` and the printed
hash as `--plan-hash`; it binds the actor, database target, Magento origin and deployed
code, then lets the existing service revalidate its original review/token. A changed
context or stale service review requires a new preview and operator review.

Input JSON shapes (replace the example SKU, IDs and reason with the intended scope):

```json
{"skus":["EXACT_PUBLIC_SKU"],"reason":"Reviewed recount recovery"}
```

Use this shape for recovery; scope takes only `{"skus":["EXACT_PUBLIC_SKU"]}`.
Names takes `{"items":[{"sku":"EXACT_PUBLIC_SKU","productId":123}]}`; it also
accepts a recovery preview or the old recovery JSONL, selecting only products blocked
by `DURABLE_REMOTE_ID_REQUIRED`. Controlled resync takes
`{"reason":"Reviewed handoff","items":[{"sku":"EXACT_PUBLIC_SKU","productId":123}]}`
or `{"reason":"Reviewed handoff","scopeFiles":["scope.json"]}`. Relative scope
paths resolve beside the input JSON. Missing, ambiguous, retired or duplicate SKUs
fail closed; no partial or silently deduplicated scope is accepted.

For example, inside the container:

```sh
node /app/scripts/recover-skus.js --mode preview --input /tmp/recovery-input.json --output /tmp/recovery-review.json --expected-database DATABASE_NAME --actor-id ACTOR_ID
node /app/scripts/recover-skus.js --mode apply --input /tmp/recovery-review.json --output /tmp/recovery-result.jsonl --expected-database DATABASE_NAME --actor-id ACTOR_ID --plan-hash HASH_FROM_PREVIEW
```

All outputs are created exclusively; an existing path is never overwritten.
Mutating apply writes and flushes its prepared/result journal around service calls,
stops on the first error and never retries automatically. An `unconfirmed` result
requires checking the durable UI/service state before any further action. Recovery
leaves blocked entries unchanged; name resolution can create the ordinary pending
sync request; recovery and controlled resync can record local handoffs. Scope apply
also uses a read-only pool: it rechecks exact SKU identities and creates a new JSON
scope with an embedded completion journal. Keep every review and result file.

## Open follow-ups

- Remove legacy SKU dependencies after the mass sync (see [retain remote](FIRST_SYNC_RETAIN_REMOTE.md)).
- `first-sync-keep-local.js` / `first-sync-retain-remote.js` count an equal-name
  `name_received` receipt as an import; use `--allow-imports` when the preview lists no imports.
- Successor preparation could carry unchanged reviewed category paths instead of
  relying on the sample.
