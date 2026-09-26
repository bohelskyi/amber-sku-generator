# Recount and corrections

## Recount target validation

Recount starts from a decoded, existing, active, uncorrected product and always targets the category's current active SKU schema. Submitted answers are a patch:

- omitted keys inherit stored/historical values;
- explicit `null`, `undefined`, or blank clears the named answer;
- numeric `0` is preserved as real data, including calibration state `0` and configured zero options.

After merging the patch and before target preview/validation, `omitHiddenRecountAnswers()` removes inherited answers for questions in the published target SKU schema that are hidden or inactive in the target configuration. This applies to old placeholders and previously valid values. Corrected product details must not retain those obsolete SKU answers.

Questions visible in the target remain required and validated normally. This cleanup is recount/correction-specific and must not weaken new-product validation or introduce historical placeholders as active options. The helper currently receives published SKU-schema questions, not live non-SKU metadata; broadening that scope is a separate behavior change requiring a reproduced case and tests.

Preview requires an actual answer change and computes the proposed corrected SKU and price. Missing automatic pricing can be resolved only by an independently validated positive manual UAH price.

When the submitted answers, calibration state, and weight do not change, recount remains invalid. A user with `products.recount` may instead use the separate in-place product price-change workflow. It does not call or relax `applyProductRecount()`.

Changing only an informational answer through normal recount still creates a successor variation because the original SKU is permanently reserved. Magento metadata completion therefore uses `POST /api/product-information/preview` and `/apply`, both guarded by `products.recount`. The server allows only versioned fields `BR.braclet_size`, `NM.neckle_size`, `KL.exact_size`, `CH.bead_length`, `CH.bead_width`, `CH.rosary_length`, and `SV.size`. `AR.attach` is unrelated to Magento v1. `SV.weight` is a pricing axis and cannot be changed by this command. Dynamic catalog checks reject a field if it becomes SKU-defining, invisible, or referenced by pricing, modifiers, or visibility rules.

Informational apply locks the active source product, rejects an active correction request or stale preview token, validates the changed fields, and writes only `details.answers` on the product. Other historically missing fields may remain incomplete. Since Phase 2, the same transaction advances the separate full-product revision and includes one durable `product_information.updated` audit event with old/new values. Product ID, SKU, weight, calibration (including legacy `3`), schema, price, SKU reservation, correction history, price-export revision, and export exclusion are unchanged. Existing price and repricing previews become stale through their complete product-state signatures. The client uses the existing recount form as a presentation hint, but the two server commands remain separate. Mixed/SKU/weight/calibration changes continue through normal recount.

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

Both source and corrected products are excluded from the normal export queue by current recount apply behavior. Preserve the transaction, lock ordering, stale-signature protection, and export exclusion.

Successful direct apply and correction-request completion use the authenticated local application user as `product_corrections.performed_by_user_id` and as the successor product's `products.created_by_user_id`. They append one semantic `product.recounted` durable audit event in the same transaction. Its concise details link the source and corrected product/SKU plus the detailed correction row and optional correction request; the existing old/new recount payload is not duplicated into `audit_events`. Historical product/correction rows remain `NULL` and no historical events are synthesized.

Direct apply requires `products.recount`; correction preview/request creation requires `corrections.create`. Selecting a custom USD-per-gram or exact manual UAH decision additionally requires `corrections.price_override`.

## Phase 1 lifecycle and inherited names — 2026-09-26

Migration 039 and `full-product-export.service.js` add durable full-product obligations. Ordinary save creates revision 1, confirmed revision 0 and route `normal` in the product/SKU/audit transaction. Recount creates a separate successor obligation and retires the source. Archive also retires its state. A lifecycle failure rolls back the complete mutation, including reservations, correction history, request finalization and audit.

Recount classifies the complete ancestor chain through the accepted Phase 0 evidence parser/lineage graph and exact new snapshot membership. Reliably unexposed lifecycle-born ancestry yields `normal`; generated or confirmed exposure yields `hold/prior_exposure`; unresolved history yields `hold/historical_ambiguity`. Independent exclusion and invalid lineage have explicit hold reasons. Migration-baseline history does not become reliably unexposed from cursor position or missing price-exposure flags. Recount-created exclusion on an intermediate successor is distinguished from an independent exclusion.

