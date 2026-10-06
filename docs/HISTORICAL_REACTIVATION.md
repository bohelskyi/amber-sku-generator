# Historical reactivation: explicit future decisions

This protocol is separate from ordinary restore. Ordinary restore still requires its immutable archive/hide and prior participation proof. Historical reactivation creates a new Administrator intent from authoritative **current** product, price, identity, published binding and freshly observed exact Magento counterpart. Prior visibility and exclusion facts remain `unknown`; no historic proof is invented or enrolled on startup.

The current installation's 48 archived products have not been reactivated, inspected against Magento, or submitted through this protocol. Missing counterparts remain blocked; this protocol has no product CREATE path. Deployment of an atomic update-only Magento adapter is **not implemented or accepted** by this patch. Until independently installed and reviewed, preview reports `HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED` and confirmation cannot select that product.

## Required authority and review

The actor must hold the immutable built-in Administrator role and all five effective permissions: `products.view`, `products.archive`, `history.view`, `export_templates.manage`, `export_templates.publish`. `users.manage` is not a substitute for that role. The initiating authority is checked again before hide, local activation and initial native acknowledgement. An additional Administrator may inspect/reconcile, while the original initiating authority must remain valid.

Preview is read-only. It normalizes/deduplicates up to 100 articles and returns exactly one item for every normalized input. Ambiguous ownership, corrected lineage, independent business exclusions, unresolved native/media/visibility work, test deletion, invalid current price, disabled automatic delivery and unavailable/currently mismatched bindings block selection. Fresh Magento observations must match the exact existing SKU and entity ID. The published prospective UPDATE must deliver the current Manager UAH price; a literal different price cannot silently override it.

A five-minute HMAC review binds actor, original scope, current facts, remote observation and binding. Confirm requires the exact checked eligible subset and an explicit acknowledgement. The client retains an original UUID; it is also the batch ID. Concurrent confirmations serialize before fresh remote review, and one immutable request hash/actor recovers the same committed receipt even after token expiry. Changed input with that UUID conflicts. After a lost response, the UI uses GET by the original UUID; a 404 is not proof that submission may be repeated.

## Closed API

- `POST /api/products/historical-reactivation/preview`: `{skus}`.
- `POST /api/products/historical-reactivation/confirm`: `{skus,selectedSkus,reviewNonce,reviewHash,reviewToken,reviewExpiresAt,idempotencyKey,confirmCurrentFactsAndHiddenUpdate:true}`.
- `GET /api/products/historical-reactivation/batches/:batchId`: immutable receipt and independent per-item timestamps.
- `GET /api/products/historical-reactivation/intents/:intentId/inspection`: fresh exact counterpart observation and local reconciliation eligibility; no mutation.
- `POST /api/products/historical-reactivation/reconcile`: `{intentId,reviewHash,confirmObservedHiddenResult:true}`. Fresh GET-only remote read plus explicit local finalization; returns the raw updated item. Never PUTs or repeats a dispatched mutation.

Known preacceptance failures are `HISTORICAL_REVIEW_STALE`, `HISTORICAL_SELECTION_INVALID`, and `HISTORICAL_CONFIRMATION_REQUIRED`. Other failures/unknown responses retain the original UUID for inspection.

## Atomic adapter prerequisite

Stock Magento `PUT /V1/products/:sku` uses `ProductRepositoryInterface::save`, which can create a product when the counterpart disappears. A preliminary GET or a pinned ID in that stock payload does not guarantee update-only behavior. Therefore this lane never falls back to a stock product PUT/POST.

The authenticated `GET /rest/all/V1/amber/products/existing-update-capability` must return exactly:

```json
{"contract":"amber-existing-product-update-v1","version":1,"atomic":true,"productCreateAllowed":false,"identity":["sku","entity_id"],"scopes":["all","en"]}
```

The closed update endpoint is `PUT /rest/{all|en}/V1/amber/products/{encodedExactSku}/existing/{positiveExpectedEntityId}`. Body: `{contract:"amber-existing-product-update-v1",intentId:UUID,operationKey:SHA256,product:{...reviewedFields,sku:exactSku,id:expectedEntityId}}`. The remote implementation must check both immutable identities inside its product transaction and reject missing/replaced targets; no CREATE, arbitrary scope, redirect, implicit retry or fallback is allowed. It must reject identity fields changed inside the product payload and reject unsupported fields rather than silently save them. Its installation, review, permissions and real acceptance require a separate operator rollout. A capability declaration alone is not evidence that an unreviewed remote implementation meets this contract.

The local signer restricts origin, scope, SKU and ID. Capability is rechecked for preview, hide, native enqueue/apply and dispatch. Product core/English saves use this adapter. Existing bounded category-link, website and inventory operations reference an existing product and retain their existing writers after pinned counterpart checks. Missing or replaced counterparts block every historical native plan; even after completion the identity's native delivery stays UPDATE-only.

## Durable stages and uncertainty

Confirm leaves the local product archived and queues a permanent intent. The worker obtains identity/SKU session lanes and releases product, access, lifecycle and binding row locks before HTTP. A dispatch marker commits **before** the status-2 adapter PUT. Status 2 must be freshly verified for the exact original ID/SKU and remote nonstatus fingerprint before local activation. Already-hidden exact counterparts require no visibility PUT.

A lost response leaves `dispatched` permanently sticky until exact GET readback establishes the hidden outcome. Automated recovery and explicit reconcile are GET-only. They never reset dispatch proof or resend PUT. Fresh role, binding, local fingerprint and generation checks precede local activation. The new participation decision changes only local active/archive/exclusion/lifecycle participation fields, preserves characteristics, legacy/public identities, SKU schema, price, names and gallery, and records `priorFacts:"unknown"`.

`awaiting_native` has `hiddenVerifiedAt` and `localActivatedAt`, with `nativeConfirmedAt:null`. The automatic worker delivers the exact reviewed initial UPDATE under the pinned binding/generation. `completed` requires an acknowledged successful UPDATE job with the exact product/public identity, origin, binding, article, Magento ID and automatic generation. All three timestamps are historical receipts, not a claim about current remote visibility or all later product state.

Migration 066 is additive and has no backfill or remote I/O. Permanent reviews/dispatch receipts cannot be rewritten/deleted/truncated. Pending intents fence characteristic/product, lifecycle, request-generation, new media, correction, deletion and competing native obligations. Initial historical native work requires the exact expected automatic generation; completed identities retain the pinned update-only native job guard. The protocol does not grant global pricing, generic photo editing or publication rights.

## Verification and remaining rollout

Offline transport tests prove closed capability matching, exact all/en endpoint signing, unsupported origin/SKU/ID rejection, no stock upsert/CREATE fallback, and no mutation retry. The disposable PostgreSQL fixture uses the real published-template planner and automatic delivery worker with a mock atomic adapter. It proves migration/repeated-startup non-enrollment, signed selective review, UUID races, preserved current metadata, hidden-first activation, actual UPDATE acknowledgement, sticky lost-response GET-only recovery, revoked authority, changed binding/current price, missing/replaced remote counterparts, and an independent uncommitted input race. Only an owned database on canonical loopback port 55432 is created/dropped; no shared database is reset.

The root integration must mount routes, expose the capability card, start/drain the runtime and register endpoint authorization manifest coverage. Final combined checks run after all shared patches are integrated. Live historical preview/application and remote adapter deployment remain separate explicitly authorized operations.
