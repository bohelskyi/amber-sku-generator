# Recount and corrections

## Recount target validation

Recount starts from a decoded, existing, active, uncorrected product and always targets the category's current active SKU schema. Submitted answers are a patch:

- omitted keys inherit stored/historical values;
- explicit `null`, `undefined`, or blank clears the named answer;
- numeric `0` is preserved as real data, including calibration state `0` and configured zero options.

After merging the patch and before target preview/validation, `omitHiddenRecountAnswers()` removes inherited answers for questions in the published target SKU schema that are hidden or inactive in the target configuration. This applies to old placeholders and previously valid values. Corrected product details must not retain those obsolete SKU answers.

Questions visible in the target remain required and validated normally. This cleanup is recount/correction-specific and must not weaken new-product validation or introduce historical placeholders as active options. The helper currently receives published SKU-schema questions, not live non-SKU metadata; broadening that scope is a separate behavior change requiring a reproduced case and tests.

Preview requires an actual answer change and computes the proposed corrected SKU and price. Missing automatic pricing can be resolved only by an independently validated positive manual UAH price.

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

Direct apply requires `products.recount`; correction preview/request creation requires `corrections.create`.

## Correction requests

Correction requests move through `pending`, `in_progress`, `completed`, and `rejected`. A partial unique index permits only one active request per source. Active requests block competing direct correction and repricing.

Signatures bind source/proposed state. Refresh recalculates the proposed result. Completion uses the same transactional recount application, stores the final payload, and attempts to synchronize affected repricing drafts.

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

## Current role behavior

| Role | Correction behavior |
| --- | --- |
| Administrator | View, create, claim/release, refresh/complete, reject/reopen, and force-release. Also direct recount. |
| Manager | View, create, reject/reopen. Cannot claim/release, refresh/complete, force-release, or directly apply recount. UI is monitoring/request-oriented. |
| Storekeeper | View, create, claim/release, refresh/complete, reject/reopen, and direct recount. Cannot force-release. |

Server permission checks remain authoritative; client controls are hidden from effective `/api/auth/me` permission keys only.

## Attribution and audit

Correction requests record nullable `created_by_user_id` and current `claimed_by_user_id` references to local application users. Historical rows are not backfilled. Create, claim/adopt, release, force-release, reject, reopen, and complete write concise immutable audit events in the same transaction as the lifecycle mutation. Completion also retains the authoritative detailed recount record and semantic `product.recounted` event without copying its large payload into the correction lifecycle event.
