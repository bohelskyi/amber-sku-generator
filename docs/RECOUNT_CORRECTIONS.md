# Recount and corrections

## Recount target validation

Recount starts from a decoded, existing, active, uncorrected product and always targets the category's current active SKU schema. Submitted answers are a patch:

- omitted keys inherit stored/historical values;
- explicit `null`, `undefined`, or blank clears the named answer;
- numeric `0` is preserved as real data, including calibration state `0` and configured zero options.

For an existing SV product projected as `stored_history`, an absent stored
`stone_processing` answer with a null decoded placeholder remains absent in the
recount source context and form. It must not preselect the real semantic option
`0` or make an explicit operator selection of `0` look unchanged. This scoped
repair uses ordinary target validation and reviewed recount preview/apply; it
does not infer answers from labels or internal SKU text. Existing genuine zero
answers and other placeholder behavior are unchanged. See the
[missing-processing investigation](archive/implementation/MAGENTO_SV_PROCESSING_2026-10-03.md).

After merging the patch and before target preview/validation, `omitHiddenRecountAnswers()` removes inherited answers for questions in the published target SKU schema that are hidden (inactive under the target visibility rules). This applies to old placeholders and previously valid values. Corrected product details must not retain those obsolete SKU answers. A visible field with an invalid/archived option still fails validation; the cleanup is not a general option-removal shortcut.

Questions visible in the target remain required and validated normally. This cleanup is recount/correction-specific and must not weaken new-product validation or introduce historical placeholders as active options. The helper currently receives published SKU-schema questions, not live non-SKU metadata; broadening that scope is a separate behavior change requiring a reproduced case and tests.

Preview requires an actual answer change and computes the proposed corrected SKU and price. Missing automatic pricing can be resolved only by an independently validated positive manual UAH price.

When the submitted answers, calibration state, and weight do not change, recount remains invalid. A user with `products.price_change` may instead use the separate in-place product price-change workflow. It does not call or relax `applyProductRecount()`.

Changing only an informational answer through normal recount still creates a successor variation because the original SKU is permanently reserved. Magento metadata completion therefore uses `POST /api/product-information/preview` and `/apply`, both guarded by `products.recount`. The server allows only versioned fields `BR.braclet_size`, `NM.neckle_size`, `KL.exact_size`, `CH.bead_length`, `CH.bead_width`, `CH.rosary_length`, and `SV.size`. `AR.attach` is unrelated to Magento v1. `SV.weight` is a pricing axis and cannot be changed by this command. Dynamic catalog checks reject a field if it becomes SKU-defining, invisible, or referenced by pricing, modifiers, or visibility rules.

Informational apply locks the active source product, rejects an active correction request or stale preview token, validates the changed fields, and writes only `details.answers` on the product. Other historically missing fields may remain incomplete. The same transaction advances the separate full-product revision and includes one durable `product_information.updated` audit event with old/new values. Product ID, SKU, weight, calibration (including legacy `3`), schema, price, SKU reservation, correction history, price-export revision, and export exclusion are unchanged. Existing price and repricing previews become stale through their complete product-state signatures. The client uses the existing recount form as a presentation hint, but the two server commands remain separate. Mixed/SKU/weight/calibration changes continue through normal recount.

### SV saved-weight representation repair

`node scripts/sv-readiness-repair.js --expected-database NAME --binding-revision UUID --output NEW_PLAN.json`
is a bounded read-only preview of at most 1,000 active/current SV rows. The only repair is an existing positive
`details.answers.weight` string matching `digits,digits` to the exact same digits with a decimal point.
This is not a weight-entry command: absent answers, physical `products.weight`, names, dimensions and semantic
options are never inferred or copied from Magento. The frozen evaluator and normal product validation are unchanged.

The plan binds the exact stored answer, complete product/lifecycle/identity evidence, binding counter, template,
current weight-question metadata and pricing context. It re-evaluates the target, requires the weight error to
disappear without changing other errors, and rejects changed pricing results. Other readiness failures remain explicit.
Duplicate SKU identity, mismatched reservation, correction lineage or an active correction request blocks repair.

`node scripts/sv-readiness-repair.js --apply --expected-database NAME --plan REVIEWED_PLAN.json --expected-hash SHA256 --actor-user-id ID --output NEW_RECEIPT_DIRECTORY`
requires both `exports.reconcile` and `products.recount`, rechecked inside each product transaction. Product/lifecycle
locks and complete evidence CAS reject stale plans. Apply re-reads and evaluates the persisted target, advances only
its full-product content revision, and writes an atomic immutable audit receipt. Prices, SKU, reservations, exclusions,
delivery acknowledgements, snapshots and cursors are preserved. No Magento client is used. Each outcome is checkpointed
to a durable summary; a same-plan retry skips committed receipts, while a fresh preview excludes normalized rows.
An error never credits a different row. No startup, HTTP or automatic repair hook exists.

