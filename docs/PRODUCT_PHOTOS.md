# Daily product photographs

Photographs are stored as immutable original bytes in PostgreSQL, separately from
published export templates and the native-product mapper. Migration 062 adds only
photo assets, versioned current photo sets, durable media jobs and permanent
dispatch/read-verification evidence. Installation grants no permission, enables no
worker gate, modifies no existing product and makes no Magento request.

Creation stages originals under `products.create` and attaches ordered IDs in the
existing product-save transaction after public identity allocation. Existing product
photo changes require `products.recount`; reads require `products.view`. Effective
permissions govern the operation, never role names. No Manager/Storekeeper role
grants are added. Authentication, active-user resolution and CSRF remain the normal
business-route boundary. The photo staging JSON parser must be mounted after that
boundary, with a dedicated 8 MiB limit; the default parser must skip only this exact
endpoint. All other API parser limits remain unchanged.

## API contract

- `POST /api/product-photos/stage`: exact keys `idempotencyKey` (UUID), `name`,
  `mimeType`, `base64`. Returns `id`, `name`, `mimeType`, `hash`. A matching actor/key
  retry returns the same photo; changed content/type/name returns 409. Original
  bytes must match declared JPEG/PNG, have bounded dimensions and be at most 5 MiB.
  Canonical base64 is checked before allocation and after decoding. SVG/GIF/WebP
  and MIME-only declarations are rejected. At most 24 unbound, unexpired originals
  or 64 MiB may be staged per actor. Staging expires after 24 hours; immutable
  originals are retained as evidence, without an automatic deletion job.
- Product preview and save accept ordered `photoIds` (up to eight distinct UUIDs)
  and `enableWhenPhotosVerified` (strict boolean, default false). Both are bound
  into the authoritative preview token. Unbound assets must belong to the saving
  actor, remain unexpired and attach to that exact product once. Empty selection
  leaves ordinary native CREATE disabled.
- `GET /api/products/:id/photos`: current version, ordered metadata and local
  delivery state. It makes no remote request and exposes no original bytes.
- `GET /api/product-photos/:id/content`: returns a bounded immutable JPEG/PNG,
  `no-store` and `nosniff`; an unbound original is visible only to its actor,
  attached originals only with `products.view`.
- `POST /api/products/:id/photos`: exact keys `idempotencyKey`, `expectedVersion`,
  `photoIds`, `enableWhenVerified`. Uses active-user/permission revalidation,
  optimistic version, actor/content/target-bound retry recovery and audit in one
  transaction. Existing attached photos may be selected only for their own product.
  Unresolved previous media jobs block a new set instead of erasing evidence. Queued/dispatched visibility work for the same immutable public identity also blocks a new set with PHOTO_VISIBILITY_UNRESOLVED, under the existing product/lifecycle transaction fence. A verified visibility result permits a new explicit photo decision. Recovery of an already committed identical photo-save attempt remains available.
- `POST /api/products/:id/photos/reconcile`: GET-only remote reconciliation of the
  latest exact job. The owner can check a creation job with `products.create`;
  other reviewers require `products.recount`. Original delivery authority and
  requesting reviewer are rechecked. Verified partial steps retain their receipts.
  Once all earlier dispatched steps resolve, unfinished, never-dispatched work
  returns to pending for the worker; the reconciliation HTTP request sends no
  Magento mutation.

## Delivery and recovery

`startMediaRuntime(config, logger)` uses its own bounded PostgreSQL pool and one
worker lane, independent of native synchronization. Startup/shutdown must be wired
by the application bootstrap after migration and drained before pool shutdown.
It checks the existing default-disabled automatic gate and current published
binding; starting the runtime does not activate them. Shutdown checks the stop
predicate before starting the next job in a pass and drains the current job.

Media work serializes through the same public identity and exact SKU session locks
as native sync. A currently active, uncorrected product, normal eligible
lifecycle and current acknowledged native generation are required. The native
receipt must match the current published binding origin and have a nonnull
acknowledged_at; a succeeded job from another origin does not authorize media. The target is
always its immutable PostgreSQL public SKU; legacy articles are percent-encoded
as one exact path segment. Closed OAuth media/status signers reject wrong paths,
queries, fragments, controls and dot/dot-dot targets. If Magento rejects an encoded
legacy path, the outcome remains sticky for GET reconciliation; no POST upsert
fallback or identity rewrite is performed. Actor revocation,
archive, correction, test deletion, binding/origin changes, stale native generation
or unrelated remote field changes fail closed. Product/access/lifecycle locks are
short transactions and never span HTTP. Native IDs, binding origin, generation and
unrelated remote field hashes become permanent job evidence before media dispatch.

The worker verifies native status **2** before uploading or changing media. Each
HTTP write has an immutable operation hash and committed dispatch receipt. An
uncertain write is verified with GET and is never automatically duplicated. A
successful HTTP response alone does not acknowledge a photo. On newer Magento,
single-entry GET can return original base64 bytes. Stock Magento 2.4.6 returns
metadata only, so the transport retrieves its exact validated `entry.file` from
the configured Magento origin under `/media/catalog/product/`. This original-file
GET sends no OAuth header, follows no redirect, has a 5 MiB byte cap and validates
image magic. CDN-only/custom media origins fail closed; there is no arbitrary URL
or credential forwarding. SHA-256 must match the stored original, with exact
label, image type, position and primary roles. At 5 MiB raw, an encoded single-entry
response remains within the existing 8 MiB reader cap.

The first photo owns `image`, `small_image` and `thumbnail`; other photos have no
primary roles. Reordering updates only an exact existing verified entry. Removal
disables owned entries and clears their roles, preserving original bytes and
unrelated Magento gallery entries. Gallery uploads do not change visibility.

