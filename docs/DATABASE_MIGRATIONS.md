# Database and migrations

## Migration runner

`server/src/db/run-migrations.js` is the schema authority. It reads `.sql` files in lexical order before seed/schema-capture/listen, uses a dedicated PostgreSQL client, obtains the session advisory lock `amber_schema_migrations`, and disables query/statement timeouts for legitimate long DDL.

Each unapplied file runs in its own transaction. Success records its name, SHA-256 checksum, and timestamp in `schema_migrations`; failure rolls back that file and stops startup. Runtime initialization code is compatibility/seeding code, not permission to add DDL outside migrations.

Checksums canonicalize CRLF and lone CR to LF before hashing, so Windows and Linux checkouts agree. A legacy null checksum is backfilled on verification. Any non-null mismatch aborts startup. Never alter stored checksums to conceal changed SQL.

## Forward-only rule

Migrations `000`–`023` are applied/frozen history:

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
- export idempotency, immutability, row-locked confirmation, and monotonic cursor protections work together.
- durable user-administration audit inserts use the mutation's existing transaction, so an audit failure rolls back the domain mutation and no success event is emitted for a failure or no-op.

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

## Test database safety

PostgreSQL integration tests destroy/recreate their target `public` schema and create/drop temporary databases. The harness deliberately refuses a primary database name not ending in `_test`. Never run it against production, staging, or a developer database containing useful data.
