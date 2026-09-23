# Exports

## Supported workflow

The legacy direct CSV endpoint remains disabled with `410`. The operator's full-product workflow is:

1. preview the new products after the confirmed product-ID cursor without entering a SKU;
2. create one immutable normal snapshot only when every represented product is Magento-ready;
3. download every represented Magento group CSV;
4. explicitly accept the snapshot as consumed.

Accepting a snapshot advances the product cursor; it does not assert that Magento imported the files. Downloading one file never confirms the snapshot. The existing internal CSV remains stored and downloadable for compatibility, but has no operator export button. The dedicated `sku,price` workflow is separate and unchanged.

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

Migration `035_export_templates.sql` adds `export_templates`, `export_template_drafts`, `export_template_versions`, and `export_template_activation`. The normal exporter and the dedicated price exporter do not read these tables. Selection responses explicitly report `metadataOnly: true` and `effectiveExporter: "legacy"`; publishing or selecting a version does not switch dispatch, expose products, advance cursors/revisions or alter snapshots. Initialization creates only a legacy selection at generation `1` with a null version/actor, plus permissions. No baseline definition is captured or published at startup.

All endpoints below are relative to `/api/admin/export-templates` and retain authenticated active-user and unsafe-method CSRF enforcement. Revision/generation/version-number fields are decimal strings, preserving PostgreSQL bigint precision. Expected counters also accept safe positive JSON integers. Errors use JSON `error`, `code`, and optional `details`.

| Method/path | Body/result | Required capability |
| --- | --- | --- |
| `GET /` | Family list with draft revisions and publication counts | `export_templates.view` |
| `GET /:id` | Family, current draft, and complete immutable versions | `export_templates.view` |
| `GET /sources` | Approved product fields, operations, limits, units and safe current/historical reference hints; no product rows | `export_templates.view` |
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

PR1B schema-scoped aliases carry a free-text `evidence` claim. The repository has no durable cross-key lineage that can verify equivalence. PR2 checks declared schema/category/key ownership, then rejects otherwise resolved aliases with `SOURCE_REFERENCE_UNSUPPORTED`; unresolved ownership uses `SOURCE_REFERENCE_UNRESOLVED`. Non-SKU alias lineage likewise cannot be inferred. The pure PR1B alias interface/parity tests remain unchanged. Successful reference validation explicitly does not certify production acceptance.

Draft test-preview requires both the requested revision and hash. It loads only stored product identity, schema link, answers, manual subjects, weight and final UAH price; caller-authored products/prices and unknown command fields are rejected. Missing requested IDs return `422 TEMPLATE_PRODUCTS_MISSING` with `details.missingProductIds`. The preview may inspect excluded products explicitly requested by ID; it does not perform normal export selection. It returns draft-only evaluator results, no signed token, snapshot, audit mutation, repair, price recalculation, exposure or cursor update.

Events `export_template.created`, `.draft_updated`, `.published`, and `.activated` commit with their mutations. Details contain IDs, hashes and revision/generation changes, not definitions or products. Audit failure rolls back all changes; failures, no-ops and completed retries emit no success event. The audit reader exposes only the public `definitionHash` exception to its general hash redaction; `audit.view` remains Administrator-only.

PR3 still owns snapshot version binding and staleness/retry integration; PR4 owns the editor and controlled operational activation. Release prerequisites remain the previously investigated recount fix, target catalog/alias lineage review, frozen-rule approval, KL `addit=0` compatibility decision, narrow SV naming, malformed-input difference acceptance, measurement units, and fresh controlled Magento Check Data. PR2 is not Magento acceptance or rollout readiness.
