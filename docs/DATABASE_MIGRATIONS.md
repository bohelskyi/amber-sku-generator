# Database and migrations

## Migration runner

`server/src/db/run-migrations.js` is the schema authority. It reads `.sql` files in lexical order before seed/schema-capture/listen, uses a dedicated PostgreSQL client, obtains the session advisory lock `amber_schema_migrations`, and disables query/statement timeouts for legitimate long DDL.

Each unapplied file runs in its own transaction. Success records its name, SHA-256 checksum, and timestamp in `schema_migrations`; failure rolls back that file and stops startup. Runtime initialization code is compatibility/seeding code, not permission to add DDL outside migrations.

Checksums canonicalize CRLF and lone CR to LF before hashing, so Windows and Linux checkouts agree. A legacy null checksum is backfilled on verification. Any non-null mismatch aborts startup. Never alter stored checksums to conceal changed SQL.

## Forward-only rule

Checked-in migrations now span `000`–`057`. Migrations `000`–`056` are immutable history. Never edit any already-applied migration; add a forward migration. Whether each has been applied in a particular deployment must be checked in that database's `schema_migrations` table:

- never edit, reorder, rename, or replace an applied migration;
- add the next lexically ordered forward migration;
- keep it transactional and idempotent where repeated startup reaches already-applied state;
- cover fresh databases and every known checkpoint/upgrade shape affected by the change;
- test failure rollback and repeated startup where applicable.

`legacyInitDb()` remains in `server/src/db/init-db.js` for compatibility/tests. Normal startup treats migrations as DDL truth, seeds only an empty catalog, ensures calibration questions, and captures missing legacy V1 schemas.

### 055 — reviewed publication obligations and name preservation

`055_magento_publication_handoff.sql` adds immutable publication/controlled-action
receipts, the exact affected-product obligations and immutable per-binding effective-name
pins. These are transaction-coupled review evidence and small restart-safe enrollment
state, not a report engine or a replacement Magento job lifecycle. Each obligation
settles once from pending to enrolled (capturing the ordinary sync generation),
protected or retired. UPDATE/DELETE/TRUNCATE cannot reset evidence. Name pins keep
existing effective names when a successor changes its generation rules; explicit
Amber edits still use the existing override and three-way baseline model.

Installation performs no backfill, publication, enrollment, baseline update or
remote call. New publication evidence is committed atomically with the existing
immutable binding publication; no existing published rows or jobs are reinterpreted.

## Fresh and upgrade compatibility

The integration suite compares fresh, pre-checksum legacy, and checkpoint upgrade topology. It also verifies timeout independence, checksum normalization, failed-file rollback, repeated startup, legacy-zero compatibility, legacy unowned correction claims, session schema, RBAC/permission upgrade mappings, and the immutable audit-event schema and migration rollback boundary.

This covers known repository upgrade paths, not an arbitrary manually altered database. `CREATE TABLE IF NOT EXISTS` in migration `000` does not retrofit every possible partial legacy table; later migrations define the supported upgrades.

Several checks and foreign keys introduced during production upgrade are `NOT VALID`. PostgreSQL enforces them for new/changed rows without certifying every older row. Do not assume they prove all historical data clean.

## Concurrency and lock ordering

Important database protections are layered:

