# Database and migrations

## Migration runner

`server/src/db/run-migrations.js` is the schema authority. It reads `.sql` files in lexical order before seed/schema-capture/listen, uses a dedicated PostgreSQL client, obtains the session advisory lock `amber_schema_migrations`, and disables query/statement timeouts for legitimate long DDL.

Each unapplied file runs in its own transaction. Success records its name, SHA-256 checksum, and timestamp in `schema_migrations`; failure rolls back that file and stops startup. Runtime initialization code is compatibility/seeding code, not permission to add DDL outside migrations.

Checksums canonicalize CRLF and lone CR to LF before hashing, so Windows and Linux checkouts agree. A legacy null checksum is backfilled on verification. Any non-null mismatch aborts startup. Never alter stored checksums to conceal changed SQL.

## Forward-only rule

Checked-in migrations `000`–`032` are immutable history; whether each has been applied in a particular deployment must be checked in that database's `schema_migrations` table:

- never edit, reorder, rename, or replace an applied migration;
- add the next lexically ordered forward migration;
- keep it transactional and idempotent where repeated startup reaches already-applied state;
- cover fresh databases and every known checkpoint/upgrade shape affected by the change;
- test failure rollback and repeated startup where applicable.

`legacyInitDb()` remains in `server/src/db/init-db.js` for compatibility/tests. Normal startup treats migrations as DDL truth, seeds only an empty catalog, ensures calibration questions, and captures missing legacy V1 schemas.

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

Export-template mutations take the existing access-admin advisory lock and recheck the actor's specific capability before locking family then draft. Publication allocates a per-family version number under those locks and inserts attribution and audit atomically. The unique family/source-revision tuple supports completed retries even after the draft advances. Draft base-version ownership uses a composite foreign key; historical source revision is not a foreign key to the mutable draft revision. Selection writers lock the singleton after the access boundary and only read immutable versions; they never lock products, revisions or cursors.

Publication UPDATE/DELETE/TRUNCATE is rejected by database triggers, including definition, constants, metadata and actor/time. Family identities and draft/selection rows are permanent, with monotonic revision/generation guards. Normal application writes cannot remove this evidence. Privileged integration teardown drops/recreates the disposable schema; it never disables these guards. Definition JSONB has a 512 KiB storage-text backstop (JSONB adds whitespace); the service enforces the stricter PR1B 256 KiB serialized-JSON limit and structural safety before writes.

## Test database safety

PR3 treats every migration through 035 as immutable. Snapshot additions are
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

Template captures use RR with a shared pre-transaction access lock, per-key
transaction coordination, selection, ascending products, ascending revisions,
then new-mode cursor. Recovery uses a fresh committed lookup only after rollback;
an advisory wait never refreshes RR. See [the complete export contract](EXPORTS.md#published-export-snapshots-pr3).

PostgreSQL integration tests destroy/recreate their target `public` schema and create/drop temporary databases. The harness deliberately refuses a primary database name not ending in `_test`. Never run it against production, staging, or a developer database containing useful data.
