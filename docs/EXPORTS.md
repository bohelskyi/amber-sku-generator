# Exports

This guide defines current product/price delivery, snapshot and acknowledgment semantics. [Export templates](EXPORT_TEMPLATES.md) owns definition/publication and signed binding; [shared export sessions](SHARED_EXPORT_SESSIONS.md) owns collaboration and durable recovery. Production activation/cutover is complete; the [cutover runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md) remains the procedure for future installations.

## Product CSV retirement

The first direct Amber → Magento UPDATE without CSV succeeded on 2026-09-28 for
`KL3/11131351005`, job `f2253960-527a-40e9-b879-9041bb036453`, with acknowledgement
only after read-after-write verification. See the [Magento receipt and ownership rules](MAGENTO_INTEGRATION.md#achieved-state-2026-09-28).
Legacy Magento product CSV delivery is retired in production. Price CSV export remains a separate supported stream. Historical product snapshots, confirmation and immutable evidence remain valid; the queue/capture contracts below describe compatibility and installations before delivery cutover. This is separate from the migration-040 selector cutover.

Before retirement, reconcile pending product and price queues, generated/downloaded
but unconfirmed snapshots, shared-session attempts/results, and held/replacement
lineages with their actual external disposition. Retain immutable artifacts and
idempotent recovery; a downloaded file may still be imported later. A successful
direct job does not confirm a CSV snapshot, release a hold, advance
`product_full_export_state`/`product_export_revisions` acknowledgements or move the
export cursor. Do not mark old work delivered merely because one same-SKU sync succeeded.
The [automatic workflow](MAGENTO_AUTOMATIC_SYNC.md) is implemented behind its own
default-disabled fresh-install gate. The current production binding review, activation and reconciled export cutover are complete (2026-10-01 operator receipt, PR #19).

Migration 045 supplies that explicit one-way cutover. Successful apply enables
automatic sync for future relevant mutations and permanently rejects creation of
new `magento-products-v1` artifacts. Existing snapshots, files, sessions,
confirmations, cursors and audit evidence remain readable and immutable. The
separate `sku,price` stream is not switched by this product-delivery cutover.

## Test-product retirement

Test-product deletion (050) rejects retained product/price snapshot exposure and
business delivery history. Final `voided` rows are excluded and lifecycle-retired;
no snapshot, artifact, acknowledgment, cursor, reservation or prior sync receipt is
deleted or rewritten. It is a separate Administrator action from ordinary archive.
See [test deletion](MAGENTO_AUTOMATIC_SYNC.md#test-product-deletion).

## Workflow and authority

The operator reviews authoritative current data, explicitly creates an immutable snapshot, downloads stored files and separately confirms the snapshot. Preview/download never acknowledge delivery. Confirmation means local acceptance of the captured export, **not proof of Magento import**. A generated file may already have left the application even when unconfirmed.

`exports.view` permits status, queue/history, preview and stored reads. `exports.create` permits create/confirm and Magento-name changes. Session-linked snapshots additionally require current ownership/accepted membership. Authentication, active-user checks and unsafe-method CSRF apply throughout; see [RBAC](AUTH_RBAC.md). `GET /api/export/csv` remains disabled with `410`.

## Activation and selection

Migration 039 creates the full-product ledger and exact membership. Migration 040 adds the baseline, typed exclusions and `full_product_export_activation`; it initializes the gate to `legacy`, selector version 0. Neither migration accepts inventory, releases exclusions or activates the selector.

| Gate | Product selection and writes |
| --- | --- |
| `legacy` | New selection uses eligible product IDs above the confirmed cursor and the legacy exclusion flag. Recount successors retain their compatibility exclusion, even when their ledger route is normal. New lifecycle-aware snapshots still record exact membership/revisions. |
| `preparing` | Operational freeze and writer-contract enforcement; ordinary business mutations, full-product preview/capture and confirmations are blocked. Auth/health, inventory reads and stored-file access remain available. Read-only price preview is still observational. Only explicit maintenance commands advance cutover. |
| `active` | Selector version 1 uses lifecycle state, eligibility and exact captured revisions. Cursor position no longer removes a pending full-product obligation. Legacy-mapper, template and shared-session capture use the same selection rules. |

The two selection settings are independent: the lifecycle gate selects **products**, while template activation metadata selects a **published definition for opted-in requests**. Activating lifecycle does not silently switch the system mapper to a template.

For an active product without a successor, eligibility requires `exclude_from_export=0`, business policy `none` and no recount compatibility exclusion. Define:

```text
delivery_floor = greatest(confirmed_revision, cutover_baseline_revision,
                          externally_delivered_revision, csv_retired_revision)
pending = revision > delivery_floor
```

`csv_retired_revision` starts at zero for all pre-cutover rows. After the explicit
Magento delivery cutover, a newly created product or later full-payload mutation
advances this floor with its full revision, so it creates only the durable API sync
obligation and no new CSV queue obligation. It is not confirmation, import evidence,
or a rewrite of historical rows.

`externally_delivered_revision` is separate pre-cutover operator evidence: an
authorized operator attested that the exact reviewed Amber revision already had an
exact Magento SKU counterpart after delivery outside Amber. It does not confirm a
snapshot, prove payload equality, claim automatic-sync success or waive any later
revision. Its audit pointer is mandatory. The workflow is available only while the
lifecycle selector is active and Magento-product CSV delivery has not been retired.
A replacement acknowledgement also performs the same route completion invariant as
a genuine replacement confirmation, without changing `confirmed_revision`.

| Queue | Lifecycle-active meaning | Capture |
| --- | --- | --- |
| New | Eligible `normal`, pending, floor 0 | `mode: "new"` resolves all pending first deliveries by product ID, including IDs below the cursor. |
| Update | Eligible `normal`, pending, positive floor | Explicit same-SKU/manual range captures current full payload; `update` is a queue name, not an API capture mode. |
| Replacement | Eligible `replacement`, pending, released by reviewed reconciliation | `mode: "replacement"` binds one `productId` and expected `deliveryVersion`. |
| Held | Active rows with `hold` route, non-`none` business policy or compatibility exclusion | Visible for review; never bypassed by a wider manual range. |

Queue eligibility does not imply Magento readiness. Missing fields or inherited-name review can still prevent capture. Retired sources/archived products cannot be captured again as current products. Manual range allows eligible normal rows, including already acknowledged rows, but excludes held/replacement routes. A replacement must use its explicit single-product selection.

`GET /api/export/status` returns `lifecycle.phase`, generation and `firstDelivery`, `fullUpdate`, `replacementReady`, `held` counts. After activation, `countSinceLastExport` is a compatibility alias for first-delivery count. `GET /api/export/queue?queue=new|update|replacement|hold` requires activation, paginates by product ID using `after`, and defaults to 50 rows (maximum 100).

Requested SKU anchors resolve to product-ID order, not lexicographic SKU order; reversed bounds normalize and an open manual upper bound includes eligible rows at the capture instant. New preview derives its bounds server-side. Legacy-mapper creation sends the returned New anchors; template creation preserves its original caller intent, keeping resolved anchors as separate evidence.

## Full-product revisions and cutover baseline

`product_full_export_state` has one permanent row per product. Ordinary save starts full revision 1, confirmed revision 0 and route `normal`. Recount retires its source and creates a distinct revision-1 successor obligation; archive retires state. Complete-lineage exposure and inherited-name review determine successor routing, as specified in [recount/corrections](RECOUNT_CORRECTIONS.md#successor-routing-and-name-inheritance).

Successful allowed informational/name edits advance full `revision` in the product/audit transaction. Price-only direct/request edits advance only the separate price stream. `delivery_version` tracks reviewed routing/policy/name-review changes. Rejected/no-op/rolled-back writes advance neither counter.

`cutover_baseline_revision` is a one-time preparing-only, audited business acceptance of ordinary legacy inventory. It is bounded by current revision and paired with a `product.full_export_baselined` event. It does **not** increase `confirmed_revision`, establish exact historical payload equality, manufacture snapshot exposure or prove import. Baseline revision 1 followed by an information edit to revision 2 is Update; a never-acknowledged product edited from 1/0 to 2/0 remains New. Production counts come only from fresh manifests, not rehearsal tables.

## Exact immutable capture

`export_snapshots` stores the compatibility CSV, request identity and immutable provenance. `magento_export_artifacts` stores exact per-group Magento bytes. Every modern snapshot has `full_product_lifecycle_version=1` and `export_snapshot_products` membership: one member per represented product, even though its Magento artifact contains Main and EN rows.

Full-product members bind exact product ID/SKU, full revision, delivery version, `capture_kind=full_product`, `evidence_origin=live_capture` and a SHA-256 evidence hash. The service parses actual internal/artifact CSV and verifies exact membership, group, row shape and counts before insertion. Snapshot, artifacts, membership, price exposure and audit commit or roll back together. Membership and artifacts reject UPDATE/DELETE/TRUNCATE; snapshot payload/provenance cannot be rewritten. `full_product_selection` additionally freezes mode, captured route/counters and gate generation.

Migration 046 leaves `sku_at_capture` with its historical internal-SKU meaning and adds `identity_contract=1`, `internal_sku_at_capture` and `public_sku_at_capture` for future lifecycle-aware membership. New evidence therefore retains both the stable external identity and the exact configuration revision identity. Historical membership rows keep the additive fields null, and no stored CSV/artifact is rewritten.

After activation, capture fails closed if any represented SKU is duplicated anywhere in products or its permanent registry reservation points to another product. This includes one-product manual selection. Cutover baseline acceptance does not repair historical duplicate SKUs; it retains diagnostics for separate data-quality work. No rename, merge or reuse is automatic.

Internal-only compatibility snapshots use `capture_kind=legacy_compatibility` and null full/delivery counters, so they cannot acknowledge a full revision. The operator UI does not offer that profile. New active-gate creation requires Magento preview evidence, so `internal-legacy` is a pre-activation compatibility creation path; authorized existing snapshots remain readable/retryable.

## Preview, idempotency and concurrency

Full preview uses a repeatable-read read-only transaction and evaluates all represented products. Any not-ready product prevents the complete capture; there is no silent partial export. The review/table fingerprint binds authoritative inputs and lifecycle selection. In the active gate, a new system-mapper capture must send the returned `previewExpectation`; template capture requires the signed `previewToken` and unchanged original intent. Missing evidence is `EXPORT_PREVIEW_REQUIRED`; changed evidence requires a fresh review. Product readiness is never trusted to React.

`POST /api/export/snapshots` requires a nonempty idempotency key, at most 200 characters, through `Idempotency-Key` or `body.idempotencyKey`. A matching completed key returns the original stored result, attribution and bytes. Changed contract/profile/range or template intent/binding conflicts; replacement retries bind the exact product/version. Completed reuse never silently selects a successor or regenerates from current data. Tokens and keys are not authorization.

Capture preserves current access/session boundaries, the shared lifecycle gate acquired before BEGIN, per-key coordination, template selection when applicable, ascending product locks, ascending full-state locks, ascending price revisions and finally New cursor locking. Parent/artifacts/members/audit and session result links share one transaction. A lock wait does not refresh an old repeatable-read view: a stale/serialization/idempotency race rolls back before a fresh committed winner lookup. Callers retain the original uncertain operation for retry rather than inventing a new key.

## Confirmation and cursor

`POST /api/export/snapshots/:id/confirm` locks snapshot → ascending full state → ascending price revisions → cursor; it never locks products after lifecycle rows. It validates exact membership and advances each captured full revision using `GREATEST`. Confirming N after an edit to N+1 leaves N+1 pending. A predecessor membership never acknowledges its successor; retirement after generation does not invalidate acknowledgment of that stored file or revive the source.

When confirmation advances the captured revision of a still-matching replacement delivery version, it changes route to `normal` and advances delivery version. Later payload edits use Update. Older delivery evidence cannot silently release a changed route/hold. Repeat/out-of-order confirmations preserve monotonic counters and the first confirmer; only the first confirmation adds its audit event.

The singleton cursor still advances with `GREATEST(exported_to_product_id)` and never rewinds. After activation it is a compatibility/history watermark, **not the sole acknowledgment authority**. Omitted low-ID products stay pending through their lifecycle rows. `last_snapshot_id` follows the non-regressing cursor; legacy `export_events` remain status compatibility evidence.

## Historical snapshots and evidence

Pre-lifecycle snapshots retain null lifecycle provenance, immutable original bytes and their historical confirmation behavior. They are never regenerated from today's products/templates. Historical snapshots without Magento artifacts remain without them; unknown actors/provenance remain unknown.

Historical indexing verifies stored CSV/hash/exact SKU evidence and adds immutable compatibility sidecars with `evidence_origin=verified_stored_csv`, null full/delivery counters and actual recording time. These prove retained representation, not current payload equality or Magento import. Confirming an old snapshot cannot acknowledge a modern full revision or release a generated-only hold. Missing evidence, cursor position and price-exposure flags do not by themselves prove a lineage unexposed.

## Reconciliation and exclusion provenance

`business_exclusion_state` is `unknown`, `none` or `excluded`; `recount_compatibility_excluded` records the separate legacy recount policy. At active commit the product flag projects retirement, business policy and compatibility policy. A lifecycle hold is an additional delivery gate, not invented independent exclusion intent.

Backend cutover/reconciliation tooling is implemented and requires explicit operator decisions. Mutation commands recheck `exports.reconcile`, current evidence, product/lineage locks, expected delivery version and a unique resolution key; audited changes are atomic and identical retries do not repeat them. No HTTP hold-release workflow exists.

- `unexposed_first_delivery` requires reliably unexposed retained evidence and explicit recount-only attestation for unknown policy, or a release decision for known independent exclusion. Missing inherited names may be restored exactly with required review.
- `generated_first_delivery` requires an ordinary held product, exact retained-file exposure and explicit redelivery authorization. It returns to normal first delivery without fabricated confirmation.
- `replacement` requires a held terminal successor, all old-SKU/file dispositions, resolution of ambiguous external history and release of unknown/independent exclusions where applicable.

The typed business-exclusion command records a reviewed policy decision but does not clear a lifecycle hold or compatibility bit. Operator assertions cannot recall downloaded files. Fresh review/attestation and command fields belong to the [runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md); production cutover does not automatically resolve historical data-quality cases.

## Magento readiness and names

The system `magento-products-v1` mapper writes BR, NM, KL, CH, AR and SV group files; Stone souvenirs (`souvenir=5`) use the Камінь attribute set inside SV. Each product has a full Main row and a sparse EN row with the same attribute set. The mapper reads stored semantic answer IDs and final stored UAH price, not mutable option labels or SKU-decoded characteristics. KL dimensions use `pedant_size`, then legacy `exact_size`. CH length/diameter numeric fields accept decimal commas/dots and emit dots; `rozmir_kameniu` retains its established formatting. Invalid required/mapped inputs fail readiness. Historical calibration `3` is outside this payload; its remediation is separate.

The system profile has fixed ordered group headers in [the mapper](../server/src/services/magento-products-v1.js), with independent [synthetic fixture coverage](../server/test/fixtures/magento-v1/README.md). Constants include `product_type=simple`, website `base`, `product_online=2`, `Catalog, Search`, quantity/stock 1, `old_product=No` and `is_ownproduction=Yes`. Main has blank `store_view_code`; EN includes SKU, store view, name, product type, attribute set and defined EN SEO fields. Descriptions and undefined optional SEO stay blank; category paths are comma-separated. Editable published definitions use their own immutable output contract.

The internal compatibility CSV stores SKU, final UAH (including exact manual decimals), a derived bracelet/necklace size and configured free-text fields. Its existence does not substitute for qualifying Magento full-product membership or change readiness rules.

Souvenirs without an approved automatic name need a saved UA/EN manual subject pair. The pair takes precedence; final text is `{UA subject} з бурштину. Арт: {sku}` and `Amber {EN subject}. Art: {sku}`. Export reads saved subjects only. Missing names are never invented from an old SKU.

`magento_name_review_required` blocks readiness in both system and template evaluators, including draft/published/session review. `POST /api/product-magento-name/preview` with only `productId` reads the current pair and unchanged-review eligibility/token. Edited-name preview uses `subjectUa`/`subjectEn`; `/apply` rechecks the reviewed token under product → full-state locks. Explicit `confirmUnchanged: true` uses the exact displayed pair/token, clears pending review, advances delivery version and emits `product_magento_name.reviewed` without increasing payload revision. Changed text increases full revision and emits `.updated`; clearing review also advances delivery version. Ordinary unchanged writes remain rejected; stale evidence returns `STALE_MAGENTO_NAME`. Audit failure rolls everything back.

Optional server-only `GOOGLE_TRANSLATION_API_KEY` enables an editable EN suggestion via `POST /api/product-magento-name/suggest`. Without it, status reports `translationSuggestionAvailable=false`, direct suggestion returns `503 TRANSLATION_NOT_CONFIGURED`, and manual entry remains available. The key goes to Google Translation v2 Basic in a header, never the browser or URL. Suggestions save nothing and export never calls translation.

## Separate price stream

`product_export_revisions` tracks coalescing in-place price changes independently of full-product revision. Direct and request-completed price changes advance it atomically with product/audit writes; pending requests do not mutate products or either export stream. Price-only changes never move the full-product cursor or create a full payload revision.

Dedicated `price_export_snapshots` contain exactly `sku,price`, using final stored UAH. Eligibility requires `has_product_snapshot=true`, a pending price revision and exclusion flag 0. Full snapshot generation can establish exposure; generation alone does not confirm captured revisions. Initial full confirmation can consume its captured initial price evidence, while after established exposure dedicated price snapshots consume price revisions. An older full/price confirmation cannot clear a newer price change.

For snapshots generated after migration 046, the dedicated `sku,price` stream writes the stable public SKU because that file identifies the Magento product. Its captured revision evidence records product ID, exact internal/configuration SKU and public SKU. Historical price files remain byte-for-byte unchanged.

Price creation captures the current eligible queue, with no range/template or product cursor change. Excluded pending rows are reported separately without losing their revision. Price confirmation advances only captured revisions with `GREATEST`, preserving first attribution and idempotency. A duplicate price update is preferable to losing a change while initial full exposure remains unconfirmed.

The UI separates review → create → stored read/download → explicit price confirmation. Price preview has no reservation/token protocol; create rechecks the queue. A changed stored result is shown before confirmation. Generated files can be reopened from history without recapture.

## Read APIs and review

`GET /export/status` exposes only two delivery-state flags: `delivery.legacyProductCsvEnabled` and `delivery.automaticSyncEnabled`. The UI hides new product CSV creation when the legacy flag is false or status is unavailable, while retaining stored artifacts, history, and the separate price stream. An uncertain original generation command retains its original retry identity; the server remains authoritative for cutover and recovery checks. Disabling automatic sync after cutover does not reopen product CSV creation.

| Endpoint under `/api` | Meaning |
| --- | --- |
| `POST /export/preview` | Authoritative current product review; no durable capture or acknowledgment. |
| `GET /export/snapshots/:id?includeRows=false` | Stored manifest/provenance and artifact metadata without CSV bodies; omission retains the compatibility response. |
| `GET /export/snapshots/:id/magento/:group/csv` | Exact stored group bytes. |
| `GET /export/snapshots/:id/csv` | Stored internal compatibility CSV. |
| `GET /price-export/status`, `GET /price-export/preview` | Current price counts and finalized current `sku,price` review. |
| `GET /price-export/snapshots/:id`, `GET /price-export/snapshots/:id/csv` | Stored price metadata/bytes. |
| `GET /export/history` | Authorized product and price snapshot history. |

History accepts `stream=all|product|price`, `scope=accessible|mine`, `status=all|generated|confirmed`, `limit` (20 default, 50 maximum) and an opaque `after` cursor bound to filters. It orders by immutable generation time descending, ID descending, then stream, retaining microseconds. `mine` is actual creator ID; null historical creators remain unknown. Private session results require owner/accepted membership, with no Administrator bypass. Reads never confirm, audit success or advance state.

The export landing prioritizes the independent price stream, own/shared workspaces,
invitations and stored file history. Product-CSV creation remains gated by the
authoritative delivery flag; retired creation never hides historical files or an
uncertain original operation. Status reads occur while an export route is visible,
without remounting the principal-scoped workflow provider. Product and price read
failures remain independent; unavailable counts are not presented as zero.

History renders one 20-item page at a time with filter-bound server cursors in the
URL and browser-back context. The table identifies time, stream/state, volume and
author; IDs and provenance are disclosed on demand. Confirmation receipts distinguish
successful local acknowledgement from Magento delivery. A failed metadata refresh
after a successful confirmation does not turn that confirmation into a failed write.

The review projection is `export-review-v1`, keyed by table fingerprint, with exact headers, product identity, Main/EN ordinal, readiness/issues and header-aligned cells. Cells distinguish finalized value, intentional blank, provisional failed-product output and not-evaluated output. Failed-only groups remain visible; diagnostic values never authorize partial capture. Lazy evaluation and the 64 MiB output ceiling remain authoritative; there is no silent truncation or automatic range splitting.

The client renders one complete server review in local 50-row pages. Search, category/attention/language filters and widths change presentation only. Successful export-origin product/name corrections obtain a fresh read while preserving display context; they never replace an uncertain original generation attempt. Stored tables read immutable CSV, not current preview. Current warnings may identify a represented product subsequently retired/corrected without modifying its artifact.

CSV serialization quotes commas, quotes and line breaks. String formula sigils `=`, `+`, `-`, `@` after leading spaces, tabs or carriage returns receive an apostrophe. The actual regex does not cover every Unicode whitespace character or a leading line feed; do not claim universal spreadsheet protection. This documentation change does not alter serialization.

## Acceptance boundary

The [2026-09-23 six-group Check Data record](archive/exports/MAGENTO_CHECK_DATA_2026-09-23.md) is historical validation, not an import receipt or acceptance of every later template. Target catalog/source mappings, template publications and real Magento acceptance remain deployment-specific. Direct Magento CLI sync has durable job/verification history; the automatic workflow is active in production (disabled by default on fresh installations). Explicit `url_key` generation, attribute/option API synchronization and automated CSV import/result reconciliation remain unimplemented. Production historical collision/delivery cutover is complete; future unapproved data/mapping cases remain separate work. See the [current pending-work index](README.md#deferred-work-and-operationally-pending-items).