- migrations use a global session advisory lock;
- default seed/calibration and legacy schema capture use shared session locks plus transaction/recheck logic;
- schema publication uses a per-category advisory lock and row lock;
- duplicate question writes use a transaction advisory lock plus trigger;
- SKU sequence, variation, and reservation use locks plus permanent uniqueness;
- stable public allocation uses a separate non-cycling BIGINT sequence; immutable identity rows and a deferred constraint trigger enforce permanent non-reuse and one current revision per identity without changing recount lock order;
- save rebuilds authoritative preview inside its transaction;
- recount/correction locks and signs source state;
- active correction requests and active repricing drafts use partial unique indexes;
- correction claims use conditional atomic updates and token-hash comparison;
- repricing locks products in stable ID order and applies/rolls back atomically;
- export idempotency, immutable CSV/re-export revision evidence, product-locked snapshot capture, row-locked confirmation, coalescing product revision high-water marks, and the monotonic cursor work together.
- durable user-administration audit inserts use the mutation's existing transaction, so an audit failure rolls back the domain mutation and no success event is emitted for a failure or no-op.
- user and role administration share one advisory lock, revalidate the actor after acquiring it, use role/assignment optimistic concurrency, and preserve one current assignment plus the final active Administrator.
- product create, archive, and recount actor writes and audit inserts share their existing business transaction; recount retains its established source/SKU lock order and final-state validation.
- repricing apply/rollback actor writes and durable audit inserts share the existing financial transaction; draft creation/discard audit shares the corresponding draft transaction, while routine draft writes use last-modifier attribution only.
- export snapshot create/first-confirm actor writes and audit inserts share their existing mutation transactions; idempotent reuse or repeat confirmation preserves the original actors and emits no duplicate event while confirmation still repairs the monotonic cursor.
- SKU schema publication actor and audit writes share the existing per-category advisory-lock transaction and therefore roll back together with active-version rotation and immutable snapshot creation.

New paths touching these resources must follow existing lock order and final-state revalidation. An isolated lock is not a substitute. Surface transaction/deadlock failure rather than continuing partially.

## Migration inventory

