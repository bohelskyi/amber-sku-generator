# Exports

For the current durable private/shared controlled workflow, see
[Shared export sessions](SHARED_EXPORT_SESSIONS.md). This extends the earlier PR4
client-only recovery boundary below without changing legacy/default or price export.

## Supported workflow

The legacy direct CSV endpoint remains disabled with `410`. The operator's full-product workflow is:

1. preview the new products after the confirmed product-ID cursor without entering a SKU;
2. create one immutable normal snapshot only when every represented product is Magento-ready;
3. download every represented Magento group CSV;
4. explicitly accept the snapshot as consumed.

Accepting a snapshot advances the product cursor; it does not assert that Magento imported the files. Downloading one file never confirms the snapshot. The existing internal CSV remains stored and downloadable for compatibility, but has no operator export button. The dedicated `sku,price` stream keeps its existing server rules; UX-3 separates its client review, create, download and confirmation actions (see below).

`GET /api/export/status` supplies the operator's pending eligible-product count and latest confirmed export time. `POST /api/export/preview` with `{ "mode": "new" }` derives the first and last eligible product after the confirmed cursor by product ID and is read-only; it returns an empty preview when none exist. After preview, the client sends those server-resolved anchors with `mode: "new"` to snapshot creation. The server derives the pending range again, rejects stale anchors or a changed cursor, locks and revalidates the products, and creates nothing on a readiness error. The operator can still use the collapsed re-export section with an explicit single SKU or From/To range. That path retains the existing snapshot and idempotency behavior.

`exports.view` permits export status and existing snapshot download. `exports.create` controls both snapshot creation and confirmation. Initial system-role mappings give all three roles view access and only Administrator create/confirm access; Manager and Storekeeper permissions can later be changed through role administration.

## Range and row semantics

Requested endpoints are existing SKU anchors, but the normalized range is resolved by product ID/creation order rather than lexicographic SKU ordering. Reversed endpoints are normalized. Products with `exclude_from_export=1` are always omitted.

The internal compatibility CSV contains the SKU, stored final UAH price (including exact manual decimals when optional rounding was not selected), a derived bracelet/necklace size field, and configured free-text fields. Recount apply still excludes both the corrected source and successor from the normal export queue.

Magento Products v1 writes one CSV per represented group: Браслети, Намиста, Кулони, Чотки, Картини, and Сувеніри. Souvenir products with semantic `souvenir=5` use the Камінь attribute set and category paths. There is no Silver or separate Stone workflow. The six worksheet header lists and order are fixed in `magento-products-v1.js`. Each product has exactly a complete base row (blank `store_view_code`) and an EN row containing SKU, store view, name, `product_type=simple`, and defined EN SEO fields. Descriptions stay blank. Categories are comma-separated. The mapper reads stored `details.answers` value IDs and the final stored UAH price; it never decodes characteristics from SKU text or uses editable option labels. Profile constants include `simple`, `base`, `product_online=2`, `Catalog, Search`, quantity 1, stock status 1, `old_product=No`, and `is_ownproduction=Yes`. KL dimensions use current `pedant_size`, with `exact_size` only as a fallback for stored legacy answers.

EN rows carry the same `attribute_set_code` as their base row, including Камінь for Stone souvenirs. CH numeric attributes `dovzhyna_namystyny`, `diametr_namystyny`, and `dovzhyna_vyrobu` accept stored decimal commas or dots and serialize with a dot (`15,8` becomes `15.8`). Invalid present numeric values fail Magento readiness. The existing `rozmir_kameniu` formatting is unchanged.

Missing mandatory values or unmapped semantic IDs are grouped by SKU and Magento field in `POST /api/export/preview`. Preview does not advance cursor or exposure. `POST /api/export/snapshots` rechecks under product locks and rolls back parent snapshot, artifacts, audit, and exposure together on any readiness error. Undefined optional SEO stays blank. Souvenir subtypes without approved English names remain not-ready. Historical `CH.is_calibrated=3` is outside the Magento payload and does not by itself block export; its separate catalog/data remediation remains pending business definition.

For a souvenir without an approved automatic semantic name, readiness reports `manual_name_required`. An operator can save a UA/EN subject pair through `/api/product-magento-name/preview` and `/apply`. The server stores only the pair on the same active product and audits old/new values in the same transaction; product identity, answers, price, correction history, flags, and export revisions do not change. The saved pair takes precedence over the automatic name. Final names are `{UA subject} з бурштину. Арт: {sku}` and `Amber {EN subject}. Art: {sku}`. Export never translates or regenerates the stored subjects. Already generated artifacts remain immutable; a later same-SKU re-export captures the updated names.

