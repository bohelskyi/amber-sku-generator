# Export templates

This maintained guide owns template authoring, publication, source support and published-preview binding. [Exports](EXPORTS.md) owns lifecycle selection, immutable membership, acknowledgment and price delivery; [shared sessions](SHARED_EXPORT_SESSIONS.md) owns durable collaboration/recovery. Implemented features are independent of production/Magento acceptance.

## Administrative API

Migration `035_export_templates.sql` adds `export_templates`, `export_template_drafts`, `export_template_versions`, and `export_template_activation`. System-mapper product export and dedicated price export do not read these tables. Selection responses retain the compatibility fields `metadataOnly: true` and `effectiveExporter: "legacy"`, describing default dispatch. Explicitly opted-in requests read selection; publishing or selecting alone does not switch default dispatch, expose products, advance cursors/revisions or alter snapshots. Initialization creates only a legacy selection at generation `1` with a null version/actor, plus permissions. No baseline definition is captured or published at startup.

All endpoints below are relative to `/api/admin/export-templates` and retain authenticated active-user and unsafe-method CSRF enforcement. Revision/generation/version-number fields are decimal strings, preserving PostgreSQL bigint precision. Expected counters also accept safe positive JSON integers. Errors use JSON `error`, `code`, and optional `details`.

| Method/path | Body/result | Required capability |
| --- | --- | --- |
| `GET /` | Family list with draft revisions and publication counts | `export_templates.view` |
| `GET /:id` | Family, current draft, and complete immutable versions | `export_templates.view` |
| `GET /system` | Code-backed read-only system profile; no persistence | `export_templates.view` |
| `GET /source-details` | Bounded current/historical source labels | `export_templates.view` |
| `GET /sample-products` | Literal SKU search, 20 rows/page, safe identity/status fields | `export_templates.manage` **and** `exports.view` |
| `GET /sources` | Approved product fields, operations, limits, units and safe current/historical reference hints; no product rows | `export_templates.view` |
| `GET /candidate` | Read-only current Magento candidate captured from the actual catalog, including current source-support policy before final compilation/hash; no persistence/publication/selection | `export_templates.view` **and** `export_templates.manage` |
| `GET /activation` | Selection generation/version and metadata-only status | `export_templates.view` |
| `POST /` | `{key,displayName,definition?}`; creates family and revision `1`; omitted definition is `{}` | `export_templates.manage` |
| `PUT /:id/draft` | `{expectedRevision,definition}`; returns draft/revision/canonical hash | `export_templates.manage` |
| `POST /:id/draft/upgrade-columns` | Revision/hash-checked explicit fixed-to-editable column upgrade | `export_templates.manage` |
| `POST /:id/draft/from-version` | `{expectedRevision,versionId}`; copies a publication from the same family into the draft | `export_templates.manage` |
| `POST /:id/validate` | `{expectedRevision,expectedDefinitionHash}`; full stored-draft validation and reference diagnostics | `export_templates.manage` |
| `POST /:id/test-preview` | `{expectedRevision,expectedDefinitionHash,productIds}`; 1–100 unique integer IDs, loaded in product-ID order | `export_templates.manage` **and** `exports.view` |
| `POST /:id/publish` | `{expectedRevision,expectedDefinitionHash}`; server-assigned version, hash, actor and timestamp | `export_templates.publish` |
| `PUT /activation` | `{expectedGeneration,implementation,templateVersionId,reason?}`; `legacy` requires null version, `template` requires a supported publication | `export_templates.activate` |

Only Administrator receives these capabilities initially. They can be explicitly delegated to editable roles independently of access-administration permissions. Static `/sources` and `/activation` routes precede `/:id`.

Draft save permits incomplete definitions, including unsupported format/evaluator values for later editing. It enforces JSON/size/depth limits, plain JSON data, safe keys, no executable accessors, and PostgreSQL-compatible Unicode; NUL and unpaired surrogates are rejected. The shared canonical hash is available for incomplete drafts, but their response is explicitly `state: "draft"`. Saving is not publication validation. Full validation, preview and publication reuse the original compiler and evaluator; there is no alternate schema or mapper.

