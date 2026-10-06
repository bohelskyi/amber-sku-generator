# Reviewed catalog deletion

## Remote-only removal with retained local archive

`POST /api/admin/catalog-deletion/remote-only/preview`, `apply`, and `reconcile`
are a separate reviewed Administrator path. The exact fields match the paired
review; apply uses `ackRemoteOnly` in place of `ackBothCatalogs` and retains every
other dependency/maintenance/ordinary-attribute attestation. No local question,
option, product, immutable publication or audit row is removed.

The local target must already be archived in the `test_…` / `TEST …` namespace.
Ordinary business attributes are excluded. The remote attribute must have an
exact verified Amber creation receipt, the same stable question code and a live
ordinary/non-required identity. An option also needs its exact verified creation
receipt for the local category/question/semantic ID. Whole-attribute removal
rejects any live option outside those owned receipts. Actual stored answers,
dependent pricing/rules, active remote-output templates/latest published bindings, shared mappings,
store-specific remote values and multiple attribute sets remain blockers.
Unrelated category products and unrelated pricing are reported separately from
actual use; they no longer stand in for target dependencies in this path.
Empty optional answers (`null` or `""`) are not target use; semantic zero is.
The permanent future-product fence uses the same distinction.
Inert drafts, local-only sources, native snapshots and immutable versions are
retained. Permanent fences prevent publishing a binding to a deleted resource.

Migration `070_reviewed_remote_only_cleanup.sql` adds a separate permanent ledger
and dispatch/uncertainty/configuration/local-retention fences. It leaves the 063
paired-delete completion requirement intact. A committed marker precedes the one
DELETE; GET-only recovery verifies exact absence and retained archived identities.
Repeated apply never sends another DELETE. A permanent partial unique index
allows only one unresolved option/whole-attribute deletion per attribute and origin.
Service revalidation also checks pending paired and remote-only actions before
sealing. Completion reports `localDeleted=false`.
Normal Magento admin store ID 0 is represented by the global `all` scope; malformed
or duplicate store topology still fails closed. No route dispatches on opening.

The same migration permits the dedicated product deletion lane to seal a genuinely
allocated immutable TEST identity after a verified disabled archive. The exact
current archive fingerprint, prior ordinary lifecycle, acknowledged CREATE and
unchanged disabled counterpart are mandatory. Benign TEST photo/archive/restore
audit events are retained; financial/export/correction/unknown history, unfinished
media/visibility, unowned or enabled counterparts still block. Ordinary AG archive
eligibility is unchanged. Local original photo bytes and all receipts remain
after the remote TEST product and its gallery are removed. An already archived
TEST product and its lifecycle remain unchanged; only its delivery request is
terminalized. The original active-product retirement remains `voided`.

This is an explicit future capability. Installation does not delete local data,
call Magento, publish schemas/bindings, grant Manager destructive permissions,
or process existing archives.

Manager-only question/option archive preserves IDs, assignments and history and
does not alter Magento. Full deletion is a separate actual Administrator action
requiring `catalog.manage`, `export_templates.manage` and
`export_templates.publish`, checked against PostgreSQL at every mutation boundary.
The authenticated active-user and synchronizer-token CSRF middleware remains the
outer boundary.

## Exact scope and review

`POST /api/admin/catalog-deletion/preview` takes only:

```json
{
  "bindingRevisionId": "<exact UUID>",
  "expectedRevision": "1",
  "type": "option",
  "questionId": "<exact Manager question ID>",
  "optionId": "<exact Manager option row ID>",
  "attributeCode": "<exact Magento code>",
  "attributeId": 6001,
  "remoteOptionId": "701"
}
```

For the whole question/attribute, `type` is `question` and both option ID fields
must be null. The whole-question action removes that local question and its
options; the option action removes one exact local option and one exact Magento
option ID while retaining the question and all other options. Labels are display
metadata, never resource identity or matching evidence. The Administrator reviews
the explicitly selected local/remote pairing and types a confirmation containing
both exact targets; no inferred equal-label mapping is used.

The server checks the binding revision/origin and recorded remote attribute ID,
rechecks the live user-defined/non-required ordinary attribute identity, and fails
closed on system, custom-source/backend, observed swatch, required or default
option targets. Ordinary classification must also be explicitly reviewed because
stock REST does not expose every hidden swatch/customization signal.

The review lists Manager products including archived history, category pricing,
visibility/hide rules, active/draft export templates, drafts/latest Magento binding
publications, shared semantic mappings, every affected remote attribute set, and
products across every active store view plus the global store. More than 100
products per remote scope, 20 attribute sets, five active store views, an oversized
report, failed GET or malformed/truncated responses block a complete review.
Shared remote mappings or multiple sets block deletion; this version does not
silently expand consent to other categories.