`GOOGLE_TRANSLATION_API_KEY` is optional. When absent or blank, the server starts normally, `GET /api/export/status` reports `translationSuggestionAvailable=false`, the suggestion control is hidden, and operators enter both UA and EN subjects manually. Readiness depends on the saved pair, never provider availability. When configured, the status reports `true` and the client offers an editable EN suggestion. `POST /api/product-magento-name/suggest` sends the server-only key to Google Cloud Translation API v2 Basic in the `X-Goog-Api-Key` header, never in a URL or browser response. Direct calls without a configured key return `503 TRANSLATION_NOT_CONFIGURED` without contacting Google. Provider failures save nothing; manual EN entry remains available. Export itself never requests translation.

A successful direct or request-completed in-place price change increments one durable revision in `product_export_revisions`. Multiple changes coalesce on that row. Normal product snapshots never add an older product merely because its price changed and never rewind the product cursor.

The dedicated price-export workflow uses `/api/price-export/*` and immutable `price_export_snapshots`. Its CSV is exactly `sku,price`, containing the current authoritative final UAH price. A revision is eligible only after `has_product_snapshot=true`, because only then may Magento have an older SKU price. A normal snapshot can establish this exposure when it legitimately contains the product; generation records immutable revision evidence but never confirms it. Only explicit normal-snapshot confirmation may advance the initial revision captured by that snapshot. After exposure, only dedicated price snapshots consume price revisions.

Price snapshot creation captures all eligible non-excluded pending products and does not accept a range or touch the normal cursor. `exclude_from_export=1` suppresses both streams without clearing pending state; excluded pending rows are reported separately. Price snapshot confirmation advances each row with `GREATEST` only to its captured revision, so later changes and concurrent or out-of-order confirmations remain pending. A duplicate idempotent update is preferred while initial normal exposure is unconfirmed.

## Immutable snapshots and idempotency

Snapshot payloads and CSV content are written once and protected from mutation by database triggers in both streams. Snapshot creation holds stable product/revision locks while capturing evidence, so a later price change cannot be mistaken for the represented version. Creator provenance is immutable, and confirmer provenance cannot change once set. Never regenerate or modify a stored snapshot after creation.

Creation stores the authenticated local application user in nullable `created_by_user_id` and appends one transactional `export_snapshot.created` event referencing the immutable snapshot with only its range and row count. Magento artifact records are inserted in the same transaction and cannot be updated, deleted, or truncated. Historical snapshots have no Magento artifacts and are never regenerated from current products. Idempotent reuse returns the original snapshot without changing its creator or writing another event.

A nonempty idempotency key is required. The creation route accepts the `Idempotency-Key` header or `body.idempotencyKey` and binds the key to the normalized `fromSku`/`toSku` range:

- reuse with the same range returns the same snapshot;
- reuse with a different range returns `409`;
- reuse for a different profile returns `409`;
- the same conflict rule applies to the loser of a concurrent insert race.

The operator client uses the default Magento profile. Explicit `profile=internal-legacy` exists only for old API/test compatibility and is absent from the operator UI.

An already exposed product can be exported again by requesting its same-SKU range with a new idempotency key. The new artifact captures its current locked state; old artifacts stay unchanged. This uses the same snapshot/cursor/exposure model, with no metadata queue or new cursor. The informational-update response uses authoritative `has_product_snapshot`, cursor, and exclusion evidence to guide this choice, including generated but unconfirmed exposure.

## Confirmation and cursor

Confirmation is idempotent and row-locks the snapshot. The first confirmation stores the authenticated local application user in nullable `confirmed_by_user_id` and appends one transactional `export_snapshot.confirmed` event referencing the snapshot's exported-to product cursor. Repeated confirmation preserves the original confirmer and emits no duplicate event while retaining cursor and re-export high-water repair.

For each represented re-export, confirmation advances `confirmed_revision` with `GREATEST` only as far as the immutable revision stored in that snapshot. If the product changes again after snapshot creation, confirming the older snapshot leaves the newer revision pending. Revision rows are locked in stable product-ID order, so concurrent or out-of-order confirmations cannot clear a newer pending change. Independently, the singleton product-ID cursor still advances with `GREATEST(exported_to_product_id)` and never moves backward; `last_snapshot_id` follows the non-regressing cursor. Legacy `export_events` remain only for status compatibility.

## CSV safety