Evaluator versions 1 and 2 permanently retain `full_sku` as the encoded internal/configuration source. Migration 046 adds evaluator `magento-declarative-3` plus `sourceContractVersion: "public-product-identity-v1"`; evaluator 4 also requires this source contract. Only these public-identity evaluators may declare the distinct product source `public_sku`. The current candidate/system view prepares evaluator 3; existing drafts/publications, hashes, stored artifacts and activation metadata are not rewritten or selected automatically. Current production uses the reviewed public-SKU-aware binding. Subsequent reviewed publications must use `public_sku` for Magento article columns while retaining `full_sku` wherever internal configuration evidence is required.

## SV keychain size correction

The current system/candidate materialization makes `SV souvenir=value_id:6` size optional: `rozmir_suveniriv` uses the stored size, trimmed, or an empty cell when absent. Other SV routes keep their existing required-text expression. The same expression language and evaluator versions implement this condition; no evaluator-engine version or database migration is needed.

The size requirement is captured in the template AST and therefore participates in immutable published binding semantics. Existing publications, hashes and snapshots stay unchanged. Correct an existing integration through the existing workflow: clone/edit the template's SV size expression, publish a new template version, prepare/review its binding successor (including any approvals invalidated by the changed dependency), preview the exact affected scope and publish through the reviewed H3b handoff. Do not regenerate an old publication or waive its evaluation errors in the planner. See [publication and controlled handoff](MAGENTO_INTEGRATION.md#reviewed-publication-and-controlled-handoff-h3b).

## Extensible v4 integration contract

Wave 2 H0 adds the explicit opt-in `evaluatorVersion: "magento-declarative-4"`, with `formatVersion: 1`, `sourceContractVersion: "public-product-identity-v1"` and **only** `outputContract: "magento-products-columns-v2"`. It uses the same compiler, expression language, evaluator, protected full-product columns, source validation, planner and durable writer. It is not a second mapper or automatic contract upgrade.

- `groups` declares 1–64 unique category scopes. Each `route` is an exact Amber category code matching `^[A-Z][A-Z0-9_]{0,31}$`; partial coverage is permitted. A seventh category no longer requires adding a code-backed six-group header profile.
- Semantic/information sources and group-scoped expression bindings must reference a declared group. Keys, provenance, aliases, rules, AST/work/output limits and types retain their existing validation. Product inputs remain the existing closed typed projection; arbitrary JSON paths or caller-supplied trusted prices are unsupported.
- Every group still has base/English rows and protected SKU, store, name, attribute-set, simple-product and positive-price checks. SKU must equal the exact public identity; missing public identity cannot fall back to internal SKU. Nothing creates a price or invents a name.
- Publication and preview read category-scoped evidence from PostgreSQL. SKU semantic values require immutable published schema evidence (or the existing separately supported current non-SKU metadata contract); draft-only SKU options and label equality cannot establish authority. Information sources require current non-SKU metadata. Claimed aliases remain fail-closed without authoritative lineage. The optional historical-source-support policy stays closed to its existing NM/AR cases and cannot grant authority to a new value.
- Semantic `value_id`, internal `sku_code`, and Magento attribute/option IDs remain separate. Bindings retain exact attribute membership, review state, ownership policies and frozen remote observations. Creation of a remote value never approves its semantic mapping.