## Direct apply

Recount apply is one authoritative transaction that:

1. locks and rechecks the source row and state signature;
2. rebuilds target preview and pricing;
3. validates automatic/manual final pricing;
4. blocks apply when an active correction request owns the source;
5. serializes and reserves the corrected SKU or next variation;
6. inserts the new active product and detailed `product_corrections` history record;
7. marks the source corrected and links both records;
8. retires source full-product delivery state and inserts the successor's independent revision 1, name inheritance/review state and evidence-based route before audit/commit.

The source is permanently retired/excluded. Before lifecycle activation, the successor retains the legacy compatibility exclusion. After activation, a reliably unexposed successor with business policy `none` is eligible for New; exposed/ambiguous or independently excluded successors remain held. A hold and a business exclusion have distinct meanings. Preserve the transaction, lock order and final evidence validation; see [export selection](EXPORTS.md#activation-and-selection).

Successful direct apply and correction-request completion use the authenticated local application user as `product_corrections.performed_by_user_id` and as the successor product's `products.created_by_user_id`. They append one semantic `product.recounted` durable audit event in the same transaction. Its concise details link the source and corrected product/SKU plus the detailed correction row and optional correction request; the existing old/new recount payload is not duplicated into `audit_events`. Historical product/correction rows remain `NULL` and no historical events are synthesized.

Migration 046 does not change target validation or correction ownership. Before stable-public-SKU activation, recount retains legacy behavior and the successor receives a distinct legacy public identity equal to its new internal `full_sku`; installing the schema alone therefore does not change external delivery identity. After activation, the successor still receives a new immutable internal `full_sku`, while the database insert trigger requires it to inherit the source row's `public_product_identity_id`. Source retirement and successor creation may temporarily coexist inside the transaction; the deferred one-current-revision invariant validates the final state at commit. Thus the product article is stable across post-activation recount, and later Magento delivery is an UPDATE of that public SKU. Lineage, audit and history continue to use correction rows/product IDs, not every row sharing the public identity.

Direct apply requires `products.recount`; recount preview accepts either `products.recount` or `corrections.create`. Correction-request creation still requires `corrections.create`. Request-only custom USD-per-gram or exact manual UAH decisions require `corrections.price_override`; authorized direct recount uses `products.recount` with its own reviewed decision token. The product UI defaults to direct recount for users with `products.recount`, including users who also hold `corrections.create`, and hides the legacy request shortcut. Users holding only `corrections.create` retain the “Підготувати запит” workflow. Compatibility routes remain available and built-in role permissions are unchanged.

## Successor routing and name inheritance

Migration 039 and `full-product-export.service.js` add durable full-product obligations. Ordinary save creates revision 1, confirmed revision 0 and route `normal` in the product/SKU/audit transaction. Recount creates a separate successor obligation and retires the source. Archive also retires its state. A lifecycle failure rolls back the complete mutation, including reservations, correction history, request finalization and audit.

Recount classifies the complete ancestor chain through the historical evidence parser/lineage graph and exact new snapshot membership. Reliably unexposed lifecycle-born ancestry yields `normal`; generated or confirmed exposure yields `hold/prior_exposure`; unresolved history yields `hold/historical_ambiguity`. Independent exclusion and invalid lineage have explicit hold reasons. Migration-baseline history does not become reliably unexposed from cursor position or missing price-exposure flags. Recount-created exclusion on an intermediate successor is distinguished from an independent exclusion.

Both structured Magento subjects and the exact full-name override are inherited without invented names. Modern recount sets no inherited-name review requirement. A changed generated full-name pair invalidates an inherited override; shared-authority reconciliation then compares both sides with the last confirmed common baseline before delivery. The explicit target and inherited source-name evidence remain bound by the recount signature.

The recount-specific source signature now includes both exact subjects, review state and exclusion. The generic product signature keeps its previous meaning. Direct apply must send `sourceStateSignature` from the accepted preview; the client does so. Missing/stale proof returns 409 and requires a new preview. Locked source state is revalidated before copying names. Existing recount/request preview signatures may require refresh; they are not silently accepted under the new binding.

Direct apply and request completion use the same evidence derivation and recount transaction. Their parity and refresh requirements are specified below. Lifecycle selection is implemented behind the activation gate; production cutover remains an operator task, not a missing implementation phase.

## In-place product price changes

`POST /api/product-price-change/preview` and `POST /api/product-price-change/apply` both require `products.price_change`. They accept `system_auto`, `manual_uah`, and `usd_per_gram`; the client keeps Manual UAH selected by default. Automatic mode has no override fields or separate rounding choice: it recalculates from the existing product's stored configuration and weight using current authoritative pricing and the category's automatic marketing-rounding setting. An unavailable automatic result is reported explicitly and cannot be applied. Manual UAH uses the existing positive, finite, two-decimal validation and an explicit marketing-rounding choice that defaults off in the client. USD/gram uses the existing positive, finite, four-decimal validation and its existing explicit marketing-rounding choice; the server calculates final UAH from the product's stored authoritative weight and the authoritative exchange-rate provider.

Apply locks and reloads the active, uncorrected product row, rejects an active correction request, recalculates pricing inside the transaction, and verifies the opaque preview token against the complete product pricing state and mode-specific dependencies. Concurrent product/repricing updates therefore stale the preview. An unchanged effective final UAH price is rejected. Active repricing drafts do not block the command; the changed complete product state makes their prior tokens stale and draft synchronization reports the change.

The update changes only `total_price`, `total_price_uah`, `price_per_gram`, `uah_rate`, and the pricing-related portions of `details`. Product ID, SKU, SKU reservation/sequence state, weight, answers, schema version, status, and correction lineage remain unchanged. A `product.price_changed` audit event is inserted in the same transaction with immutable actor/time attribution, the normalized decision, and complete old/new pricing evidence. The same transaction advances the product's pending export revision. Audit or revision-write failure rolls back the product update.

The three modes retain the field meanings and rounding rules in [Pricing](PRICING.md#automatic-and-manual-uah-pricing). No price-only operation increments full-product payload revision.

## Correction requests

Correction requests move through `pending`, `in_progress`, `completed`, and `rejected`. A partial unique index permits only one active request per source. Active requests block competing direct correction and repricing.

Every new request stores its pricing mode, including requests from older clients that omit `pricingDecision`. Those requests become `system_auto`, or `manual_uah` with origin `automatic_unavailable_fallback` when the accepted legacy manual field supplies a missing automatic price. System automatic mode uses the normal matrix, modifiers, category rounding, and full pricing-context binding. Custom USD-per-gram mode multiplies the stored positive USD/gram value by target weight and the current authoritative USD/UAH rate, applying only the stored explicit rounding choice. Exact manual UAH mode stores a positive final UAH amount without rounding or an exchange-rate dependency and retains any available automatic result as its history baseline. Processors can view but cannot replace the decision. Only pre-feature rows retain their NULL pricing mode; pending recount requests without current evidence require refresh before completion, including rows with legacy pricing signatures.

Signatures bind source/proposed state and mode-specific price dependencies. Refresh recalculates the proposed result; claim retains its existing post-commit refresh. Completion rejects a real dependency change even when it produces the same final rounded amount. Completion uses the same transactional recount application, stores the final payload, and attempts to synchronize affected repricing drafts.

## Application-user claim workflow

Claiming is atomic; concurrent attempts yield one owner. New claims set `claimed_by_user_id` to the authenticated local application user and advance `claim_version`. They do not create or return a browser capability secret. The authenticated owner can therefore continue the request from another browser or workstation by using the current claim version.

Claims do not expire automatically. Current ownership rules are:

- claim and ordinary release require `corrections.claim`;
- refresh and complete require `corrections.complete`, the matching authenticated owner, and the current claim version;
- reject/reopen require `corrections.reject`; rejecting an in-progress request also requires the matching authenticated owner and current claim version;
- Administrator receives no implicit ordinary-owner bypass;
- confirmed force-release requires `corrections.force_release`, deliberately bypasses ownership, clears the owner, advances the claim version, and returns the request to pending;
- disabling or demoting an owner does not release the request.

Owner release clears ownership, returns the request to pending, and advances the claim version. Completion and in-progress rejection also clear ownership and advance the version, so an operation from an earlier claim cannot succeed after release/reclaim.

Migration `025` leaves existing token columns in place. A token is considered only for an in-progress row whose `claimed_by_user_id` is still null. Its matching legacy token may authorize one successful owner operation, atomically adopting the claim for the authenticated user; once user ownership exists, any retained token is ignored. Historical creator and owner columns remain null rather than being guessed, and pre-claim legacy in-progress rows with neither owner nor token remain claimable through the existing compatibility path.

The client queue loads immediately, polls every five seconds only while visible, refreshes on focus/visibility return, prevents overlapping polls, and prevents an older response from replacing newer state.

### Operator queue and bounded reads

The local application redesign groups `/admin/corrections` under **Потребує уваги**.
The queue defaults to active work and shows a compact list beside one selected
request, its ownership, proposed changes, and permitted actions. `?request=ID`
continues to open exact request evidence, including an item outside the visible
page. The UI displays public `sourceArticle`/`proposedArticle` separately from
internal SKU evidence; missing public evidence is never replaced by internal SKU.

`GET /api/admin/correction-requests/page` requires `corrections.view` and returns
`items`, global status `summary`, and filtered `pageInfo`. It defaults to 40 rows,
caps at 100, and accepts `offset`, status, literal article/internal-SKU/comment
search, and the existing owner/legacy-claim workspace filter. The current queue
requests 30 rows. Counts are server aggregates, not visible-page estimates; missing
or failed evidence is shown as unavailable. `workspaceIds` is a bounded compatibility
filter, not an ownership credential. Every command still rechecks actual ownership.

`GET /api/admin/correction-requests/:requestId` has the same view permission and
returns exact detail or 404. The original list endpoint remains available with
its default 300/max 1000 and historical wildcard search behavior. Both read shapes
retain older identity fields and add explicitly named public-article fields.
These reads do not claim, refresh, complete, audit a mutation, or call Magento.

Completion reviews the captured request/claim version. Polling cannot silently
replace that reviewed evidence; changed evidence closes the review and requires
inspection again. The completion receipt means the change committed in Amber;
Magento delivery is a separate fact. A failed follow-up queue refresh does not
turn an already successful command into a failed command or invite resubmission.

## Initial built-in role permissions

| Role | Correction behavior |
| --- | --- |
| Administrator | View, create, claim/release, refresh/complete, reject/reopen, and force-release. Also direct recount. |
| Manager | View and create, including the initial custom-pricing permission; reject/reopen. Cannot claim/release, refresh/complete, force-release, or directly apply recount. UI is monitoring/request-oriented. |
| Storekeeper | View, create, claim/release, refresh/complete, reject/reopen, and direct recount. Cannot force-release. |

Manager and Storekeeper permissions are Administrator-editable, so this table describes initial built-in mappings, not a deployed user's current access. Server permission checks remain authoritative; client controls are hidden from effective `/api/auth/me` permission keys only.

## Product timeline and configuration evolution

`GET /api/product-timeline` reads a product's correction lineage and returns historical events plus `configurationEvolution`. The latter presents the initial recorded configuration and later answer-changing configurations, with a changes-only view and a full-state view in the client. It uses stored product/correction evidence and historical SKU schemas; it does not infer unrecorded values from today's catalog. Ambiguous lineage or insufficient/conflicting historical evidence is reported as `partial` or `unavailable` with warnings rather than shown as certain history.

In-place price changes appear as `product.price_changed` events with old/new prices and an empty configuration-change list. They neither add a product to correction lineage nor create a configuration-evolution snapshot.

## Attribution and audit

Correction requests record nullable `created_by_user_id` and current `claimed_by_user_id` references to local application users. Historical rows are not backfilled. Create, claim/adopt, release, force-release, reject, reopen, and complete write concise immutable audit events in the same transaction as the lifecycle mutation. Completion also retains the authoritative detailed recount record and semantic `product.recounted` event without copying its large payload into the correction lifecycle event.

## Price-change requests

`correction_requests.request_type` distinguishes `recount` from `price_change`; omitted API values remain recount for compatibility. Price requests reuse the same active-request uniqueness, ownership, claim epoch, refresh, release, reject/reopen, and idempotent completion lifecycle. They retain one SKU, store no characteristic changes, and never create a corrected product. Pending requests do not mutate products, audits for product changes, or export revisions. Refresh replays the stored pricing mode against current authoritative product/rate/configuration dependencies without fallback. Completion verifies the stored preview again and calls the same transactional in-place price-change primitive as direct apply, so product, request, price-export revision, and audit commit or roll back together.

## Request parity and stale evidence

`product/recount-evidence.js` is the common delivery/name derivation for direct preview/apply and request creation/refresh/completion. Public recount previews use one repeatable-read, read-only transaction. New/refreshed `proposed_payload.recountEvidence` has `version: 5` and binds the stable public-SKU activation state alongside the source product/name signature, complete lineage links, ancestor lifecycle revision/confirmation/delivery counters and routing evidence, exposure classification, expected successor route/hold reason, the explicit target category/schema/answers/weight, inherited UA/EN subjects, the exact effective source/successor names, the published name template identity and the durable shared-name state. Explicit full-name edits are optional, permission-gated and saved atomically as a successor override; subjects and the common baseline remain unchanged. Shared-name drift after preview requires refresh, including drift during locked apply. Recount no longer requires inherited-name confirmation; shared-authority name reconciliation owns remote name safety. The opaque `source.stateSignature` covers this complete binding, so activation between review and apply/complete requires refresh. Direct apply still sends that same field; no client-calculated route is accepted.

Creation revalidates its accepted preview after locking the source. Refresh locks source product → request → ascending lifecycle state, checks the current claim epoch, then rebuilds target/pricing/inheritance/delivery evidence on that transaction's connection. It stores fresh evidence without creating a successor, advancing revisions, changing exclusions or mutating export state. Claim still commits before its existing automatic refresh; failed post-claim refresh retains the existing release behavior.

The additive request `delivery` projection contains `route`, `holdReason`, `exposure` and `nameReviewRequired`. The queue presents concise human descriptions without displaying raw evidence. An old active recount request without current version-5 evidence returns `refreshRequired: true`; completion rejects it with HTTP 409 `RECOUNT_REFRESH_REQUIRED` and `details: {type: "stale_correction_request", refreshRequired: true}`. There is no legacy-signature fallback that infers delivery. Authoritative refresh upgrades only the pending request evidence. NULL historical pricing modes, one-time token adoption, owner identity, claim versions and release/reclaim rules remain intact. Completed requests take the existing idempotent historical/actor-epoch path before any new evidence requirement.

Completion invokes `applyProductRecount()`. It checks the stored signature, locks source → existing SKU resources → request → ascending lifecycle state, re-reads exposure after lifecycle lock waits, and rejects changed reviewed evidence before product writes. Source retirement, successor revision 1/route, paired names/review flag, correction history, request completion and both existing semantic audits share one transaction. A generated snapshot or confirmation winning a race now requires fresh recount evidence rather than silently changing the reviewed delivery outcome. Existing repricing-draft synchronization remains best effort **after commit**, as documented in `REPRICING.md`; it cannot undo a successful recount.

Informational edits keep the exact existing allowlist and active-request prohibition. Their version-2 preview token also binds full revision and delivery version. A successful allowed answer mutation increments full revision in the product/audit transaction; no-op, invalid, stale or rolled-back edits do not. Name changes similarly increment full revision, clear pending inherited-name review, and advance delivery version when that review state changes. Both paths preserve confirmed revision, identity, exclusion, correction lineage and the dedicated price stream. Full revision 1/confirmed 0 becomes 2/0 before first confirmation; 1/1 becomes 2/1 afterward. Price-only direct/request changes still advance only `product_export_revisions`.

The legacy inherited-name preview/apply endpoints remain available for existing evidence and workflows. Modern recount does not set this review flag. [Shared-authority name reconciliation](MAGENTO_AUTOMATIC_SYNC.md#shared-authority-product-names) compares exact full names against confirmed common evidence.

## Historical repair and deployment boundary

Historical indexing, manifest approval, bounded cutover batches, activation and reviewed reconciliation are implemented. They do not bypass target validation, request ownership or permanent SKU reservation. Unknown exclusion provenance and ambiguous lineage remain held until explicitly resolved; accepting ordinary legacy inventory as a cutover baseline does not release successor holds or repair duplicate SKUs.

Use [Exports](EXPORTS.md#reconciliation-and-exclusion-provenance) for delivery/typed exclusion rules and the [cutover runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md) for fresh manifests, operator attestations and activation. Production cutover is complete (Wave 1 operator receipt); fresh-install and later reconciliation approvals remain separate. Historical phase results remain in the [correctness plan](archive/exports/RECOUNT_EXPORT_CORRECTNESS_PLAN.md).

## Direct recount pricing

Authorized `products.recount` users may choose the existing `system_auto`, `manual_uah`, or `usd_per_gram` decision even when automatic pricing exists. Preview returns an opaque decision token; apply normalizes the decision and checks that token, source signature, target, and current authoritative calculation again inside the locked transaction. React never supplies a trusted calculated price. Request-only custom pricing still requires `corrections.price_override`; no role grants change. Missing automatic pricing requires a valid explicit supported decision. USD/gram persists the existing custom basis and rounding semantics.