Fields retain correct quoting/escaping for commas, quotes, and newlines. Text beginning with spreadsheet formula sigils `=`, `+`, `-`, or `@`—including after leading whitespace or a tab—is prefixed so spreadsheet software does not execute it as a formula.

## Confirmed Magento Products v1 acceptance

On 2026-09-23, the operator confirmed that all six CSV files from the fresh 40-fixture snapshot passed Magento **Check Data** with **File is valid**.

The run used a clean local restored production copy with startup and migrations through `034` healthy. Forty fresh products were created through authoritative preview/save services: two each of BR, NM, KL, CH, and AR, plus 30 SV products. Required manual names were saved through the existing manual-name preview/apply service. The explicit product-ID range was verified to contain only these fresh fixtures, with no older pending products; Magento preview reported `represented=40` and `ready=40` before snapshot creation.

| Group | CSV file | Products | Magento Check Data |
| --- | --- | ---: | --- |
| BR — Браслети | `amber-magento-BR-magento-products-v1.csv` | 2 | File is valid |
| NM — Намиста | `amber-magento-NM-magento-products-v1.csv` | 2 | File is valid |
| KL — Кулони | `amber-magento-KL-magento-products-v1.csv` | 2 | File is valid |
| CH — Чотки | `amber-magento-CH-magento-products-v1.csv` | 2 | File is valid |
| AR — Картини | `amber-magento-AR-magento-products-v1.csv` | 2 | File is valid |
| SV — Сувеніри | `amber-magento-SV-magento-products-v1.csv` | 30 | File is valid |

This records Check Data validation, not a completed Magento import. The fixture generator, manifest, reports, and generated CSVs remain local-only and are not repository deliverables. The accepted mappings and export behavior require no further changes unless a real defect is found; explicit `url_key` generation remains deferred.

## Export-template administration (PR2)

Migration `035_export_templates.sql` adds `export_templates`, `export_template_drafts`, `export_template_versions`, and `export_template_activation`. Default/legacy product export and dedicated price export do not read these tables. Selection responses retain the PR2 compatibility fields `metadataOnly: true` and `effectiveExporter: "legacy"`, describing default dispatch. PR3 explicitly opted-in requests read selection; publishing or selecting alone does not switch default dispatch, expose products, advance cursors/revisions or alter snapshots. Initialization creates only a legacy selection at generation `1` with a null version/actor, plus permissions. No baseline definition is captured or published at startup.

All endpoints below are relative to `/api/admin/export-templates` and retain authenticated active-user and unsafe-method CSRF enforcement. Revision/generation/version-number fields are decimal strings, preserving PostgreSQL bigint precision. Expected counters also accept safe positive JSON integers. Errors use JSON `error`, `code`, and optional `details`.

| Method/path | Body/result | Required capability |
| --- | --- | --- |
| `GET /` | Family list with draft revisions and publication counts | `export_templates.view` |
| `GET /:id` | Family, current draft, and complete immutable versions | `export_templates.view` |
| `GET /sources` | Approved product fields, operations, limits, units and safe current/historical reference hints; no product rows | `export_templates.view` |
| `GET /candidate` | Read-only current Magento candidate captured from the actual catalog, including current source-support policy before final compilation/hash; no persistence/publication/selection | `export_templates.view` **and** `export_templates.manage` |
| `GET /activation` | Selection generation/version and metadata-only status | `export_templates.view` |
| `POST /` | `{key,displayName,definition?}`; creates family and revision `1`; omitted definition is `{}` | `export_templates.manage` |
| `PUT /:id/draft` | `{expectedRevision,definition}`; returns draft/revision/canonical hash | `export_templates.manage` |
| `POST /:id/draft/from-version` | `{expectedRevision,versionId}`; copies a publication from the same family into the draft | `export_templates.manage` |
| `POST /:id/validate` | `{expectedRevision,expectedDefinitionHash}`; full stored-draft validation and reference diagnostics | `export_templates.manage` |
| `POST /:id/test-preview` | `{expectedRevision,expectedDefinitionHash,productIds}`; 1–100 unique integer IDs, loaded in product-ID order | `export_templates.manage` **and** `exports.view` |
| `POST /:id/publish` | `{expectedRevision,expectedDefinitionHash}`; server-assigned version, hash, actor and timestamp | `export_templates.publish` |
| `PUT /activation` | `{expectedGeneration,implementation,templateVersionId,reason?}`; `legacy` requires null version, `template` requires a supported publication | `export_templates.activate` |