| Migration | Purpose |
| --- | --- |
| `000_initial_schema.sql` | Idempotent baseline schema for a fresh database. |
| `001_sku_registry_and_indexes.sql` | Permanent SKU registry and supporting indexes. |
| `002_pricing_scenario_controls.sql` | Pricing scenario controls and weight-band support. |
| `003_repricing_batches.sql` | Repricing batches and item history. |
| `004_option_hidden_rules.sql` | Option hidden-rule support. |
| `005_option_archiving.sql` | Option archive state. |
| `006_sku_schema_versions.sql` | Immutable SKU schema versions and product links. |
| `007_compact_sku_version_markers.sql` | Compact V2+ SKU markers. |
| `008_repricing_rollback.sql` | Repricing rollback state/payload support. |
| `009_repricing_drafts.sql` | Persisted repricing drafts. |
| `010_repricing_reviewed_products.sql` | Reviewed-product draft state. |
| `011_correction_requests.sql` | Correction-request workflow and status cleanup. |
| `012_exchange_rate_cache.sql` | Positive dated USD/UAH last-known-good cache. |
| `013_export_snapshots.sql` | Immutable export snapshots and monotonic singleton cursor state. |
| `014_numeric_and_business_invariants.sql` | `NUMERIC` conversions plus business checks/FKs and duplicate-question protection; potentially long/locking DDL. |
| `015_concurrency_and_upgrade_invariants.sql` | Known fresh/legacy topology alignment and race-safe duplicate-question enforcement. |
| `016_legacy_zero_price_compatibility.sql` | Removes zero matrix cells and grandfathers legacy zero-priced products. |
| `017_global_repricing.sql` | Scenario/global repricing scopes and one active global draft. |
| `018_correction_request_claims.sql` | Hashed capability claims and legacy unowned in-progress compatibility. |
| `019_postgres_session_store.sql` | PostgreSQL Express session table matching pinned `connect-pg-simple`; runtime auto-DDL disabled. |
| `020_application_users_rbac.sql` | Local users, immutable external identities, permissions/roles, assignment history, built-in mappings, first-admin marker. |
| `021_business_permission_enforcement.sql` | Adds direct-recount/export-view permissions; grants Administrator/Storekeeper direct recount, Storekeeper archive, and all built-ins export view. |
| `022_manager_correction_request_permissions.sql` | Removes Manager `corrections.claim` and `corrections.complete`, preserving view/create/reject and Administrator/Storekeeper processing. |
| `023_audit_events.sql` | Immutable durable audit-event ledger with local-user actor snapshots and lookup indexes; adds Administrator-only `audit.view`. |
| `024_product_actor_attribution.sql` | Nullable local-user attribution for product creation/archive and detailed product-correction history without historical backfill. |
| `025_correction_request_user_ownership.sql` | Nullable correction creator/current-owner attribution, monotonic claim epochs, and legacy token-only/unowned in-progress compatibility without ownership backfill. |
| `026_repricing_actor_attribution.sql` | Nullable local-user attribution for repricing draft create/modify/discard and batch apply/rollback without historical backfill or synthesized audit events. |
| `027_export_and_sku_schema_actor_attribution.sql` | Nullable local-user attribution for export snapshot create/confirm and SKU schema publication, plus export provenance immutability, without historical backfill or synthesized audit events. |
| `028_custom_roles.sql` | Versioned editable roles, one-current-role enforcement, case-insensitive role names, immutable role identity, permanent role records, and database-enforced Administrator/reserved-permission protections. |
| `029_category_marketing_rounding.sql` | Adds a constrained, default-enabled category flag for automatic-price marketing rounding. |
| `030_correction_request_pricing_decisions.sql` | Adds persisted correction pricing decisions plus the Manager pricing-override permission and role-version advance. |
| `031_product_price_reexports.sql` | Adds coalescing per-product price-change export revisions and immutable snapshot revision evidence. |
| `032_price_change_requests_and_price_exports.sql` | Adds direct-price RBAC, typed price requests, exposure-aware reuse of `product_export_revisions`, and immutable dedicated price snapshots. Generated legacy snapshots establish exposure but only confirmed evidence advances revisions. |
| `033_magento_snapshot_artifacts.sql` | Adds immutable per-group Magento Products v1 CSV artifacts owned by normal export snapshots. No new cursor, product revision stream, catalog question, or historical backfill. |
| `034_product_magento_manual_names.sql` | Adds a nullable paired UA/EN manual subject to products, with a nonblank and length check. Existing products retain null subjects; no historical snapshot or product backfill. |
| `035_export_templates.sql` | Adds permanent template families, one revisioned JSONB draft per family, immutable published versions, legacy-initialized singleton selection metadata, and four delegable template capabilities. No snapshot columns, baseline template, product/catalog capture, synthetic actor or audit backfill. |
| `036_export_snapshot_template_binding.sql` | Adds immutable opt-in snapshot request intent, published-version provenance, input fingerprint and effective capture evidence. Composite publication identity FK plus complete/null shape checks; old snapshots stay legacy and unattributed. Extends the existing payload trigger without changing artifact bytes or confirmation attribution rules. |
| `037_shared_export_sessions.sql` | Durable private/shared controlled sessions, membership epochs, immutable attempt identity/proof, one successful snapshot per session, and deferred atomic reverse-result association. No historical ownership backfill; 000–036 remain immutable. |
| `038_editable_export_columns.sql` | Adds the distinct editable-column artifact contract and nullable immutable legacy preview fingerprint. Extends complete template binding checks without relabeling old artifacts or publications. No backfill; 000–037 unchanged. |
| `039_full_product_export_lifecycle.sql` | Separate monotonic full-product state, immutable exact snapshot membership, server-owned name-review flag, immutable nullable snapshot lifecycle version and delegable `exports.reconcile` permission. Conservative historical baseline only; no exposure repair or selection switch. |
| `040_full_product_export_cutover.sql` | Distinct legacy baseline and audit FK, typed business/compatibility exclusions, monotonic preparing/active selector gate with immutable audit references, baseline-aware pending index, deferred policy projection checks and writer guards; immutable snapshot selection and explicit replacement binding. No baseline acceptance, exclusion release or activation in migration. |
| `041_magento_binding_revisions.sql` | Schema-only Magento binding revisions, normalized schema observations, route/attribute/semantic-or-evaluated option decisions and separate scoped ownership policies. Composite template/option identity FKs, uniqueness, source-kind constraints and publication immutability guards. No live IDs, credentials, candidates, policy seeds or Magento calls. See [the binding contract](MAGENTO_INTEGRATION.md#phase-1b2a-persistent-binding-foundation). |
| `042_magento_sync_jobs.sql` | Durable immutable Magento sync intent, per-operation dispatch/verification ledger, idempotency and unfinished-SKU uniqueness. No seeded jobs, binding publication, remote calls or export-state changes. |
| `043_magento_literal_question_keys.sql` | Allows literal Amber question keys beginning with a digit in semantic option identities and canonical route predicates, including `SV.2`. Magento code constraints, source proof, composite identity, CAS and publication guards remain unchanged. No row rewrite or alias backfill. |
| `044_magento_automatic_sync.sql` | Default-disabled automatic gate, transaction-coupled per-product desired/synced generations, active job association, bounded retry state, automatic job generation and guarded undispatched supersession. No enrollment, activation or historical changes. See [automatic sync](MAGENTO_AUTOMATIC_SYNC.md). |
| `045_magento_delivery_cutover.sql` | One-way retirement state for new Magento-product CSV artifacts, immutable cutover receipt, a database guard for old writers and a separate monotonic per-product CSV-retirement floor for post-cutover mutations. Defaults keep CSV enabled and automatic sync disabled; no activation, enrollment, historical-row change, export deletion or Magento write occurs in the migration. |
| `046_stable_public_product_sku.sql` | Immutable public-product identities and non-cycling `AG-` allocation, exact legacy backfill, post-activation recount inheritance and deferred one-current-revision enforcement; additive dual-SKU snapshot/job evidence, public-identity automatic requests and a separate default-off audited activation gate. Existing internal SKUs, snapshots and artifacts are not rewritten. |
| `047_finalize_legacy_sku_repair.sql` | Fail-closed finalization of only immutable schema-045 `legacy_sku_repair.staged` evidence. It requires 046 to be recorded, independently verifies the versioned PostgreSQL-canonical receipt and all nested plan/product/lifecycle hashes, allocates a new `AG-` public identity for each explicitly staged real collision, restores that same product row to its prior business lifecycle state, and leaves reviewed duplicate rows retired. It does not change internal SKU reservations, activate public SKU delivery, enqueue Magento work or leave a runtime identity-mutation bypass. |
| `048_external_magento_delivery_acknowledgement.sql` | Adds a distinct monotonic exact-revision external-delivery floor and immutable audit reference for reviewed deliveries that occurred outside Amber before API cutover. The migration acknowledges no rows. A database guard restricts advances to the active lifecycle, pre-delivery-cutover command boundary and enforces the normal/replacement route transition. |
| `049_shared_names_and_repricing_sync.sql` | Shared-authority full-name observations/baselines and repricing item sync generation evidence. |
| `050_test_product_deletion.sql` | Dedicated immutable test-deletion intent/progress, `voided` tombstones and request terminalization, Administrator-only capability and business-write fences. |
| `051_magento_extensible_categories.sql` | Bounded category syntax in binding routes/options; new categories require an exact declared group in the pinned immutable v4 template. No seeds, data rewrite or publication. |
| `052_magento_configuration_actions.sql` | Permanent reviewed category-create intent, dispatch, exact returned ID and GET-verification evidence; no implicit binding approval. |
| `053_magento_option_attestations.sql` | Immutable action-specific Administrator option-capability attestations. |
| `054_explicit_category_sku_publication.sql` | Explicit initial SKU publication for administrator-created categories. |
| `055_magento_publication_handoff.sql` | Immutable publication/handoff receipts, bounded enrollment items and name-rule pins. |
| `056_magento_configuration_reseal.sql` | Linked replacement of sealed, undispatched configuration actions; all dispatched reservations remain permanent. |
| `057_catalog_english_option_labels.sql` | Nullable authoritative English catalog metadata and immutable reviewed scoped-option label action evidence. |

## Test deletion migration

Migration `050_test_product_deletion.sql` adds `products.status='voided'`, the permanent
`magento_test_deletions` ledger, Administrator-reserved `products.delete_test`, and a
distinct terminal automatic-request state `voided`. It preserves all existing jobs,
steps, SKU reservations, public identities, sequence values and audit history.
Installation performs no Magento operation, allocation or product retirement.
Sealed intent is immutable; dispatch/absence/finalization timestamps only advance.
Product and lifecycle fences prevent business mutations during pending deletion or
after finalization. Reference guards prevent new correction/export/price/repricing
evidence for a sealed product. See [test deletion](MAGENTO_AUTOMATIC_SYNC.md#test-product-deletion).

## Schema-045 legacy full-SKU collision repair

Migration 046 intentionally aborts when retained legacy data has more than one current active/uncorrected product for one internal `full_sku`. Do not edit 046 or merge/recreate rows to bypass that invariant. With all business writers frozen, use the explicit operator workflow while the database is still exactly at schema 045:

```powershell
cd server
$env:DATABASE_URL = '<secret target URL>'
npm run legacy-sku-repair -- preflight --expected-database <DB> --actor-user-id <USER_ID> --decisions <DECISIONS_JSON> --output <NEW_PLAN_JSON>
npm run legacy-sku-repair -- stage --expected-database <DB> --actor-user-id <USER_ID> --plan <PLAN_JSON> --expected-hash <SHA256>
```

The decision file is data-only and must not be committed for a production or rehearsal database. Its exact version-1 shape is:

```json
{
  "version": 1,
  "groups": [
    {
      "sku": "EXACT-CANONICAL-SKU",
      "action": "deduplicate",
      "keeperProductId": 123,
      "retireProductIds": [124, 125],
      "reason": "Reviewed operator decision"
    },
    {
      "sku": "ANOTHER-CANONICAL-SKU",
      "action": "split_public_identity",
      "keeperProductId": 200,
      "splitProductIds": [201],
      "reason": "Reviewed materially separate product"
    }
  ]
}
```

The version-1 decision artifact must classify every affected group explicitly as `deduplicate` or `split_public_identity`; hashes are evidence only and never auto-classify a row. Deduplication comparison covers the complete `products` business row and ignores only row identity `id` and insertion timestamp `created_at`. Preflight is read-only and binds the exact current products, lifecycle rows, registry ownership, lineage, immutable exposure evidence and relevant Magento evidence into a normalized SHA-256 plan. Stage revalidates that exact state under database locks and atomically uses the normal retirement primitive. Reviewed duplicates remain retired. A split target is temporarily retired without changing its product ID, internal `full_sku`, reservation or correction lineage; immutable audit evidence records its exact original and staged state.

Normal migration startup then applies 046 followed by 047; 047 raises and cannot be recorded if 046 is absent. Staging stores a version-2 canonical receipt whose bytes are PostgreSQL 16 `jsonb::text` encoded as UTF-8 and SHA-256 hashed. The receipt contains the complete preflight plan, actor/database binding, registry evidence, decisions and exact original/staged product and lifecycle rows. Migration 047 reparses and reserializes those bytes, recomputes the receipt, plan, group, product and lifecycle hashes, and compares the live locked state before accepting the handoff. It also requires activation/delivery/cutover gates to remain safe, allocates the split row's new public identity from `public_product_sku_sequence`, and restores the same product row. Its lifecycle `delivery_version` advances for both the staging retirement and restoration while the original business lifecycle fields are restored. The final strict public-identity immutability trigger is restored before commit. Keep the decision, plan, plan hash and stage receipt with the change record. Split rows require a separately reviewed post-cutover Magento CREATE/requeue; neither the operator command nor 047 performs or enqueues it.

The 2026-09-28 read-only check of the local operator database confirmed 041 applied at
`2026-09-27T20:13:49.840Z` and 042 at `2026-09-27T22:52:43.558Z`. The normal migration
path installed 042 before publication/enqueue; no runtime DDL was used. Stored
checksums match the checked-in SQL. Publication and the first succeeded job are
separate runtime evidence, recorded in [Magento integration](MAGENTO_INTEGRATION.md#achieved-state-2026-09-28).
This is not a claim about migrations or CSV activation in another deployment.

Export-template mutations take the existing access-admin advisory lock and recheck the actor's specific capability before locking family then draft. Publication allocates a per-family version number under those locks and inserts attribution and audit atomically. The unique family/source-revision tuple supports completed retries even after the draft advances. Draft base-version ownership uses a composite foreign key; historical source revision is not a foreign key to the mutable draft revision. Selection writers lock the singleton after the access boundary and only read immutable versions; they never lock products, revisions or cursors.

Publication UPDATE/DELETE/TRUNCATE is rejected by database triggers, including definition, constants, metadata and actor/time. Family identities and draft/selection rows are permanent, with monotonic revision/generation guards. Normal application writes cannot remove this evidence. Privileged integration teardown drops/recreates the disposable schema; it never disables these guards. Definition JSONB has a 512 KiB storage-text backstop (JSONB adds whitespace); the service enforces the stricter 256 KiB serialized-JSON limit and structural safety before writes.

## Snapshot and session schema boundaries

Controlled shared sessions add a pre-transaction session advisory lock after the
shared access boundary. All membership/configuration/generation/confirmation commands
use this order; the existing product → revision → cursor and snapshot-confirmation
order remain intact. See [session locking and recovery](SHARED_EXPORT_SESSIONS.md).

Migration 036 snapshot additions are
`request_contract` (mechanical `legacy` default), `template_id`,
`template_version_id`, `template_definition_hash`, `template_evaluator_version`,
`template_output_contract`, `template_format_version`, `request_intent`,
`input_fingerprint`, and `binding_evidence`. Legacy rows require all nine nullable
provenance/evidence columns to be null. Template rows require all nine populated,
positive represented count and matching intent/effective/range/cursor/selection
evidence. A composite FK binds version, family, hash, evaluator, output and format
to one immutable publication. The existing payload trigger rejects changing or
attaching any of this evidence after INSERT. Normal confirmation remains valid.
The artifact `profile_version` is still the output contract, not template identity.

All modern full-product captures use RR with the existing access/session boundary, per-key
transaction coordination, template selection when applicable, ascending products,
ascending full-product state, ascending price revisions, then new-mode cursor.
Recovery uses a fresh committed lookup only after rollback;
an advisory wait never refreshes RR. See [the complete export contract](EXPORTS.md#preview-idempotency-and-concurrency).

## Test database safety

PostgreSQL integration tests destroy/recreate their target `public` schema and create/drop temporary databases. The harness deliberately refuses a primary database name not ending in `_test`. Never run it against production, staging, or a developer database containing useful data.

## Full-product lifecycle — migration 039

`product_full_export_state` has one permanent, delete-restricted product row. Positive BIGINT `revision`/`delivery_version` and bounded `confirmed_revision` never regress. Identity, creation time and originating correction are immutable. Route/hold consistency is checked, and changing routing/evidence/resolution fields requires increasing delivery version. Correction and resolution keys have partial unique indexes; pending normal/replacement and hold lookups have partial indexes. Evidence must be a JSON object, optional repair hash must be lowercase SHA-256, and resolver actor/time must both be present or both absent. Runtime cutover/reconciliation commands use these resolution fields with immutable audit evidence.

The migration initializes every existing row with revision 1/confirmed 0. Corrected, archived or linked-to-successor rows are `retired`; other rows are `hold/historical_ambiguity` with unresolved migration-origin evidence. It does not infer export eligibility from cursor, price revisions or absent snapshots, clear exclusions, index historical membership, fabricate actors/audits or perform historical repair. A deferred constraint trigger rejects a newly inserted product without lifecycle state at commit. Product/SKU/audit writes and lifecycle initialization therefore share one runtime transaction.

`export_snapshot_products` has a `(snapshot_id, product_id)` primary key and `(product_id, snapshot_id)` index, with delete-restricted FKs. Full captures require positive full/delivery counters and live origin; compatibility evidence requires null counters. Exact SKU, capture/origin codes, SHA-256 evidence hash and actual recording time are permanent. Triggers reject UPDATE, DELETE and TRUNCATE. Deferred checks require lifecycle snapshot membership count to match represented product count and qualifying artifact product totals. The service additionally validates exact CSV membership/SKUs before INSERT. Historical NULL-version snapshots can later receive only verified compatibility sidecars; the explicit historical indexing command supplies those verified sidecars without changing old artifacts.

The other additions are server-owned `products.magento_name_review_required` (false by default), nullable immutable snapshot lifecycle version (current value 1), and `exports.reconcile`. The existing permission trigger grants only Administrator initially; the ordinary editable-role mechanism can delegate it.

Recount locks source product → existing SKU/sequence/reservation resources → request finalization when applicable → ascending full state → audit/commit. It reads historical snapshot evidence without locking snapshot rows. Confirmation locks snapshot → ascending full state → ascending price revisions → cursor and never then locks a product. Future full-revision writers must lock product before full state. Independent-connection races verify both winner orders for capture/recount, confirmation/recount, duplicate recount and confirmation/later revision.

Fresh schema, checkpoint 038, repeated checksum verification and injected 039 failure rollback are covered by `02-full-product-lifecycle-migration.cases.js`; historical checksums, exclusions and immutable snapshot bytes remain unchanged. Runtime save, rollback and membership immutability are also covered in `11-full-product-lifecycle.cases.js`. These checks use only disposable databases on the canonical PostgreSQL 16 test service, including the temporary upgrade database ending in `_test`.

## Cutover and activation — migration 040

Migration 040 adds the distinct one-time `cutover_baseline_revision`/audit reference, typed `business_exclusion_state`, separate `recount_compatibility_excluded`, immutable snapshot selection and replacement binding. The pending index compares revision with `greatest(confirmed_revision, cutover_baseline_revision)`. Baseline acceptance never fabricates captured confirmation.

`full_product_export_activation` starts in `legacy`, selector version 0, required writer contract 1. Monotonic generation, phase/event constraints and immutable audit receipts govern `legacy → preparing → active`; active cannot return to legacy. Deferred checks enforce baseline-event identity, exclusion projection and inactive-product retirement. Statement guards fence unaware writers after preparation; application transactions acquire the gate before BEGIN to avoid stale repeatable-read snapshots after waiting.

The migration itself performs no baseline acceptance, successor release, historical indexing or activation. Deploy both the gate-aware application and the schema, then follow the [canonical cutover runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md). Old/new mixed writers are unsupported; ordinary future deployments and one-time production cutover are distinct operations. Current production completed activation/cutover through migration 050 (2026-10-01 operator receipt, PR #19). This procedure remains required for other installations; migration 051 does not activate or publish anything.

## Migration 049: shared names and batch sync evidence

`049_shared_names_and_repricing_sync.sql` adds exact generated/full-name overrides, origin/public-identity name baselines and reviewed conflict state, a bounded durable discovery cursor, safe automatic-request diagnostics, and each repricing item's nullable captured sync generation. It extends the existing product-input projection without modifying prior migrations, SKU allocation, published bindings or historical jobs/snapshots. Existing records receive no guessed baseline or batch synchronization proof. Fresh installation and repeated startup use the migration runner transaction/checksum contract.

## Migration 051: extensible integration categories

`051_magento_extensible_categories.sql` changes only the category-code checks on `magento_binding_routes` and `magento_binding_options`, from the historical six-code list to bounded uppercase codes (`^[A-Z][A-Z0-9_]{0,31}$`). Additional BEFORE INSERT/UPDATE guards require any category outside the historical six to be declared in the immutable evaluator-4 template pinned by the owning binding revision. Existing six-category rules, composite identity/observation FKs, publication immutability and audit/permission boundaries remain intact.

There is no table/backfill, catalog seed, activation, automatic upgrade, publication or remote call. The schema runner transaction rolls back both constraints and guards on failure; repeated startup verifies the same checksum. Disposable regression coverage upgrades checkpoint 050 with real published evaluator-1/2/3 templates and bindings, compares their stored records and gate/audit evidence before/after, checks rollback and rerun, and persists a v4 future-category binding with distinct semantic/SKU/remote identities. Fresh installation is covered by the complete migration suite. This is H0 only; the [v4 contract](EXPORT_TEMPLATES.md#extensible-v4-integration-contract) does not implement later readiness/editor/publication orchestration.

## Migration 052: reviewed remote configuration action evidence

`052_magento_configuration_actions.sql` adds the bounded permanent ledger for H2
single-category creation. Immutable intent/context, one origin/resource reservation,
monotonic sealed/dispatched/returned/verified states and durable exact remote ID
separate uncertain remote writes from GET-verified receipts. Updates cannot rewrite
intent, reset dispatch, replace a returned ID or change verified evidence; DELETE
and TRUNCATE are denied. No category, binding approval, publication, product, job,
activation or remote mutation is created by installation. Existing migration files,
published bindings and product-sync intent interpretations remain unchanged.

## 053 — reviewed option capability attestations

`053_magento_option_attestations.sql` adds immutable Administrator evidence with exact observable attribute identity, action target, expiry and a unique action-use reference. Configuration actions admit the option kind only with this reference. Existing category receipts, published bindings and migration checksums remain unchanged.

### 054 — explicit first category SKU publication

`054_explicit_category_sku_publication.sql` adds a category publication mode.
Existing rows and compatibility seeds retain `legacy_bootstrap`; future categories
created by the authoritative Amber command use `explicit`. Restart therefore does
not silently publish an unfinished new category. Existing schema publication,
identity/reservation algorithms, historical publications and normal save boundaries
are unchanged. No remote access, enrollment or activation occurs in the migration.

## 056 — reviewed recovery before dispatch

`056_magento_configuration_reseal.sql` adds an immutable unique predecessor link and
the terminal `superseded` state to configuration actions. A partial unique index
reserves each origin/kind/resource across every non-superseded state. A deferred
guard requires a superseded row's permanent successor in the same transaction;
insert guards require that predecessor to be undispatched and the exact same
resource. Existing intent/progress fields remain immutable and the predecessor
cannot dispatch afterward. Dispatched/returned/verified rows cannot supersede or
reset. Existing actions receive only a null link; no action, attestation, binding,
publication, sync job, activation or remote mutation is created by installation.

## 057 — authoritative catalog English labels and reviewed label actions

`057_catalog_english_option_labels.sql` adds nullable `options.label_en` with a
nonblank/length/control-character constraint. Existing rows remain null; no backfill,
translation, snapshot rewrite, product/SKU mutation, activation or remote operation
occurs. Published schemas retain their historical label representation.

The existing configuration ledger admits `option_label` only with an immutable
single-action Administrator attestation. Its exact origin/attribute/option resource
remains exclusively reserved while sealed/dispatched/returned; verified label updates
permit a later separately reviewed action, while every earlier intent/progress row
remains permanent. CREATE/category reservations and 056 supersession guards are
unchanged. A lost PUT cannot reset/supersede dispatched work; recovery is GET-only.
Actual dispatch requires the separately deployed scoped-label adapter contract.