Migration [051](DATABASE_MIGRATIONS.md#migration-051-extensible-integration-categories) widens the two binding category constraints and additionally requires a new category to appear in the exact immutable v4 template pinned by that revision. No definitions, bindings, selector/gate state, products, historical jobs or evidence are rewritten. Evaluators **1–3 retain exactly six groups**, their old source-evidence scope/order and identity semantics; installing H0 never upgrades a publication.

The existing template/binding services can validate and persist an explicitly authored v4 definition under their existing authorization, revision/hash/CAS, transaction and audit boundaries. No new HTTP route or permission is added. H0 does not expose readiness UI or a general source editor, create categories/options in Magento, publish a production successor, enqueue handoff, acknowledge coverage loss or apply changed name-generation rules. Those are later reviewed H1/H2/H4/H3 phases. The code-backed system profile, closed historical compatibility report/carry-forward and first-install delivery-cutover tooling retain their prior contracts. Existing evidence audits remain bounded to 24 representative route plans and are not an installation-wide report engine.

Draft writes compare `expectedRevision` before considering no-op equality. Stale writes return `409 TEMPLATE_DRAFT_CONFLICT`; an identical definition and base-version reference at the expected revision preserves actor/time/revision and emits no event. From-version copying preserves the published source and advances the draft only when definition/base reference changes. Cross-family versions are rejected by the service and composite FK. Template keys are permanent and no delete workflow exists.

Publication runs one transaction: the common exclusive access-admin advisory lock, current actor/capability recheck, shared lifecycle gate, family lock, draft lock, completed-retry lookup, revision/hash preconditions, full validation, coherent repository source reads, locked version allocation, immutable insert, and audit. The complete detached definition includes all constants, rules and question contracts. INSERT results are recompiled and their persisted hash checked; mismatches fail without rewriting provenance. Published UPDATE, DELETE and TRUNCATE are rejected, even for unreferenced versions. Actor references use `application_users.id`.

A completed retry with the same family/source revision/hash returns the original version and original actor/time even after the draft advances. A different expected hash conflicts. Concurrent identical publications create one version/event. Source revision is historical evidence and does not constrain future draft edits. Publication never changes selection. Selection uses independent `expectedGeneration` CAS, increments for every real change including A → B → A, and preserves no-op attribution. Unsupported contracts/evaluators or a mismatching stored hash cannot be selected.

Repository source validation is separate from frozen-rule semantics. Publication takes one SQL-statement MVCC snapshot of category/current-question/historical-schema evidence on its transaction client. Validation/test-preview use `REPEATABLE READ READ ONLY` across draft, source and product reads. Declared categories must exist; semantic keys require historical SKU-question evidence or current non-SKU metadata, while information keys require current non-SKU metadata. Captured allowed IDs must have semantic `value_id` evidence; archive status and live option labels/`sku_code` never reinterpret them. Missing questions/categories/IDs and duplicate current keys produce explicit `TEMPLATE_SOURCE_INVALID` diagnostics. Frozen required/visibility rules are validated as supplied and never silently refreshed from current rules.

The closed historical-information registry additionally recognizes `KL.exact_size`
for the existing Magento v1 stored-answer contract when current metadata is absent.
This is the documented legacy input to ordered `pedant_size` → `exact_size`
fallback, not an alias between the keys. Contradictory current SKU metadata,
arbitrary legacy keys and unverified aliases still fail. No product scan, repair,
question creation or definition rewrite occurs during candidate preparation or
validation. The source registry exposes this approved historical input separately.

Semantic diagnostics include exact `unresolvedValueIds`, current and historical
ID sets, the source key/category and the failed evidence requirement. Current SKU
draft options do not substitute for immutable SKU-schema evidence, even if archived
or present in stored answers. Baseline output-table entries are mappings, not option
evidence; the factory captures `allowed` from the supplied catalog options only.
Source issues do not prevent safe draft creation/save. The UI separates name/key
errors, structural errors, publication source proof and product test-readiness.

Schema-scoped aliases carry a free-text `evidence` claim. The repository has no durable cross-key lineage that can verify equivalence. Source validation checks declared schema/category/key ownership, then rejects otherwise resolved aliases with `SOURCE_REFERENCE_UNSUPPORTED`; unresolved ownership uses `SOURCE_REFERENCE_UNRESOLVED`. Non-SKU alias lineage likewise cannot be inferred. The pure alias interface/parity tests remain unchanged. Successful reference validation explicitly does not certify production acceptance.

Draft test-preview requires both the requested revision and hash. It loads only stored product identity, schema link, answers, manual subjects, weight and final UAH price; caller-authored products/prices and unknown command fields are rejected. Missing requested IDs return `422 TEMPLATE_PRODUCTS_MISSING` with `details.missingProductIds`. The preview may inspect excluded products explicitly requested by ID; it does not perform normal export selection. It returns draft-only evaluator results, no signed token, snapshot, audit mutation, repair, price recalculation, exposure or cursor update.

Events `export_template.created`, `.draft_updated`, `.published`, and `.activated` commit with their mutations. Details contain IDs, hashes and revision/generation changes, not definitions or products. Audit failure rolls back all changes; failures, no-ops and completed retries emit no success event. The audit reader exposes only the public `definitionHash` exception to its general hash redaction; `audit.view` remains Administrator-only.

Snapshot binding is described below. Recount target cleanup, lifecycle routing, the editor and durable sessions are implemented. Target catalog/alias lineage, frozen-rule/mapping decisions, measurement units and fresh controlled Magento acceptance remain operational matters; see [pending work](README.md#deferred-work-and-operationally-pending-items).

## Published preview and snapshot binding

This is a server opt-in on the existing endpoints, not a default exporter switch.
The discriminator is exactly `requestContract: "template-v1"`. Omission keeps the
legacy mapper, ordered normalized SKU anchor identity, open upper bound and profile
behavior. Any supplied unknown discriminator, including `"legacy"` or null, fails
with `422 EXPORT_CONTRACT_INVALID`. Dedicated price endpoints are unchanged.

For example, system-mapper manual preview/capture uses the same anchors and the returned expectation (mandatory for new captures after lifecycle activation):

```json
POST /api/export/preview
{"fromSku":" BR-A ","toSku":"br-b"}

POST /api/export/snapshots
{"fromSku":" BR-A ","toSku":"br-b","previewExpectation":"<returned 64-character fingerprint>","idempotencyKey":"legacy-operation-1"}
```

Its create response retains `id`, `status`, `fileName`, `rowCount`, `generatedAt`
and `artifacts`; it has no template attribution. A legacy `{ "mode": "new" }`
preview still requires its returned anchors in the subsequent legacy create body.
Existing `internal-legacy` snapshots remain readable/retryable; new internal-only creation is a pre-activation compatibility path. See [capture boundaries](EXPORTS.md#exact-immutable-capture).

Template capture modes are `new`, `manual` (default), and `replacement`. Replacement additionally binds `productId` and decimal-string `deliveryVersion` and requires the active lifecycle gate. Update is a queue whose rows use explicit same-SKU/manual capture, not a fourth request mode.

Template selection defaults to `{ "mode": "active" }`, or explicitly pins both
IDs. A family ID alone never selects its latest version. Only compatible published
versions can be resolved; legacy/null activation returns
`422 EXPORT_TEMPLATE_NOT_SELECTED`. `internal-legacy` is incompatible with this
contract. Draft test-preview returns no creation token.

```json
POST /api/export/preview
{
  "requestContract":"template-v1",
  "mode":"new",
  "selection":{"mode":"active"}
}

POST /api/export/preview
{
  "requestContract":"template-v1",
  "fromSku":"BR-A",
  "toSku":null,
  "selection":{
    "mode":"explicit",
    "templateId":"11111111-1111-4111-8111-111111111111",
    "versionId":"22222222-2222-4222-8222-222222222222"
  }
}
```

Example new-mode preview response (IDs, hash, timestamps and opaque token below are
illustrative values; use the actual returned token and installed published IDs):

```json
{
  "mode":"new",
  "range":{"fromSku":"BR-A","toSku":"BR-A","resolvedToSku":"BR-A","exportedToProductId":420},
  "representedCount":1,
  "readyCount":1,
  "errors":[],
  "requestContract":"template-v1",
  "intent":{"requestContract":"template-v1","profile":"magento-products-v1","mode":"new","fromSku":null,"toSku":null,"selection":{"mode":"active"}},
  "template":{"templateId":"11111111-1111-4111-8111-111111111111","versionId":"22222222-2222-4222-8222-222222222222","definitionHash":"<64 lowercase hex characters>","evaluatorVersion":"magento-declarative-1","outputContract":"magento-products-v1","formatVersion":1,"activationGeneration":"7"},
  "previewToken":"<opaque ep1 token>",
  "represented":[{"productId":420,"group":"BR","sku":"BR-A","status":"ready","artifactRows":2}],
  "artifacts":[{"groupCode":"BR","groupName":"Браслети","profileVersion":"magento-products-v1","fileName":"amber-magento-BR-magento-products-v1.csv","productCount":1,"rowCount":2}]
}
```

Create sends **the same caller intent** and adds the returned token and key:

```json
POST /api/export/snapshots
{
  "requestContract":"template-v1",
  "mode":"new",
  "selection":{"mode":"active"},
  "previewToken":"<returned previewToken>",
  "idempotencyKey":"template-operation-1"
}
```

The key can instead be supplied through `Idempotency-Key`, as before. Creation
returns HTTP 201 with the existing fields plus `requestContract`, `template`
(the same safe effective-version shape) and `inputFingerprint` (SHA-256).
`GET /api/export/snapshots/:id` adds the same provenance without returning product
answers, definitions or tokens. Download URLs and filenames do not change.
For mode:new, omitted caller anchors stay null in intent; returned resolved anchors
belong to the operation's separate capture evidence. Adding those anchors only at
create changes intent and fails binding validation. Callers can supply anchors at
both stages, in which case they must match the server's pending range at preview
and capture. Completed retries never derive a new operation from today's cursor.

Preview uses `REPEATABLE READ READ ONLY`, the full authoritative eligible range,
stored final prices/answers/manual subjects, persisted definition and source
validation. The admin preview's 100-ID limit does not apply. Existing evaluator
work/cell/64 MiB output limits apply and fail explicitly without truncation.
Frozen requiredness/visibility is not recaptured from live rules. Source conflicts
and unresolved references still fail. Empty new previews have `range:null`, zero
counts and `previewToken:null`. Not-ready previews also have no token; all
represented products must be ready before durable creation.

The token uses `ep1`, purpose `amber:published-export-preview:v1`, HMAC-SHA256 with
a purpose-derived key from the existing required `SESSION_SECRET`, integer
issue/expiry seconds and a 15-minute lifetime for new creations. Maximum token
size is 8192 bytes. No random per-process signing fallback exists. Restart with
the same configured secret preserves verification; changing that secret
invalidates supplied old tokens, while authorized tokenless completed retries
remain available. Signature comparison is constant-time. Tokens are not logged,
stored in audit details or treated as authorization capabilities.

The streaming typed SHA-256 fingerprint preserves missing/null/blank/zero and
array order. It covers normalized intent; effective immutable version/hash/
evaluator/output/format; active generation; resolved range and ordered products;
product ID/SKU/category/exclusion, weight, final UAH, complete stored answers,
manual subjects and schema link; relevant repository source/schema evidence;
the ordered live non-SKU internal-column projection; and the confirmed cursor
for new mode. Bigint selection counters remain decimal strings. Draft edits and
pricing/rate changes alone do not stale it. Full lifecycle counters, route and activation generation also participate in capture binding. Price exposure remains handled by the existing capture locks. Bounded ranges exclude
later inserts beyond their upper ID; open ranges include them at the capture
instant. Template selection A → B → A stales an unused active-selection token; explicit pins do not bind template-selection generation, but still bind lifecycle gate/input state. A product committed after the RR snapshot starts remains outside that
capture and eligible for later work.

| Existing key / supplied evidence | Result |
| --- | --- |
| Matching legacy anchors/profile | Original stored snapshot, independent of activation |
| Matching template intent and original signed binding | Original snapshot even after confirmation, product/cursor/activation changes or expiry |
| Matching template intent, token omitted | Original snapshot; no active resolution, compilation, source validation or activation permission |
| Supplied token has different effective version, generation, input or resolved range | `409 EXPORT_IDEMPOTENCY_CONFLICT` |
| Contract/profile/ordered anchors/template mode/explicit IDs differ | Conflict; no duplicate snapshot |
| Unused key without token | `422 EXPORT_PREVIEW_REQUIRED` |
| Malformed, wrong-purpose, tampered or oversized token | `422 EXPORT_PREVIEW_INVALID` |
| Unused key with expired or future-issued token | `409 EXPORT_PREVIEW_EXPIRED` |
| Unused key with changed bound state or RR serialization failure | `409 EXPORT_PREVIEW_STALE`, after fresh winner recovery |

Legacy range/profile conflicts retain their previous error shape. Template/cross-
contract conflicts use `EXPORT_IDEMPOTENCY_CONFLICT`. Other explicit input errors
are `EXPORT_SELECTION_INVALID`, `EXPORT_MODE_INVALID`, `EXPORT_PROFILE_INVALID`
(422); incompatible definitions/source evidence use existing `TEMPLATE_INVALID`,
`TEMPLATE_VERSION_INTEGRITY`, `TEMPLATE_SOURCE_INVALID`; output/work limits use
`422 EVALUATION_LIMIT`. Readiness failures retain `422 MAGENTO_NOT_READY`.
Preview/create JSON errors include `code` where classified and `errors` for
diagnostics. No automatic refresh, rebinding or replacement key occurs.

Capture and confirmation follow the [authoritative lock order](EXPORTS.md#preview-idempotency-and-concurrency), including full lifecycle state and the pre-transaction activation gate. Repeatable-read waits never refresh an old snapshot; fresh winner recovery happens after rollback. Generation, initial exposure, parent,
every artifact and the existing `export_snapshot.created` event share one
transaction. Template events add concise contract/template/version IDs; retry
does not recreate exposure, artifacts, attribution or audit.

Preview requires `exports.view`; create/confirm require `exports.create` with
the existing session, active-user and CSRF boundary. Active export does not need
template management. A new explicit selection that is not currently active also
requires `export_templates.activate`; the active-version exception is protected
during capture. Completed retries need ordinary export authority only. Stored
downloads and confirmation never compile or inspect current product readiness.
Returning selection to legacy neither rewrites artifacts nor resets cursor,
exposure or pending revisions.

## Editor and controlled workflow

The current editor lives inside **Інтеграція Magento → Категорії та правила**
at `/admin/magento/rules/*`. Historical `/admin/export-templates/*` URLs redirect
with their complete suffix, search and fragment preserved. Both entry paths require
`export_templates.view` before mounting the administrative workspace.
Candidate preparation/save/clone/validation require
`manage`; draft test-preview also needs `exports.view`. Publication and candidate
selection independently require `publish` and `activate`. No role-name or
`users.manage` dependency was added. See the current editor and source-support contracts below.

Category details read the exact immutable template version pinned by the active
binding. No latest publication or CSV selection is substituted if that version is
unavailable. The ordinary integration view presents fields vertically: Magento
field, Amber source, persisted rule, example, and delivery ownership where an
exact binding is available. Computed examples remain uncalculated until an
explicit server preview; the client does not evaluate expressions. Selecting a
field opens the existing guarded inspector. The full grid and complex expressions
remain available under **Розширена таблиця правил** without any automatic rewrite.

Rule publication (**Зафіксувати версію правил**) and Magento binding publication
remain two explicit independent operations. The receipt links the exact published
version into successor preparation. Neither saving nor publishing a template
switches the active Magento binding. Current vs draft vs historical versions are
identified separately, and dirty navigation remains guarded across editor tabs.

The historical CSV system profile and activation controls remain under explicit
compatibility disclosure. Opening current integration rules does not request CSV
activation state; opening that disclosure performs the existing authorized read.
Selection still uses the unchanged generation-protected command. These controls
do not select or publish a Magento binding.

`GET /api/export/template-options` requires `exports.view` and returns only
`generation`, `activeVersionId`, `implementation`, `defaultExporter: "legacy"`,
and safe publication identities (`templateId`, `versionId`, `versionNumber`,
`displayName`). Ordinary exporters receive only the selected publication;
`export_templates.activate` additionally permits other publication identities.
No definitions, draft data, source catalog, products or tokens are returned.
This is descriptive metadata; published preview/capture still authoritatively
resolve and verify compatibility and selection.

`/exports` supports delegated exporters without product/catalog permissions. The controlled published-template UI uses durable [sessions](SHARED_EXPORT_SESSIONS.md), explicitly separate from system-mapper exports. No unavailable publication silently falls back to the system mapper.

Draft test-preview is read-only and accepts 1–100 explicit unique product IDs;
missing IDs are errors. It compiles the complete six-group definition for safety,
then checks source proof for the dependency closure of the groups loaded from
those stored products, in the same repeatable-read read-only transaction as the
saved revision/hash and evidence. The compiler collects all expression branches,
transitive bindings, both rows, readiness and captured visibility contracts;
source validation retains alias/provenance requirements. Unknown dependencies
fail closed. An unresolved dependency blocks the entire requested sample.
Unrelated blockers are returned as `globalSourceDiagnostics`, with
`publicationReady: false` and authoritative `sampleProducts` identities. The UI
keeps these separate from full-template validation and product readiness, and
marks changed-selection/revision results stale. This scoped behavior applies
only to draft test-preview: full validation, publication and published export
continue requiring all source evidence. A sample yields no export token.
The ordinary editor exposes standard question-based attribute mappings directly,
preserving frozen contracts/guards and coordinating each field's readiness refs.
Read-only `/admin/export-templates/source-details` (template view) supplies
bounded exact-source labels, with current catalog and immutable historical
metadata distinguished. It never updates evidence or the definition.
`/admin/export-templates/sample-products` (template manage + exports.view)
searches literal SKU fragments of 2–160 characters, exact matches first,
20 products/page via bounded `offset`; it includes incomplete/archived products
and returns only ID/SKU/category/status. The picker keeps IDs internally and
retains the 100-product limit. A quote-aware client presenter renders the same
server CSV as a table, with unchanged bytes available in a secondary view.
Published preview is a separate read-only check yielding
an opaque token. Explicit file creation is a real export and may establish
exposure. Stored downloads never confirm; normal confirmation remains a separate
"Завершити експорт" action. The separate price sequence is documented in [Exports](EXPORTS.md#separate-price-stream).

Create retains its original payload, token, effective evidence and idempotency
key through rerenders, transport/ambiguous failures and internal navigation.
Unused stale/expired preview responses require an explicit fresh check and a new
operation. Completed uncertain retries are attempted with the original key/token
without a client TTL gate. No token goes to URLs, logging or browser storage.
The retained direct compatibility controller's in-memory operation does **not**
survive reload, closing the app or logout. The shipped controlled UI now uses
durable sessions instead: `/exports/sessions` stores the original operation before
generation, supports explicit invitations/acceptance and recovers its exact result
through authorized lists after login/reload. Default legacy export stays separate.
Known historical snapshot IDs can be opened explicitly; unknown pre-feature
operations receive no speculative matching/backfill. See [shared export sessions](SHARED_EXPORT_SESSIONS.md).


## Editable output columns

Local interpolation add/rename/remove uses literal/text/source/lookup expressions. Renaming explicitly updates references; removal stays disabled while text references the slot. Forms check safe/unique names and a 16-slot bound; server compilation enforces types, placeholders, depth and size. Shared bindings/tables retain consumer warnings. Local copies preserve unrelated cells, sparse EN and no-op canonical hashes. Published versions remain immutable.

The template workspace opens the actual code-backed system profile without database
writes. Explicit copy creates a normal draft. Existing v1 drafts use an explicit
revision/hash-checked upgrade to magento-products-columns-v2; add, rename,
duplicate, move and delete persist real output columns and independent base/EN
rules. The shared grid is the primary design workspace and also presents server
preview CSV and immutable stored artifacts.

Protected full-product headers are sku, store_view_code, name,
attribute_set_code, product_type and price. Optional-output readiness ownership
is separate from global source evidence. Source choices use the authorized
registry; target attribute existence in Magento is not asserted. Migration 038
extends supported artifact/binding identities without changing historical
migrations, definitions, goldens or dedicated price export.

Ordinary preview includes finalized CSV and an authoritative expectation, required for new system-mapper capture after lifecycle activation.
Changed inputs require refresh; completed original-key retries return stored
bytes. Session grids retain published binding/configuration identity and durable
attempt recovery. First generation requires a matching table; uncertain retries
retain the original attempt even after a newer preview. All visible pages come
from one complete response, 50 rows at a time; normal export is not limited to
100 sample products. Snapshot grids read stored CSV through existing access rules.

Migration 038 defines the additional output identity; current source support is described below. Historical implementation/acceptance evidence is in the [archive](archive/README.md).

## Historical source support

`sourceSupport.version: historical-source-support-v1` pairs only with
`evaluatorVersion: magento-declarative-2`, independently of either fixed
`magento-products-v1` or editable `magento-products-columns-v2` output. Definitions
without the extension keep evaluator 1, their original strict claims, hashes and
execution. This policy is the default for explicit new definitions based on current candidate/system rules. Existing definitions still require explicit opt-in;
this is not retroactive parity with the ten legacy goldens or a change to the
system exporter / dedicated price stream.

The closed `sourceSupport.sources` object declares the storage identities
`NM.extra` and `AR.size` when present. Each has `semanticValues`, `deferredValues`
(decimal ID strings), and `placeholder` (`numeric-zero-v1` only for NM.extra,
`none` for AR.size). Existing `questionContracts.allowed` remains the exact
captured catalog membership; existing display labels, tables and row rules are
preserved. It no longer asserts semantic support for these explicitly governed
sources. Semantic values must have immutable historical evidence; only the
approved AR IDs 29/30/31 may be deferred. Unknown/incomplete/conflicting policies,
other unresolved claims and unverified aliases remain blocking. Lookup outputs
are never source authority. All declaration fields participate in canonical JSONB
and definition/compilation identity.

Actual consumed reads, including custom columns, duplicated descriptors, refs,
lookups, catalog conditions and readiness, use one lazy support check. The server
batches the associated immutable schemas on the existing transaction; the pure
evaluator caches one historical reconstruction per evaluated product. JSON proof
flags cannot authorize a product. Missing/null/blank handling stays unchanged.
NM numeric zero requires category/schema ID/encoded version agreement, an optional
historical extra question, no semantic-zero option or conflicting all-zero code,
and successful `decodeStoredSkuAnswers` reconstruction with `is_placeholder=true`
and `value_id=null`. Exact string `"0"` is **not** a placeholder. A genuine semantic
zero (numeric or exact string) follows the normal supported semantic path, including
own-schema reconstruction. Other zero sources and calibration remain unchanged.

AR values need both frozen semantic support and matching reconstruction in their
own schema. Deferred mappings may publish, but cannot export a present deferred
value, even after a later SKU schema includes it. Promotion requires explicitly
moving that ID from deferredValues into semanticValues in a new draft/publication,
plus historical and actual product evidence. Existing AR membership/post-check
still controls readiness. The support update never writes mappings: approved
29→75×78, 30→74×80, 31→70×70 entries are retained **if present**, including exact
whitespace; missing entries remain ordinary editable mapping/readiness work.

Normal UI for an eligible existing saved draft: **Перевірка → Переглянути зміни
→ Застосувати до чернетки**, under **Доступне оновлення правил сумісності шаблону**. Save/cancel local
column work first. Preparation is read-only and displays a detached summary;
application requires the original revision/hash and preparation fingerprint,
rechecks coherent evidence, then uses the existing authorized CAS/audit transaction.
Stale evidence conflicts; repeated preparation/application of an unchanged policy
does not increment revisions or promote new live options. Successful application
invalidates preview evidence. Output contract, dynamic order, labels, custom
base/EN cells, names, mappings, local references and readiness relationships remain
exact. Published definitions require cloning into a draft first. A publication
clone initially preserves its exact evaluator/policy, output structure and
definition hash, including policy absence; only subsequent explicit draft
prepare/apply can upgrade it. No GET, validation, publication, startup or no-op
save attaches support to existing definitions.

New-template and editable-current-system-copy actions request the same server
`/candidate` capture. It materializes the current catalog and applies the current
policy using authoritative evidence within the same read-only transaction,
before final diagnostics and hashing. Creation does not need a separate support-policy checkbox.
The read-only `/system` profile still describes evaluator 1 and the unchanged
ordinary exporter; copying it explicitly requests a new current candidate.
The generic create/save commands preserve supplied definitions (including safe
incomplete drafts); they do not reinterpret imported/legacy definitions.

Draft responses add `sourceSupportUpdate: {status, currentPolicy, code?}`.
`available` means a policy-free definition can accept the closed support contract
and has a support/evaluator delta; `current` means its valid current policy is already attached; `unsupported`
means compilation cannot establish an upgrade path, including unknown/newer
policies and incompatible legacy aliases. This read model checks only the frozen
contract/upgrade shape, not source proof or catalog drift.
Only server-reported `available` renders the upgrade action. Prepare adds the
same status while retaining `changed`, complete definition, hash and preparation
fingerprint for existing callers. A no-op response offers no application UI;
old callers can still apply it without a revision/audit change. Unsupported
preparation remains `422 TEMPLATE_INVALID`; stale revision/hash/evidence remains
`409 TEMPLATE_DRAFT_CONFLICT`. Catalog labels/options or new historical schemas
do not turn a current policy into an update or promote its deferred membership.

API commands are POST `/:id/draft/source-support/prepare` with saved
`expectedRevision` / `expectedDefinitionHash`, and POST
`/:id/draft/source-support/apply` with those fields plus `preparationHash`, below
`/api/admin/export-templates`. Both require `export_templates.manage` and the
existing active-user/CSRF boundary. GET `/candidate` defaults to current support;
the existing explicit `?supportPolicy=historical-source-support-v1` remains
compatible. Both prepare a detached new candidate without writing. Preparation is not validation
or publication. Unknown policy versions fail closed.

Draft samples retain selected-group source scope. Published preview, direct capture
and shared-session preparation/final capture use the same support mechanism;
policy hash, product association and full relevant historical schema facts bind
the existing fingerprint. Capture rechecks locked products without changing lock
ordering, atomic result links, exposure or cursors. Failed represented products
block complete capture. Completed retries/downloads/confirmation continue using
stored evidence and bytes, never today's policy.