Only Administrator receives these capabilities initially. They can be explicitly delegated to editable roles independently of access-administration permissions. Static `/sources` and `/activation` routes precede `/:id`.

Draft save permits incomplete definitions, including unsupported format/evaluator values for later editing. It enforces PR1B JSON/size/depth limits, plain JSON data, safe keys, no executable accessors, and PostgreSQL-compatible Unicode; NUL and unpaired surrogates are rejected. The shared PR1B canonical hash is available for incomplete drafts, but their response is explicitly `state: "draft"`. Saving is not publication validation. Full validation, preview and publication reuse the original PR1B compiler and evaluator; there is no alternate schema or mapper.

Draft writes compare `expectedRevision` before considering no-op equality. Stale writes return `409 TEMPLATE_DRAFT_CONFLICT`; an identical definition and base-version reference at the expected revision preserves actor/time/revision and emits no event. From-version copying preserves the published source and advances the draft only when definition/base reference changes. Cross-family versions are rejected by the service and composite FK. Template keys are permanent and no delete workflow exists.

Publication runs one transaction: shared access-admin lock, current actor/capability recheck, family lock, draft lock, completed-retry lookup, revision/hash preconditions, full validation, coherent repository source reads, locked version allocation, immutable insert, and audit. The complete detached definition includes all constants, rules and question contracts. INSERT results are recompiled and their persisted hash checked; mismatches fail without rewriting provenance. Published UPDATE, DELETE and TRUNCATE are rejected, even for unreferenced versions. Actor references use `application_users.id`.

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

PR1B schema-scoped aliases carry a free-text `evidence` claim. The repository has no durable cross-key lineage that can verify equivalence. PR2 checks declared schema/category/key ownership, then rejects otherwise resolved aliases with `SOURCE_REFERENCE_UNSUPPORTED`; unresolved ownership uses `SOURCE_REFERENCE_UNRESOLVED`. Non-SKU alias lineage likewise cannot be inferred. The pure PR1B alias interface/parity tests remain unchanged. Successful reference validation explicitly does not certify production acceptance.

Draft test-preview requires both the requested revision and hash. It loads only stored product identity, schema link, answers, manual subjects, weight and final UAH price; caller-authored products/prices and unknown command fields are rejected. Missing requested IDs return `422 TEMPLATE_PRODUCTS_MISSING` with `details.missingProductIds`. The preview may inspect excluded products explicitly requested by ID; it does not perform normal export selection. It returns draft-only evaluator results, no signed token, snapshot, audit mutation, repair, price recalculation, exposure or cursor update.

Events `export_template.created`, `.draft_updated`, `.published`, and `.activated` commit with their mutations. Details contain IDs, hashes and revision/generation changes, not definitions or products. Audit failure rolls back all changes; failures, no-ops and completed retries emit no success event. The audit reader exposes only the public `definitionHash` exception to its general hash redaction; `audit.view` remains Administrator-only.

PR3 snapshot binding and retry integration are described below; PR4 owns the editor and controlled operational activation. Release prerequisites remain the previously investigated recount fix, target catalog/alias lineage review, frozen-rule approval, KL `addit=0` compatibility decision, narrow SV naming, malformed-input difference acceptance, measurement units, and fresh controlled Magento Check Data. Server implementation is not Magento acceptance or rollout readiness.

## Published export snapshots (PR3)

This is a server opt-in on the existing endpoints, not a default exporter switch.
The discriminator is exactly `requestContract: "template-v1"`. Omission keeps the
legacy mapper, ordered normalized SKU anchor identity, open upper bound and profile
behavior. Any supplied unknown discriminator, including `"legacy"` or null, fails
with `422 EXPORT_CONTRACT_INVALID`. Dedicated price endpoints are unchanged.

For example, an existing manual request remains:

```json
POST /api/export/preview
{"fromSku":" BR-A ","toSku":"br-b"}

POST /api/export/snapshots
{"fromSku":" BR-A ","toSku":"br-b","idempotencyKey":"legacy-operation-1"}
```

Its create response retains `id`, `status`, `fileName`, `rowCount`, `generatedAt`
and `artifacts`; it has no template attribution. A legacy `{ "mode": "new" }`
preview still requires its returned anchors in the subsequent legacy create body.
Legacy explicit `profile: "internal-legacy"` remains supported.

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
stored final prices/answers/manual subjects, persisted definition and PR2 source
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
pricing/rate changes alone do not stale it. Revision/exposure changes are handled
by capture locks rather than included as product facts. Bounded ranges exclude
later inserts beyond their upper ID; open ranges include them at the capture
instant. Active A → B → A stales an unused token; explicit pins have no generation
binding. A product committed after the RR snapshot starts remains outside that
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

