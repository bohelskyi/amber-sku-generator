# Native TEST products

Forward migration 069 adds an immutable `is_test_product` flag and independent
`test_allocation_number` to the permanent public identity registry. A TEST create
allocates `TEST-000001` and later numbers from `test_product_sku_sequence`.
The existing AG sequence and its allocation-number uniqueness remain unchanged.
Recount successors inherit their existing identity and TEST marker. Identity rows,
markers and issued numbers cannot be changed, removed or reused. Rolled-back
allocations intentionally leave gaps. Existing identities remain ordinary; this
migration does not relabel any existing AG or legacy product, enqueue work,
publish bindings, allocate a TEST identity or contact Magento.

## API and authority

`POST /api/preview` and `/api/save` accept `isTestProduct: true` only for an active
user assigned the actual immutable Administrator role with `products.create`.
Missing/false retains ordinary behavior. Other types fail with HTTP 422
`TEST_PRODUCT_FLAG_INVALID`. The price-preview route also validates the flag and
actual Administrator authority. Save rechecks role and permission under the access
administration fence before identity allocation, including original-attempt replay.
The database allocator rechecks the actual actor, active native mode and immutable
characteristic version. TEST creation is unavailable with the public-identity gate off.

The accepted preview token binds the true flag and target status 2. Changing it
requires a fresh preview. Save idempotency binds the full original request, including
the flag; concurrent retries return one original receipt. Ordinary false/omitted
preview tokens preserve their prior signature semantics.

Preview/save receipts, stored decode and register items expose authoritative
`isTestProduct` and, for TEST, `testTargetStatus: 2`. `/config` exposes
`productCreation.testProducts = {available, administratorOnly: true,
prefix: 'TEST-', targetStatus: 2}`. No number is predicted or reserved by preview.

## Magento and photos

TEST products can be delivered to Magento, but product status is always 2 (disabled
for customers). Visibility is a separate field; this feature does not change it.
Published evaluator/template definitions remain immutable. Native transport applies
the TEST status guard outside frozen template evaluation. CREATE explicitly sends
status 2; UPDATE preserves an already-disabled, exactly owned counterpart. An
unexpectedly enabled TEST counterpart is blocked for separate administrator review;
ordinary update does not silently disable it. A matching SKU/name alone confers no
ownership: first-contact collisions are blocked by the existing native identity
ownership fence, including TEST articles.

Photos may be uploaded and ordered normally, but creation
`enableWhenPhotosVerified: true` or an existing TEST gallery
`enableWhenVerified: true` fails with `TEST_PRODUCT_ENABLE_FORBIDDEN`.
The media worker rechecks TEST disabled status and activation intent before any
write. Database triggers prohibit activation in photo sets, media jobs, visibility
intents, historical intents and native delivery jobs. Archive remains deliberate
status-2 hiding with its existing exact ownership proof. Restore retains its ordinary
proof protocol, and cannot restore status 1 for TEST. Historical restoration keeps
its exact counterpart/publication/actor/outbox checks, with the same TEST restriction.

The existing administrator test-deletion workflow also accepts genuine TEST
identities. Its exact acknowledged CREATE, single-revision, no-business-evidence,
GET reconciliation and permanent voided tombstone rules are unchanged. Nothing in
creation automatically deletes, archives or cleans up a TEST product.

## Verification

`server/test/test-product-identity.test.js` covers strict boolean/actual-role HTTP
checks through session/active-user/permission/CSRF middleware, signed preview changes,
ordinary signature compatibility, frozen template preservation, status-2 CREATE,
foreign collisions, unexpectedly enabled counterparts, and photo/restore guards.

`server/integration-test/test-product-identity.test.js` uses only a newly created
owned `amber_test_identity_<pid>_test` database on canonical loopback port 55432.
It prohibits HTTP, preserves an outer `CODEX_FINAL_DB_MARKER`, and verifies nonempty
068 history, 069 DDL rollback/install/repeated startup, immutable registry metadata,
independent concurrent allocations, exact-attempt race/replay, rollback gaps,
unchanged AG numbering and ordinary behavior, TEST decode/register and recount.
Run this fixture only within the repository's guarded disposable integration setup;
it is not a live Magento acceptance test.