Only explicit `enableWhenVerified=true` with a nonempty, completely verified set
permits native status **1**. Without photos or with explicit false, status remains
**2**. Status is a separate narrowly guarded media operation; the immutable
published `product_online=2` contract and the native sync UPDATE preservation
rules are unchanged. Magento visibility is not a substitute for product status.
Failed or uncertain uploads occur only after hidden status was verified. Unknown
dispatch retains reconciliation-only evidence; no marker is reset and no generic
retry overwrites an old attempt.

## Verification boundary

Focused Node coverage uses only in-memory PostgreSQL query fixtures and mocked
Magento HTTP/transport. It exercises byte/type/size validation, explicit enable,
multi-photo order/roles, disabled status, lost responses, partial recovery,
uncertain dispatch, byte mismatch, permission/lifecycle guards and remote drift.
The standalone PostgreSQL test owns a uniquely named `_test` database on canonical
loopback port 55432, never the shared `amber_test` database. Coverage verifies the
059 upgrade, migration rollback/repeated startup, no role grant changes, and real
independent-connection races for staging, asset attachment and photo-set version.
It verifies final database rows and permanent evidence guards, then drops only its
own disposable database. The canonical service must already be running; failure
has no alternate-instance fallback. Merged application browser acceptance remains
required before deployment; no real Magento writes are part of implementation
testing.

Official protocol references:
[Adobe upload tutorial](https://developer.adobe.com/commerce/webapi/rest/tutorials/image/new),
[Magento 2.4.6 metadata GET semantics](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/Product/Gallery/GalleryManagement.php),
[newer Magento original-byte GET semantics](https://github.com/magento/magento2/blob/2.4-develop/app/code/Magento/Catalog/Model/Product/Gallery/GalleryManagement.php).

## Native changes and recount successors

Migration 065 protects any unfinished media job whose native generation or a
dispatch step has already been sealed. Native input edits (including price,
names, information, repricing and recount), and direct queue-generation changes,
must finish or reconcile this media delivery first. Both stored product input and
the request table are fenced, including when automatic delivery is disabled.
Unstarted in-place data repair remains available. The worker holds the native
request row in SHARE mode before pinning a generation, so a competing direct
request update cannot slip between its authorization and durable pin.

A deliberate recount copies the exact current ordered gallery and enable intent
to its same-public-identity successor. Originals keep their permanent predecessor
ownership; same-identity joins prove successor access. Succeeded media evidence
remains unchanged. A pending/blocked obligation with no pin, references or steps
can only become terminal `superseded` after a permanent, exact inherited successor
job exists; the database rejects cancellation without that linked proof. Started
work cannot be superseded or rebound. The new job waits for the successor's native
acknowledgement, then freshly checks existing gallery bytes, order and roles;
verified existing originals do not upload a second time.

Existing correction completion authority can preserve this inherited gallery.
It does not authorize arbitrary staging or photo-set editing. The immutable new
job records the actual `products.recount` or `corrections.complete` authority, and
delivery rechecks that capability. Its original owner may request GET-only
reconciliation with that same authority. No role receives a new grant.

If a previously started job already observes native-generation or target drift,
keep it blocked for operator handoff with its original job, photo hashes and
dispatch evidence. Do not restore an old generation, rebind the target, erase a
marker or treat the gallery as successfully delivered. Migration 065 prevents new
drift; it does not rewrite or reconcile historical evidence. The operator must
inspect the exact identity and original remote evidence before a separately
reviewed recovery can be implemented.


## Gallery-save preservation protocol

Magento 2.4.6 gallery saves can add primary-image labels and empty media-role
attributes. The preservation hash still covers the complete original business
projection; these six attributes are not excluded wholesale. New jobs capture
version 2 before dispatch with a strict presence/value map for `image_label`,
`small_image_label`, `thumbnail_label`, `hover_image`, `listing_video`, and
`content_video`, alongside the original unchanged full hash. Both hash and map
remain immutable under the existing database guard; no migration or published
native/export contract changes are required.

A readback difference is accepted only when reconstructing that closed map
reproduces the original hash exactly. Current primary labels must equal the
intended owned asset label, and a committed matching upload/order operation hash,
exact entry ID/metadata/roles/order and original content SHA must all verify by
GET. Empty nonstandard roles may change only from prior absence to literal
`no_selection`. A nonempty protected hover/video role blocks a new media dispatch
before any mutation. Business values, categories, foreign labels and nonempty
foreign media roles are never discarded from the preservation comparison.

Legacy hash-only jobs retain their original hash. A finite search of at most 64
absence subsets of the same six fields must recover it exactly, with the same
owned original and committed dispatch proof; it never guesses previous values,
rebases evidence, resets a marker, or uploads a duplicate. Other legacy drift
remains blocked for operator review. Unknown versions or malformed maps fail
closed even when the current hash matches.

Removing the last local photo can clear primary labels only for a version 2 job
whose pinned prior labels identify a same-identity owned original. The exact
entry must be disabled with no roles, its original SHA must remain unchanged,
and a matching committed remove operation must exist. Only missing/null/empty
current label values are accepted; the product remains disabled. A read-only
reconciliation may record local audit/verification success, but sends no Magento
POST/PUT and never rewrites preservation evidence.

The safe owned TEST wire regression proves all six prior attributes were absent
by matching the retained SHA256. It also exercises the production HTTP readback
transport using synthetic GET responses and the exact 10,998-byte owned PNG,
with rejection coverage for business/foreign-role/label/metadata/content and
missing or mismatched dispatch evidence. No live write is part of this test.
