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

## Capability-token claim workflow

Claiming is an atomic conditional update; concurrent attempts yield one owner. On success, the server returns a random raw capability token once, stores only its SHA-256 hash, and exposes only a short fingerprint later. The browser keeps the raw token in local storage.

The token proves control by one browser installation, not an authenticated person. Claims do not expire automatically. Current token rules are:

- claim and ordinary release require `corrections.claim`;
- refresh and complete require `corrections.complete` plus the matching token;
- reject/reopen require `corrections.reject`; rejecting an in-progress request also requires its matching token;
- confirmed force-release requires `corrections.force_release`, deliberately bypasses token ownership, clears the claim, and returns the request to pending.

Owner release also clears the claim and returns the request to pending. Stale or wrong tokens fail without transferring ownership.

The client queue loads immediately, polls every five seconds only while visible, refreshes on focus/visibility return, prevents overlapping polls, and prevents an older response from replacing newer state.

## Current role behavior

| Role | Correction behavior |
| --- | --- |
| Administrator | View, create, claim/release, refresh/complete, reject/reopen, and force-release. Also direct recount. |
| Manager | View, create, reject/reopen. Cannot claim/release, refresh/complete, force-release, or directly apply recount. UI is monitoring/request-oriented. |
| Storekeeper | View, create, claim/release, refresh/complete, reject/reopen, and direct recount. Cannot force-release. |

Server permission checks remain authoritative; client controls are hidden from effective `/api/auth/me` permission keys only.

## Deferred ownership work

Local-user attribution and durable `product.recounted` events are implemented for successful recount application. User-based correction-request ownership is not implemented; capability tokens retain their current behavior. Never label a capability claim as user ownership or derive actor identity from OIDC `sub`. Any replacement or augmentation of capability claims is a separately scoped authorization/data-migration change.
