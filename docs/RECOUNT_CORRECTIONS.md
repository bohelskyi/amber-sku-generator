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

## Direct apply

Recount apply is one authoritative transaction that:

1. locks and rechecks the source row and state signature;
2. rebuilds target preview and pricing;
3. validates automatic/manual final pricing;
4. blocks apply when an active correction request owns the source;
5. serializes and reserves the corrected SKU or next variation;
6. inserts the new active product and detailed `product_corrections` history record;
7. marks the source corrected and links both records.

Both source and corrected products are excluded from the normal export queue by current recount apply behavior. Preserve the transaction, lock ordering, stale-signature protection, and export exclusion.

Successful direct apply and correction-request completion use the authenticated local application user as `product_corrections.performed_by_user_id` and as the successor product's `products.created_by_user_id`. They append one semantic `product.recounted` durable audit event in the same transaction. Its concise details link the source and corrected product/SKU plus the detailed correction row and optional correction request; the existing old/new recount payload is not duplicated into `audit_events`. Historical product/correction rows remain `NULL` and no historical events are synthesized.

Direct apply requires `products.recount`; correction preview/request creation requires `corrections.create`. Selecting a custom USD-per-gram or exact manual UAH decision additionally requires `corrections.price_override`.

## In-place product price changes

`POST /api/product-price-change/preview` and `POST /api/product-price-change/apply` both require `products.recount`. They accept `system_auto`, `manual_uah`, and `usd_per_gram`; the client keeps Manual UAH selected by default. Automatic mode has no override fields or separate rounding choice: it recalculates from the existing product's stored configuration and weight using current authoritative pricing and the category's automatic marketing-rounding setting. An unavailable automatic result is reported explicitly and cannot be applied. Manual UAH uses the existing positive, finite, two-decimal validation and an explicit marketing-rounding choice that defaults off in the client. USD/gram uses the existing positive, finite, four-decimal validation and its existing explicit marketing-rounding choice; the server calculates final UAH from the product's stored authoritative weight and the authoritative exchange-rate provider.

Apply locks and reloads the active, uncorrected product row, rejects an active correction request, recalculates pricing inside the transaction, and verifies the opaque preview token against the complete product pricing state and mode-specific dependencies. Concurrent product/repricing updates therefore stale the preview. An unchanged effective final UAH price is rejected. Active repricing drafts do not block the command; the changed complete product state makes their prior tokens stale and draft synchronization reports the change.

The update changes only `total_price`, `total_price_uah`, `price_per_gram`, `uah_rate`, and the pricing-related portions of `details`. Product ID, SKU, SKU reservation/sequence state, weight, answers, schema version, status, and correction lineage remain unchanged. A `product.price_changed` audit event is inserted in the same transaction with immutable actor/time attribution, the normalized decision, and complete old/new pricing evidence. The same transaction advances the product's pending export revision. Audit or revision-write failure rolls back the product update.

Automatic price changes clear `manualPriceUah` and `customUsdPerGramBasis`, then persist the current normal automatic calculation in the existing calculated, automatic, final, USD, and rate fields. Manual price changes reuse correction persistence semantics: normal automatic pricing is recomputed as evidence and its raw and selected results remain `calculatedPriceUah` and `autoPriceUah`. With rounding off, the entered decision is stored exactly in `manualPriceUah` and `total_price_uah`; with rounding on, the existing authoritative marketing algorithm selects the final result stored in those fields while the immutable audit evidence retains the entered value and choice. USD/gram changes store the supplied basis in `customUsdPerGramBasis`, store the authoritative rate and metadata, keep `manualPriceUah` null, and store raw/selected server results in their existing fields. No mode gives any field a new meaning.

## Correction requests

Correction requests move through `pending`, `in_progress`, `completed`, and `rejected`. A partial unique index permits only one active request per source. Active requests block competing direct correction and repricing.

Every new request stores its pricing mode, including requests from older clients that omit `pricingDecision`. Those requests become `system_auto`, or `manual_uah` with origin `automatic_unavailable_fallback` when the accepted legacy manual field supplies a missing automatic price. System automatic mode uses the normal matrix, modifiers, category rounding, and full pricing-context binding. Custom USD-per-gram mode multiplies the stored positive USD/gram value by target weight and the current authoritative USD/UAH rate, applying only the stored explicit rounding choice. Exact manual UAH mode stores a positive final UAH amount without rounding or an exchange-rate dependency and retains any available automatic result as its history baseline. Processors can view but cannot replace the decision. Only pre-feature rows retain their NULL mode and legacy signature behavior.

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