Both manual Magento subjects are copied together without regeneration from the old SKU. Existing review requirements persist. Same known schema/category/physical weight and proven neutral answer changes can retain approval: known non-SKU informational text fields and the narrow equivalent numeric `SV.weight` representation case. Semantic SKU answer, schema, category, physical-weight or calibration changes, and unproven inheritance safety require review. Missing names are not invented. The copied pair/review decision is retained in the correction payload.

The recount-specific source signature now includes both exact subjects, review state and exclusion. The generic product signature keeps its previous meaning. Direct apply must send `sourceStateSignature` from the accepted preview; the client does so. Missing/stale proof returns 409 and requires a new preview. Locked source state is revalidated before copying names. Existing recount/request preview signatures may require refresh; they are not silently accepted under the new binding.

Request completion continues through the shared recount transaction with its existing claim/finalization boundary. At the Phase 1 checkpoint, explicit refresh/delivery-outcome parity, old pending-request compatibility, informational/name-edit full revisions and review UI were deferred. These are now implemented in the Phase 2 section below; reconciliation commands remain outside scope.

The source and successor remain excluded by the current exporter even when the successor ledger route is `normal`. The previous direct-apply description of dual exclusion therefore still applies; only the earlier loss of inherited manual names is fixed here. **Do not deploy Phase 1 independently.** The operator release blocker remains until the later coordinated selection switch; old/new mixed writers are unsupported. See [actual Phase 1 results](RECOUNT_EXPORT_CORRECTNESS_PLAN.md#19-phase-1-actual-results--2026-09-26).

## In-place product price changes

`POST /api/product-price-change/preview` and `POST /api/product-price-change/apply` both require `products.price_change`. They accept `system_auto`, `manual_uah`, and `usd_per_gram`; the client keeps Manual UAH selected by default. Automatic mode has no override fields or separate rounding choice: it recalculates from the existing product's stored configuration and weight using current authoritative pricing and the category's automatic marketing-rounding setting. An unavailable automatic result is reported explicitly and cannot be applied. Manual UAH uses the existing positive, finite, two-decimal validation and an explicit marketing-rounding choice that defaults off in the client. USD/gram uses the existing positive, finite, four-decimal validation and its existing explicit marketing-rounding choice; the server calculates final UAH from the product's stored authoritative weight and the authoritative exchange-rate provider.

Apply locks and reloads the active, uncorrected product row, rejects an active correction request, recalculates pricing inside the transaction, and verifies the opaque preview token against the complete product pricing state and mode-specific dependencies. Concurrent product/repricing updates therefore stale the preview. An unchanged effective final UAH price is rejected. Active repricing drafts do not block the command; the changed complete product state makes their prior tokens stale and draft synchronization reports the change.

The update changes only `total_price`, `total_price_uah`, `price_per_gram`, `uah_rate`, and the pricing-related portions of `details`. Product ID, SKU, SKU reservation/sequence state, weight, answers, schema version, status, and correction lineage remain unchanged. A `product.price_changed` audit event is inserted in the same transaction with immutable actor/time attribution, the normalized decision, and complete old/new pricing evidence. The same transaction advances the product's pending export revision. Audit or revision-write failure rolls back the product update.

Automatic price changes clear `manualPriceUah` and `customUsdPerGramBasis`, then persist the current normal automatic calculation in the existing calculated, automatic, final, USD, and rate fields. Manual price changes reuse correction persistence semantics: normal automatic pricing is recomputed as evidence and its raw and selected results remain `calculatedPriceUah` and `autoPriceUah`. With rounding off, the entered decision is stored exactly in `manualPriceUah` and `total_price_uah`; with rounding on, the existing authoritative marketing algorithm selects the final result stored in those fields while the immutable audit evidence retains the entered value and choice. USD/gram changes store the supplied basis in `customUsdPerGramBasis`, store the authoritative rate and metadata, keep `manualPriceUah` null, and store raw/selected server results in their existing fields. No mode gives any field a new meaning.

## Correction requests

Correction requests move through `pending`, `in_progress`, `completed`, and `rejected`. A partial unique index permits only one active request per source. Active requests block competing direct correction and repricing.

Every new request stores its pricing mode, including requests from older clients that omit `pricingDecision`. Those requests become `system_auto`, or `manual_uah` with origin `automatic_unavailable_fallback` when the accepted legacy manual field supplies a missing automatic price. System automatic mode uses the normal matrix, modifiers, category rounding, and full pricing-context binding. Custom USD-per-gram mode multiplies the stored positive USD/gram value by target weight and the current authoritative USD/UAH rate, applying only the stored explicit rounding choice. Exact manual UAH mode stores a positive final UAH amount without rounding or an exchange-rate dependency and retains any available automatic result as its history baseline. Processors can view but cannot replace the decision. Only pre-feature rows retain their NULL pricing mode; pending recount requests require Phase 2 evidence refresh before completion, including rows with legacy pricing signatures.

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

## Phase 2 request and in-place parity — 2026-09-26

`product/recount-evidence.js` is the common delivery/name derivation for direct preview/apply and request creation/refresh/completion. Public recount previews use one repeatable-read, read-only transaction. New/refreshed `proposed_payload.recountEvidence` has `version: 2` and binds the source product/name signature, complete lineage links, ancestor lifecycle revision/confirmation/delivery counters and routing evidence, exposure classification, expected successor route/hold reason, and inherited UA/EN pair/review outcome. The opaque `source.stateSignature` now covers this complete binding. Direct apply still sends that same field; no client-calculated route is accepted.

Creation revalidates its accepted preview after locking the source. Refresh locks source product → request → ascending lifecycle state, checks the current claim epoch, then rebuilds target/pricing/inheritance/delivery evidence on that transaction's connection. It stores fresh evidence without creating a successor, advancing revisions, changing exclusions or mutating export state. Claim still commits before its existing automatic refresh; failed post-claim refresh retains the existing release behavior.

The additive request `delivery` projection contains `route`, `holdReason`, `exposure` and `nameReviewRequired`. The queue presents concise human descriptions without displaying raw evidence. An old active recount request without version-2 evidence returns `refreshRequired: true`; completion rejects it with HTTP 409 `RECOUNT_REFRESH_REQUIRED` and `details: {type: "stale_correction_request", refreshRequired: true}`. There is no legacy-signature fallback that infers delivery. Authoritative refresh upgrades only the pending request evidence. NULL historical pricing modes, one-time token adoption, owner identity, claim versions and release/reclaim rules remain intact. Completed requests take the existing idempotent historical/actor-epoch path before any new evidence requirement.

Completion invokes `applyProductRecount()`. It checks the stored signature, locks source → existing SKU resources → request → ascending lifecycle state, re-reads exposure after lifecycle lock waits, and rejects changed reviewed evidence before product writes. Source retirement, successor revision 1/route, paired names/review flag, correction history, request completion and both existing semantic audits share one transaction. A generated snapshot or confirmation winning a race now requires fresh recount evidence rather than silently changing the reviewed delivery outcome. Existing repricing-draft synchronization remains best effort **after commit**, as documented in `REPRICING.md`; it cannot undo a successful recount.

Informational edits keep the exact existing allowlist and active-request prohibition. Their version-2 preview token also binds full revision and delivery version. A successful allowed answer mutation increments full revision in the product/audit transaction; no-op, invalid, stale or rolled-back edits do not. Name changes similarly increment full revision, clear pending inherited-name review, and advance delivery version when that review state changes. Both paths preserve confirmed revision, identity, exclusion, correction lineage and the dedicated price stream. Full revision 1/confirmed 0 becomes 2/0 before first confirmation; 1/1 becomes 2/1 afterward. Price-only direct/request changes still advance only `product_export_revisions`.

The authorized Magento-name workflow also supports explicit `confirmUnchanged: true` for a current inherited pair with pending review. Reading `/product-magento-name/preview` with only `productId` returns the current pair, review eligibility and its confirmation token when eligible. Confirmation consumes that reviewed token, clears the flag, increments `delivery_version`, and writes `product_magento_name.reviewed` without advancing payload revision. Ordinary unchanged writes remain rejected. Edited names use `product_magento_name.updated`; audit or lifecycle failure rolls back the complete operation. See [exports](EXPORTS.md#phase-2-name-review-and-in-place-full-revisions--2026-09-26) for readiness and snapshot behavior.

**Phase 2 is NOT independently deployable as the full correctness fix. Normal export selection remains old behavior until Phase 4.** No historical repair, exclusion clearing, replacement release or Phase 3/4/5 work is included. [Section 20 of the plan](RECOUNT_EXPORT_CORRECTNESS_PLAN.md#20-phase-2-actual-results--2026-09-26) records verification and race evidence.