New capture holds the existing access-admin advisory key in shared **session**
mode before beginning RR, then rechecks the actor. This deliberate pre-transaction
boundary prevents an access-lock wait from freezing stale permissions; readers
coexist, and access/activation writers keep their existing exclusive boundary.
It releases on the same connection after commit/rollback. Within RR the order is:
namespaced per-key transaction advisory lock → second completed lookup → selection
`FOR SHARE` and published-version resolution → eligible products `FOR SHARE` in
ascending ID → existing revision insertion/ascending revision locks and exposure
capture → new-mode cursor `FOR SHARE` → parent/artifacts/audit → commit.
There is no independently committed key reservation. Confirmation keeps
snapshot → revisions → cursor; dedicated price operations retain their old locks.

An advisory wait does not refresh an RR snapshot. Following rollback for the
specific `export_snapshots_idempotency_key_key` constraint, serialization or
relevant stale-preview/range failure, a fresh statement checks committed key
state and applies the **same** intent/binding comparison as an early hit. No
winner returns the classified original failure. Other integrity violations are
not interpreted as idempotency collisions. Generation, initial exposure, parent,
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

## Form editor and controlled client workflow (PR4)

`/admin/export-templates` requires `export_templates.view` before mounting the
administrative workspace. Candidate preparation/save/clone/validation require
`manage`; draft test-preview also needs `exports.view`. Publication and candidate
selection independently require `publish` and `activate`. No role-name or
`users.manage` dependency was added. See [PR4 details and limits](EXPORT_TEMPLATES_PR4.md).

`GET /api/export/template-options` requires `exports.view` and returns only
`generation`, `activeVersionId`, `implementation`, `defaultExporter: "legacy"`,
and safe publication identities (`templateId`, `versionId`, `versionNumber`,
`displayName`). Ordinary exporters receive only the selected publication;
`export_templates.activate` additionally permits other publication identities.
No definitions, draft data, source catalog, products or tokens are returned.
This is descriptive metadata; published preview/capture still authoritatively
resolve and verify compatibility and selection. No snapshot binding was changed.

`/exports` supports delegated exporters without product/catalog permissions and
reuses the existing ExportTools workspace. The product page also keeps ExportTools.
Both share one mounted controller above routes. The checkbox for controlled
published-template export starts **off**, even if a publication is selected.
Metadata reads occur only after opt-in; ordinary export never reads admin APIs.
No unavailable selection silently falls back to legacy.

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
"Завершити експорт" action. The current UX-3 price sequence is documented below.

Create retains its original payload, token, effective evidence and idempotency
key through rerenders, transport/ambiguous failures and internal navigation.
Unused stale/expired preview responses require an explicit fresh check and a new
operation. Completed uncertain retries are attempted with the original key/token
without a client TTL gate. No token goes to URLs, logging or browser storage.
The retained direct PR3 compatibility controller's in-memory operation does **not**
survive reload, closing the app or logout. The shipped controlled UI now uses
durable sessions instead: `/exports/sessions` stores the original operation before
generation, supports explicit invitations/acceptance and recovers its exact result
through authorized lists after login/reload. Default legacy export stays separate.
Known historical snapshot IDs can be opened explicitly; unknown pre-feature
operations receive no speculative matching/backfill. See the linked session guide.


## Table-first implementation — 2026-09-24

Templates now opens the actual code-backed system profile without database
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

Ordinary preview includes finalized CSV and an opt-in authoritative expectation.
Changed inputs require refresh; completed original-key retries return stored
bytes. Session grids retain published binding/configuration identity and durable
attempt recovery. First generation requires a matching table; uncertain retries
retain the original attempt even after a newer preview. All visible pages come
from one complete response, 50 rows at a time; normal export is not limited to
100 sample products. Snapshot grids read stored CSV through existing access rules.