The conservative first implementation blocks **all existing Manager products in
the category**, including historical/archived products, as well as active pricing,
rules, templates or binding dependencies. It preserves the existing used-option
409 guard and does not permit question cascade to evade that guard. Resolve
dependencies through their normal reviewed workflows or use Manager-only archive.
Superseded immutable template/binding observations and published SKU schemas are
retained as history rather than edited/deleted. A new SKU publication may be
required for future products; this action never publishes automatically.

Stock REST cannot prove absence of external Magento templates, extensions,
promotion/configuration rules or parallel external administrator writes. The
review explicitly reports `externalDependenciesAutomaticallyVerified=false`.
The Administrator must inspect those dependencies and confirm a Magento
maintenance window. This is an action-specific human attestation, not automatic
certification. Product/attribute-set HTTP evidence remains mandatory.

## Dispatch, absence and recovery

`POST .../apply` adds `previewToken`, exact `confirmationText`, nonblank `reason`,
and these literal boolean true attestations:

- `ackBothCatalogs`
- `ackHistoryPreserved`
- `ackExternalDependenciesReviewed`
- `ackMagentoMaintenanceWindow`
- `ackOrdinaryAttribute`

Migration 063 extends the existing permanent configuration ledger with
`attribute_delete` and `option_delete` and adds immutable completion receipts.
Intent + audit + dispatched marker commit before the one closed, OAuth-signed
native DELETE:

- `/rest/all/V1/products/attributes/:code`
- `/rest/all/V1/products/attributes/:code/options/:id`

There are no retries, arbitrary proxy methods/URLs, remote I/O inside business
transactions, or claims of cross-system transaction atomicity. The durable
resource reservation prevents another DELETE after response loss or restart.
A returned boolean true alone never means both systems completed.

Exact filtered GET absence verifies a whole attribute. Option recovery requires
the same attribute ID/metadata, the same active store topology, absence of the
exact option ID in every store scope, and unchanged remaining option fingerprints
in each store scope. Failure is uncertainty, never absence.

`POST .../reconcile` takes only `{actionId}` and performs GET-only verification.
Once absence is verified, a short authorized local transaction revalidates the
sealed local fingerprint, removes the exact active local target, advances the
ledger, appends audit evidence and inserts its permanent completion. A deferred
database invariant prevents a verified deletion without exact local completion.
Repeated apply/reconcile returns the original receipt. It never dispatches again.

An uncertain dispatch leaves local rows retained and exposes
`reconciliationRequired`; a new preview or apply cannot cancel/reset it. If Magento
still has the target or the target/other options changed, recovery remains blocked
for manual investigation. Losing the DELETE response after remote success can be
recovered with exact GET because the target IDs were known before dispatch.

Pending deletion fences prevent local category/product/pricing dependencies and
configuration drift during uncertain work. Template/binding edits are blocked
while a deletion is unresolved; the receipts identify the pending action. These
fences survive process restart. Permanent product-write guards also prevent a
removed semantic value from becoming valid through an old SKU schema.

Products/configurations, SKU schemas/options, SKU reservations, stable public
identities, historical export snapshots, published templates/bindings and audit
history are never deleted or rewritten by this service.

`GET .../actions` and `GET .../actions/:id` return real persisted receipts after
reload. A receipt claims completion only with its immutable local completion;
ordinary creation receipts must not present deletion kinds as created resources.

## Integration and verification

Mount `catalog-deletion.routes.js` inside the existing protected API stack in
`app.js`. Mount `CatalogDeletionReview` from the selected catalog context with an
exact-ID `target`, `isAdministrator`, optional `onClose`, `onCompleted`, and
optional `apiClient`. `onCompleted` runs only when both `localDeleted` and
`remoteAbsent` are true in paired mode. TEST remote-only mode requires
`remoteAbsent`, `localArchived` and `historicalEvidencePreserved` true and
`localDeleted` false. Its entry is available only in the archived TEST context. If a new selection replaces the old target, the keyed
component resets every prior review/confirmation. The panel reloads persisted
actions and offers reconciliation without a second DELETE.

Existing `magento/configuration-actions.js` must delegate the two deletion kinds
to their deletion receipt presenter or omit them from the ordinary creation list;
the new deletion list is their canonical surface. The deferred completion invariant
makes verified deletion synonymous with exact local completion at commit.

Tests cover server mocks, exact scope/semantic zero, Administrator revocation,
confirmation requirements, store-specific product dependencies, shared scope,
response loss, restart without resend, changed options, replay, real isolated
PostgreSQL migration/repeated startup, independent connection dispatch contention,
durable write fences, immutable receipts, semantic tombstones, and full-question
cascade. Every HTTP response is mocked. The disposable integration test creates
its own `_test` database and never resets the shared canonical `amber_test`.