See [the implementation and verification record](EXPORT_TEMPLATES_PR4.md#table-first-implementation--2026-09-24)
for exact contract, source-support boundary, migration and visual-QA limitations.

## Opt-in historical source support — 2026-09-24

`sourceSupport.version: historical-source-support-v1` pairs only with
`evaluatorVersion: magento-declarative-2`, independently of either fixed
`magento-products-v1` or editable `magento-products-columns-v2` output. Definitions
without the extension keep evaluator 1, their original strict claims, hashes and
execution. The separately approved 2026-09-25 lifecycle correction makes this
policy the default only for explicit new definitions based on the current
candidate/system rules. Existing definitions still require explicit opt-in;
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
before final diagnostics and hashing. The old creation checkbox is removed.
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

## UX-3: authoritative review, stored files and shared history

`/exports` shows **ПОПЕРЕДНІЙ ПЕРЕГЛЯД** before capture and a separate
**ЗБЕРЕЖЕНІ ФАЙЛИ** surface after successful capture. Ordinary system preview,
published/session preview and stored product/price CSV use `ExportDataGrid`.
Template Builder and its sample/editor grids are unchanged.

Preview is one complete server response, with its existing `tableFingerprint`
and ordinary `previewExpectation` or published signed binding. `checkedAt` is
the observation time, not a reservation. Range/publication edits discard the
review; successful relevant product/template mutations mark it outdated. On
window focus, the controller compares a new server fingerprint with the displayed
one and only marks stale; it never patches rows or silently replaces preparation.
Explicit recheck obtains new evidence. Capture still revalidates under its
existing locks. Local search, filters, pages and widths never enter requests.

Session actions remain distinct: save settings → **Перевірити товари** (read-only)
→ **Зберегти перевірку** (durable preparation) → **Створити файли** (capture).
Replacing saved preparation is an explicit secondary action. Uncertain attempts
retain their original identity and recovery path, even after a newer check.
Diagnostic rows are returned transiently by preparation; they are not persisted
in its bounded `preview_summary` and never become generation authority.

### Read-only API contracts

All paths below are relative to `/api`, authenticated, active-user gated and
require effective `exports.view`. Existing unsafe methods retain CSRF. Creation
and confirmation still require `exports.create`; downloading requires no create
permission. No new permission, migration, dependency or configuration is added.

| Method/path | Contract |
| --- | --- |
| `POST /export/preview` | Existing request/response fields and range semantics; adds `checkedAt`, `review`, and published-only `templateLabel` (display name/version number, outside binding identity). Session preview exposes the same transient projection. Empty new-product preview has empty files and null review identity. |
| `GET /export/snapshots/:id?includeRows=false` | Existing manifest plus immutable metadata below; excludes CSV bodies at SQL selection. Omitting the parameter preserves the previous manifest behavior, including all artifact CSV bodies. |
| `GET /export/snapshots/:id/magento/:group/csv` | Existing authorized stored bytes, used for both selected-file review and download. Every read checks access; never evaluates current products/templates. |
| `GET /price-export/preview` | `{checkedAt,rowCount,csvContent}` for the current eligible, non-excluded queue in product-ID order; exact finalized `sku,price` CSV. No token, capture, audit, confirmation or revision mutation. |
| `GET /price-export/snapshots/:id` | Safe shared metadata plus one `prices` artifact summary. No CSV body, idempotency key or captured per-product revisions. Missing snapshot is `404`. |
| `GET /price-export/snapshots/:id/csv` | Existing stored `sku,price` bytes. Read/download never confirms. |
| `GET /export/history` | `{items,next}` for the canonical product and price snapshot tables, using the shared metadata shape below. No audit-log reconstruction or synthetic sessions. |

History query parameters:

- `stream=all|product|price` (default `all`).
- `scope=accessible|mine` (default `accessible`). `mine` means the actual stored
  `created_by_user_id` equals the current application user. Historical nulls stay
  null and are never assigned to the caller, session owner or administrator.
- `status=all|generated|confirmed` (default `all`).
- `limit` integer, default **20**, maximum **50**; invalid filters/limits/cursors
  return `422`.
- `after` opaque `next` cursor. Ordering is immutable `generated_at DESC, id DESC`,
  with stream as the final tie-breaker for identical IDs across the two tables.
  Cursor time retains PostgreSQL microseconds and is bound to stream/scope/status.
  Each page uses one SQL statement and rechecks current effective access.

The shared metadata shape is `stream`, `id`, `status`, `generatedAt`, `confirmedAt`,
`createdByUserId`, `confirmedByUserId`, `rowCount` (existing product count),
`productCount`, `csvRowCount`, `fileName`, `capturedRange`, `recipe`, `artifacts`,
and, when actually available, `sessionId`, `templateLabel`, `requestContract`,
`template`, `inputFingerprint`. Product range is the stored
`{fromSku,toSku,resolvedToSku,exportedToProductId}`; price range is null.
Artifact summaries contain `groupCode`, `profileVersion`, `fileName`,
`productCount`, `rowCount`. Product CSV row count is unknown/null if no Magento
artifact exists. A historical snapshot with no provenance/artifacts is labelled
**Немає даних**, never regenerated. Current template display name is a label;
stored version ID/hash remain provenance. Direct session snapshot metadata also
returns the existing caller-specific `accessEpoch` required by confirmation.

Direct historical product snapshots and price snapshots retain existing
`exports.view` access. Session-linked product history uses the same owner or
**accepted** member predicate as direct stored-result access. A pending invitation
and an administrator role confer no private-session access. History checks current
active-user/effective permission in its statement; opening/downloading independently
rechecks authorization. No history or metadata read mutates domain state.

### Diagnostic review projection

`review = {version:"export-review-v1", identity:tableFingerprint, files:[...]}`.
Each file has `groupCode`, `groupName`, `fileName`, `profileVersion`, exact emitted
`headers`, and `rows`. A row contains represented `productId`/`sku`, one-based
canonical `productPosition`, canonical Main/EN `ordinal`, `language` (`main|en`),
`readiness` (`ready|attention`), `issues`, and header-aligned `cells`.

Cells are `{state,value}`:

- `final`: trustworthy future CSV text, finalized by the existing server serializer.
- `blank`: intentional valid empty CSV text (`value:""`).
- `provisional`: evaluated diagnostic text for a failed product, explicitly marked
  **≈**, including provisional empty values; not an exportable partial row.
- `not-evaluated`: no trustworthy output (`value:null`), shown as **Не обчислено**.

Issue targets are explicit `cell` (`column`, `language`), `column`, `columns`
(declared output-check ownership), `row`, or `source`. Only server evidence marks
cells; unknown fields stay row-level. Failed-only groups remain visible. The
observer collects values and coordinates during existing lazy evaluation; skipped
branches are never evaluated for diagnostics. Existing artifacts, readiness,
work metrics, hashes, token eligibility and capture evaluation stay authoritative.
The additional review projection is bounded by the existing 64 MiB output ceiling;
oversize review fails closed without partial output, automatic truncation, range
splitting or a higher evaluator limit. Finalization uses the same formula
neutralization as CSV serialization; React only reads finalized text.

The compact attention summary filters affected rows. Detail dialogs show exact
long text and secondary technical diagnostics. Authorized actions hand off to the
existing manual-name workflow or an explicit `/?exportSku=...` decode action;
there is no inline product editing, automatic correction or successor substitution.
UX-5 automatically decodes the exact handoff SKU read-only after configuration
and permissions resolve, unless current creation/recount/price work blocks it.
It never enters edit/recount mode. See the UX-5 continuation below for rechecks.

### Stored results and explicit price actions

Stored results freeze range/publication/preparation controls. Metadata loads first;
only the selected CSV is fetched and parsed, cached by immutable result/file within
the current authorized surface. Stored reads never use live preview. A table-load
failure says **Файли створено, але таблицю не вдалося завантажити.** and can retry
reading, not capture. Download feedback says **Передано браузеру для завантаження**;
it makes no claim about the user's disk or Magento import.

**Завершити експорт** opens a focused consequence dialog and invokes only the
existing confirmation command. There is no prior-download requirement. The UI
displays server confirmation time/actor when available. Existing idempotency,
original attribution, normal cursor and captured-revision rules are unchanged.

`/exports/prices` has no product range or template selector. Its flow is:

1. **Оновити / переглянути поточну чергу** — read-only current review.
2. **Створити файл** — existing create command with retained original retry key;
   creation does not download or confirm.
3. **ЗБЕРЕЖЕНІ ФАЙЛИ** — read exact stored `sku,price` values.
4. **Завантажити CSV** — existing stored download, without confirmation.
5. **Підтвердити експорт цін** — separate dialog and existing confirmation command.

The review explicitly says the server rechecks the current queue during creation;
it freezes nothing and adds no token protocol. If stored CSV differs from the last
review, the UI shows the change notice before enabling its confirmation action.
A failed stored-table read can be retried and compared without recreating a file.
Generated, unconfirmed files can be reopened from the shared history after reload.
Only explicit confirmation advances dedicated captured revision high-water marks;
later price changes stay pending and normal product cursors remain separate.

### Presentation performance and verification

Files parse lazily, with immutable-object memoization; focus/filter/page/width
changes do not reparse CSV. Local pages render 50 rows, long text is truncated
until detail opening, and roving keyboard focus avoids thousands of tab stops.
There is no sort, server preview paging, virtualization or global-state dependency.
The review CSV scanner uses string slices to avoid retaining a concatenation node
per character of long quoted cells; exact parsing and malformed-input regression
tests cover its compatibility. Template Builder's parser is unchanged.

UX-3 coverage: `server/test/export-review.test.js`,
`server/integration-test/12-export-ux3.cases.js`,
`client/test/export-ux3.test.jsx`, `client/test/export-review-performance.test.js`,
and the existing ordinary/template/session/workspace rendered suites. Integration
cases cover read effects, stored bytes, history pagination/unknown attribution,
membership and both confirmation streams; they require canonical `postgres-test`.
See the UX-3 execution record in [the UX plan](EXPORT_UX_REDESIGN_PLAN.md) for
actual run results and the outstanding infrastructure/manual acceptance limits.

### UX-4 continuity and shared recovery

The UX-3 PostgreSQL infrastructure blocker is resolved; current full-suite evidence
and remaining manual visual acceptance are in section25 of
[the UX plan](EXPORT_UX_REDESIGN_PLAN.md). Shared session lists/detail reuse this
history's snapshot metadata presenter and identity/status contract; they do not
add another history endpoint. [Shared sessions](SHARED_EXPORT_SESSIONS.md) documents
recent-first list pagination, participant disclosure and original-operation recovery.

UX-4 originally required an explicit recheck after an authorized correction.
UX-5 supersedes that interaction with a new authoritative read after confirmed
success, as described below; it still never patches diagnostic rows locally.
Successful recheck retains display-only file/category, SKU search, attention and
Main/EN filters, widths and a still-valid page in principal-scoped memory. New
evidence replaces all old row/detail objects; a resolved issue is not recreated.
Display context never changes export input/order/eligibility or retained retry
identity. The next current issue remains actionable after the successful recheck.

### UX-5 operator workflow (2026-09-26)

Normal column settings offer empty, constant, characteristic, text with
characteristics, conditions and first-present intents where the existing rule
can be safely represented. A transformation remains detached until **Застосувати
до чернетки**. Constant-to-condition retains the exact constant in **Інакше**;
Cancel retains the original definition. Known enclosing readiness/presence
guards and output checks survive the existing local dependency-isolation adapter.
Question contracts keep their dedicated mapping editor. Opaque/custom structures
are not flattened; Technical details and Advanced remain separate dialogs.
The shared searchable combobox filters labels but stores only an explicitly
selected source/semantic value. Labels do not become semantic IDs.

Fresh fixed-structure copies show **Що можна змінювати в копії?** at the table
boundary. **Також змінювати структуру CSV** explicitly invokes the existing
authorized upgrade; creation never upgrades silently. Publishing, selecting a
publication and creating export files remain independent explicit actions.

Category badges count unique attention products from the already loaded review,
with a separately labelled all-category count. Filters, widths and category
navigation do not re-evaluate products or alter membership. Empty category,
filtered-empty, empty shared/invitation lists and an underlying empty price queue
have distinct copy; zero-row results do not display empty tables/pagination.

An export-origin handoff carries SKU, human reason and a return destination in
principal-scoped memory. Read-only decode does not mark the review stale. Local
recount dirty state requires an open recount editor, not merely decoded data.
Confirmed successful name correction, or a successful product mutation during
that handoff, requests a NEW authoritative preview and displays **Оновлюємо
перевірку після зміни товару…**. Category, search, attention, Main/EN, widths and
valid page survive. Failed reads retain stale evidence and offer **Повторити
перевірку**. Other changes still invalidate evidence without an unsolicited
automatic operation. Principal/ticket guards reject late responses.

This new read never saves preparation, changes range/publication, creates or
confirms a snapshot, or replaces an uncertain original command/payload/retry key.
Stored results remain immutable. Refresh of an uncertain creation's review and
retry of the original creation retain separate evidence. Busy/frozen states
continue to block unsafe actions; a blocked recheck leaves stale/manual recovery.

History adds current human creator/confirmer labels and accessible session title
through authorized read-only joins. IDs remain the actor identity; labels are
display metadata, not historical identity changes. Null historical actors remain
unknown. No new ownership inference, history endpoint, pagination order or access
bypass is introduced. Direct stored/list presenters can lack display labels and
must not fabricate names. Dates use the shared local formatter; missing historical
CSV files are described without claiming that a CSV table was loaded.

Real-browser and full automated evidence: [post-UX-5 acceptance audit](EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md).
