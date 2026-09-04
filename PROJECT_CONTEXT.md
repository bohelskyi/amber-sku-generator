# Amber SKU Manager: project context

## Purpose and scope

Amber SKU Manager is an internal web application for defining amber-product classifications, generating authoritative SKUs and prices, saving inventory records, decoding historical SKUs, correcting/recounting products, applying controlled mass repricing, and exporting product data as CSV.

The UI has two practical audiences:

- operational staff use the main workspace to configure a product, preview and save it, decode an existing SKU, recount/correct a product, inspect history, and export data;
- configuration administrators use the admin screens to maintain categories, questions, options, SKU schemas, pricing scenarios, correction requests, and repricing drafts/batches.

These are UI responsibilities, not security roles. The application currently has no authentication, authorization, or RBAC, so the server does not enforce an operator/admin distinction.

This document describes the current `feature/postgresql` checkout inspected on 2026-09-05. Runtime PostgreSQL configuration is authoritative; a deployed database was not inspected while this document was written.

## Architecture

The application is a small three-tier system:

1. A React 19/Vite single-page client calls JSON and CSV endpoints under `/api`.
2. A Node 20/CommonJS Express 5 server owns all SKU, validation, pricing, correction, repricing, and export decisions.
3. PostgreSQL 16 stores configuration, immutable SKU schema snapshots, products, operational workflows, exchange-rate cache data, and export snapshots.

In Docker, nginx serves the built client, falls back to `index.html` for client routes, and proxies `/api/` to the server. The server does not listen until migrations, default-data seeding, and legacy SKU-schema capture have completed. PostgreSQL data lives in a named Docker volume.

The client must not be treated as a trust boundary. Preview and save payloads are revalidated and recalculated by the server.

### Main HTTP surfaces

`server/src/routes/public.routes.js` exposes configuration, SKU/price preview, save, decode, variation allocation, recount preview/apply, product history/archive, and export snapshot operations.

`server/src/routes/admin.routes.js` exposes catalog and pricing maintenance, SKU-schema publication, correction-request workflow, correction history, and mass repricing draft/preview/apply/rollback operations. Despite the path name, these routes are not currently access-controlled.

The client routes are defined in `client/src/router.jsx`:

- `/` — product builder, decoder/recount, history, and exports;
- `/admin` — structure and pricing configuration;
- `/admin/repricing` — repricing drafts and batches;
- `/admin/corrections` — correction-request queue;
- `/admin/corrections/history` — completed correction history.

## Repository map

| Path | Responsibility |
| --- | --- |
| `server/server.js` | Startup ordering, HTTP listener, signal handling, graceful shutdown. |
| `server/src/app.js` | Express middleware/routes, request IDs, structured request/audit logs, health endpoints, error responses. |
| `server/src/db/` | PostgreSQL pool, migration runner, default seed and legacy initialization compatibility. |
| `server/migrations/` | Ordered PostgreSQL DDL/data migrations; the schema source of truth. |
| `server/src/services/product.service.js` | Product preview/save, SKU decode, variation allocation, recount/apply, product lifecycle. |
| `server/src/services/sku-schema.service.js` | Immutable schema versions, V1 capture, publication, public active-schema projection. |
| `server/src/services/pricing.service.js` | Scenario selection, matrix lookup, modifiers, weight bands, price calculation, pricing admin writes. |
| `server/src/services/currency.service.js` | NBU USD/UAH retrieval, validation, cache, stale fallback, cross-replica persistence rules. |
| `server/src/services/repricing.service.js` | Scenario/global repricing candidates, previews, drafts, explicit price resolutions, transactional apply and rollback. |
| `server/src/services/correction-request.service.js` | Correction-request lifecycle, exclusive capability claims, refresh, completion, and release. |
| `server/src/services/export.service.js` | Immutable export snapshots, downloads, confirmation, monotonic export cursor. |
| `server/src/services/catalog.service.js` | Category/question/option/scenario administration and edit restrictions. |
| `server/src/utils/` | SKU codecs, rule matching, pricing axes, numeric/money parsing, CSV safety, HTTP retry limits, logging. |
| `server/data_config.js` | Defaults used only to seed an empty configuration database. It is not a live configuration file after seeding. |
| `server/test/` | Server unit tests using Node's built-in test runner. |
| `server/integration-test/critical-flows.test.js` | Destructive, PostgreSQL-backed end-to-end service/API, migration, upgrade, and concurrency tests. |
| `server/scripts/` | Data-integrity audit and optional SQLite configuration import. |
| `client/src/hooks/` | Client orchestration for main, recount, and admin workflows. |
| `client/src/lib/` | Testable client rules, formatting, validation, and API helpers. |
| `client/src/components/`, `client/src/pages/` | React UI. |
| `client/test/` | Client behavior/regression tests using Node's built-in test runner. |
| `scripts/postgres-*.sh` | Verified custom-format backup and explicit transactional restore. |
| `docker-compose.yml`, `*/Dockerfile`, `client/nginx.conf` | PostgreSQL/server/client images and runtime wiring. |
| `.github/workflows/ci.yml` | Node 20 CI with PostgreSQL 16, server tests, integration tests, client tests/lint/build. |

`README.md` contains basic Docker, audit, versioning, backup, and SQLite-import instructions. `client/README.md` is still the generic Vite template and is not project documentation.

## PostgreSQL data architecture

The important data groups are:

- catalog: `categories`, `questions`, `options`;
- published SKU structure: `sku_schema_versions`, `sku_schema_questions`, `sku_schema_options`;
- pricing: `price_scenarios`, `price_matrix`, `price_modifiers`, `price_weight_bands`, `exchange_rate_cache`;
- products and SKU ownership: `products`, `sku_registry`;
- corrections: `product_corrections`, `correction_requests`;
- repricing: `repricing_drafts`, `repricing_batches`, `repricing_items`;
- export: `export_snapshots`, singleton `export_state`, and legacy `export_events`;
- migration ledger: `schema_migrations`.

PostgreSQL `NUMERIC` columns make persisted weights, rates, and prices deterministic. Relevant scales include weight `(14,3)`, product USD/final values `(18,4)`, UAH `(18,2)`, exchange rates `(18,6)`, matrix prices `(18,4)`, and modifier factors `(12,6)`. The `pg` driver returns `NUMERIC` as strings; services convert values to JavaScript `Number` at calculation/API boundaries. The client compacts fixed-scale strings for display without changing stored values.

Many business checks and foreign keys added during the production upgrade are `NOT VALID`. PostgreSQL still enforces them for new or changed rows, but it does not scan and certify all older rows at migration time. This intentionally permits known legacy data to remain while preventing new invalid data.

## Categories, questions, and answers

The empty-database seed defines these initial categories:

| Code | Seed name | Seed weight behavior |
| --- | --- | --- |
| `BR` | Bracelets | weight required |
| `NM` | Necklaces | weight required |
| `CH` | Prayer beads | weight required |
| `KL` | Pendants | weight required |
| `DK` | Decor | sequence suffix |
| `SK` | Souvenir stone | sequence suffix |
| `AR` | Pictures | sequence suffix |

Question sets differ by category and include fields such as raw type, processing, quality, texture, color, size, shape, style, religion, count, and category-specific attributes. Questions and options are database records, can be conditional, and may differ in a deployed system from `server/data_config.js`.

Questions may be option-based or free text, required or optional, included in the SKU or informational, and conditionally visible. Options have a semantic `value_id`, a digit-only encoded `sku_code`, labels, visibility/hide rules, and an archive flag. Pricing and rules use semantic values; the SKU contains encoded codes.

Answer emptiness is explicit rather than truthy: numeric `0` is a real value, including calibration state `0` and any configured zero-valued option. Code must not treat `0` globally as blank. In a recount answer patch, an omitted key means “inherit the stored answer,” while explicit `null` or blank means “clear this answer”; target validation still decides whether the cleared result is allowed.

### Calibration states

For seeded categories that contain `raw_type`, `ensureCalibratedQuestions()` adds a required, non-SKU `is_calibrated` question visible for natural raw material (`raw_type=1`). Its exact values are:

- `0` — not calibrated;
- `1` — calibrated;
- `2` — semi-calibrated.

These are three distinct business values. In particular, `2` must never be coerced to boolean. Visibility and pricing behavior is driven by database rules and scenarios, so the labels do not imply additional universal behavior in code. The preview-token compatibility normalization treats a missing calibration value and `0` the same, while preserving `1` and `2` as distinct values; ordinary visible required-field validation still rejects a missing answer.

## SKU generation and schema versions

The live catalog is an editable draft. SKU-affecting changes do not redefine historical SKUs immediately. `publishSkuSchema()` captures an immutable snapshot and makes it the one active schema for a category.

- V1 has no version marker so pre-versioning SKUs remain decodable.
- V2 and later use a compact marker such as `BR2/`.
- The decoder also recognizes the short-lived historical `Vn-` marker format.
- Questions are encoded by `sku_index`, with configured separators where present.
- `value_id` is semantic; `sku_code` is the digit string placed into the SKU. Context-specific labels may share both only when they represent the same semantic value.
- Archived/hidden historical options remain in published snapshots so old SKUs can still decode.

Weight categories append rounded weight as the suffix. Non-weight categories allocate a per-base sequence number, padded to at least three digits. Corrections or explicit variants use `-NNN` suffixes when the proposed SKU is already reserved.

`sku_registry` is a permanent uniqueness ledger. A trigger normalizes/reserves every product SKU, and archiving or correcting a product does not free its SKU for reuse. This is deliberate: a historical identifier must never silently identify a different product.

On an upgraded installation, `ensureLegacySkuSchemas()` creates V1 snapshots and links unversioned products. For categories with products, it includes stored answer keys plus currently required SKU keys to avoid imposing unrelated later draft structure on historical identifiers.

## Pricing

`calculatePricing()` is authoritative. It selects active scenarios by priority and matching rules, resolves one- or two-dimensional matrix axes (including composite axes and weight bands), and optionally multiplies matching modifiers.

Price modes are:

- `per_gram_usd` — a positive matrix value is USD per gram and requires weight plus a USD/UAH rate for a UAH result;
- `fixed_uah` — a positive matrix value is the raw automatic UAH amount before marketing rounding and can remain usable if the exchange-rate provider is unavailable;
- `category_default` — resolves to the behavior appropriate to the category/scenario context.

A matrix cell must contain a strictly positive decimal. Blank or missing input deletes the row and means “no automatic price.” Zero is not a price and is rejected by the service/API and database constraint.

Automatic UAH pricing preserves two values: `calculatedPriceUah` is the raw result before marketing rounding, while `totalPriceUah` in a preview and `autoPriceUah` in stored details are the rounded automatic result. Rounding uses the tier selected from the raw amount: values through 100 are unchanged, then the nearest 10 below 300, 50 below 5,000, 100 below 25,000, 500 below 100,000, and 1,000 thereafter. Do not pre-round before selecting or applying the tier.

When there is no matching scenario, no matrix cell, or no usable automatic UAH result, preview returns no positive automatic price. Save and correction then require a valid positive manual UAH price. Manual input is user data, not server pricing context, so it is deliberately excluded from the stale-preview token and is parsed again during transactional save/apply. Manual prices are not marketing-rounded and retain decimals at the UAH column's `(18,2)` storage scale. Invalid, non-finite, zero, or negative final prices are rejected.

The empty-database seed creates formed and natural-calibrated scenarios for `CH`, `BR`, `NM`, and `KL`, plus a quality modifier. `uncalibratedPrices` exists in `data_config.js` but is not consumed by the current seed path; do not assume those entries exist in PostgreSQL.

### Exchange rate handling

The server obtains USD/UAH from the official NBU JSON endpoint. The HTTP helper applies a four-second timeout, a 256 KiB response limit, JSON/status validation, and two retries after the first attempt with bounded backoff. `NBU_RATE_OVERRIDE` exists for deterministic tests/controlled environments.

The provider deduplicates concurrent fetches inside one Node process and caches a successful rate for the current Kyiv date. Last-known-good data is persisted in `exchange_rate_cache`; a conditional upsert prevents an older replica from overwriting a newer fetch. If live retrieval fails, a cached/persisted rate may be used and is explicitly marked stale with source, age, and error metadata. The default maximum fallback age is seven days and is configurable through `NBU_MAX_STALE_MS`; older data fails closed.

## Product preview and save

`buildProductPreview()` validates category/schema ownership, required weight, visible questions, option existence, option visibility, and archive state. Active/visible required questions fail closed. Depending on the category's `skip_hidden_sku_questions` setting, hidden SKU questions are either omitted from the encoding or represented through the historical placeholder model.

The server returns an authoritative preview and `previewToken`. The token binds normalized answers/calibration, weight, schema version, base SKU, SKU mode, both raw and rounded automatic price, and effective exchange-rate context. Save requires both the schema-version ID and current token, then rebuilds the preview inside a transaction. A real pricing/schema/answer/weight change after preview causes a stale-preview conflict. Client-supplied calculated SKU or price fields are not trusted.

Save also locks sequence allocation when needed, validates a positive automatic or manual final price, reserves the exact SKU, and writes pricing/answer/schema metadata into `products.details`. New records preserve `calculatedPriceUah`, rounded `autoPriceUah`, and optional exact `manualPriceUah` separately while `products.total_price_uah` stores the chosen final price. Malformed and legacy-shaped payload fields are normalized only where explicitly supported; they do not bypass server validation.

## Decode and legacy compatibility

`decodeSku()` identifies the category by longest prefix, resolves the historical schema marker, parses SKU answers and suffix/variation, then overlays stored product context where necessary for historical compatibility. The decoder can use archived or now-hidden snapshot options. For a known product, stored answers are accepted only if they reproduce the encoded SKU; arbitrary stored data cannot redefine an identifier.

For a stored product, decode reports the historical final `total_price_uah` rather than replacing it with a calculation from current configuration. It also returns stored pre-rounding and automatic values. Compatibility fallback treats an older `autoPriceUah` as the calculated value when `calculatedPriceUah` is absent, and for a non-manual legacy row may use stored final UAH as its automatic value. A manual row without a stored automatic value must not invent one from its manual final price.

Historical placeholder `0` or a missing stored value may represent an omitted SKU question only when no real zero option exists and the stored-answer reconstruction still reproduces the SKU. A genuine configured zero option remains a genuine value. Unknown/invalid codes still fail with structured diagnostics.

Calibration is reported as known, stored, unknown, or not applicable. Price display is hidden only when calibration is unknown and the selected pricing calculation actually depends on calibration.

Migration 016 preserves legacy products whose `total_price_uah=0`. Historically this meant “price not set.” Such rows retain the stored zero and are marked `legacy_uah_price_unset=true`; retaining zero prevents decode from silently falling back to today's automatic matrix price. The compatibility flag only relaxes the database check for grandfathered rows. New saves and corrections never set it and still require a strictly positive final price. Legacy zero-price products remain available for recount/editing.

## Recount, corrections, and correction requests

Recount starts from a decoded, existing, active, uncorrected source product and applies the submitted answer patch to its stored/historical answers. Omitted keys inherit their prior values. Explicit `null`, `undefined`, or blank values remove the named answer, enabling optional answers to be cleared; a required visible answer then fails normal target validation. Numeric `0` is preserved as data and is not a clearing sentinel. Recount always targets the category's current active SKU schema.

The critical transition rule is target-based: after the explicit patch is merged and before target preview/validation, `omitHiddenRecountAnswers()` separately removes every inherited answer for a question in the active **target SKU schema** when that question is hidden in the target configuration. This applies whether the old value was a placeholder such as `0` or a previously valid value such as a calibrated size. The corrected product does not retain those obsolete hidden SKU answers. Conversely, any SKU question visible in the target remains required/validated normally. This compatibility behavior is recount-only and must not weaken ordinary new-product validation.

The current cleanup helper receives published SKU-schema questions, not live non-SKU questions. Therefore the broader proposition “all hidden inherited answers, including non-SKU metadata, are removed” cannot be confirmed from current code. Any need to broaden that scope is a separate behavior change and requires a reproduced case and regression test.

Preview requires at least one actual answer change and computes a proposed corrected SKU and price. A missing automatic price can be resolved with a positive manual UAH price. Apply then:

1. locks and rechecks the source row and its state signature;
2. rebuilds target preview/pricing in the transaction;
3. validates manual/automatic final pricing;
4. blocks direct apply when an active correction request owns the source;
5. serializes/resolves the corrected SKU or next variation;
6. inserts the new active product and correction audit row;
7. marks the source `corrected` and links both records.

Both source and corrected records are excluded from the normal export queue by the recount apply code. This is current behavior and should not be changed accidentally.

Correction requests add a managed pending/in-progress/completed/rejected queue. Only one active request per source is allowed. Claiming uses one conditional database update, so concurrent attempts yield exactly one successful owner. The server returns a random capability token once, stores only its SHA-256 hash, and exposes only a short fingerprint in later queue responses. The browser keeps the raw token in local storage; matching it proves control by that browser installation, not the identity of a real user.

Claims do not expire automatically. Refresh, reject, complete, and ordinary release of an in-progress request require the matching token. Owner release clears the claim and returns the request to pending; confirmed force-release does the same without the token. Because authentication/RBAC is absent, force-release is not currently an authorized administrator action in the security sense. A future auth layer must add real actor identity without treating these browser capability claims as user accounts.

The correction queue loads immediately, then polls every five seconds while the page is visible. Hidden tabs skip requests; focus or renewed visibility triggers an immediate refresh. Polls do not overlap, and older responses cannot overwrite newer queue state. Signatures detect stale source/proposed state; refresh recalculates; completion invokes the same transactional recount application and records the final payload. Active requests block competing direct correction and repricing. Completion also attempts to synchronize affected repricing drafts.

## Mass repricing

Repricing supports both scenario scope and global catalog scope. Scenario preview considers active products matched to one selected scenario. Global preview considers every active product exactly once, loads pricing context per category plus one exchange-rate result, and applies normal authoritative scenario priority when scenarios overlap. Rows are classified as changed, unchanged, skipped, or error.

Manual-priced rows are never silently converted. Each requires an explicit resolution: a positive manual override equal to the stored price means “keep manual,” and a different positive value means “set manual.” A row without a usable automatic price also requires a positive manual resolution. In global scope only, a manual-priced row that currently has a valid authoritative matrix result may instead be listed in `automaticProductIds`, explicitly clearing `manualPriceUah` and switching to the rounded automatic price. The same product cannot receive both resolutions, and unrelated calculation errors cannot be resolved this way.

The preview token and draft fingerprint bind the scope, complete pricing configuration, candidate/product state, raw and rounded calculations, and normalized resolutions. One active global draft is enforced separately from the existing one-per-scenario drafts. Drafts persist the preview snapshot, manual overrides, automatic-switch IDs, reviewed product IDs, and UI state; synchronization refreshes the snapshot and drops reviewed IDs no longer present.

Apply re-previews and rejects stale configuration/product state, unsaved draft resolutions, unresolved errors, and active correction requests. It locks changed products in stable ID order. The completed batch, every product update, recorded old/new item payloads, and normal draft transition to applied are committed in one transaction; a mid-apply failure leaves no batch or product changes. Repricing details preserve `calculatedPriceUah`, rounded `autoPriceUah`, the chosen manual/automatic state, and the batch owner.

Rollback locks the batch and all products, requires every product to remain active, batch-owned, and equal to that batch's recorded new payload, then restores every old payload and marks the batch rolled back in one transaction. Any later edit blocks the entire rollback. Completed apply is idempotent through a unique application token; rolled-back batches no longer occupy that active token.

## CSV export snapshots

The legacy direct CSV endpoint is disabled (`410`). The supported flow is create snapshot, download its stored CSV, then explicitly confirm it.

Ranges are anchored by existing SKUs but resolved by product ID/creation order, not lexicographic SKU order. Reversed endpoints are normalized. Rows with `exclude_from_export=1` are omitted. CSV contains SKU, the stored final UAH price (including manual decimals), a derived bracelet/necklace size field, and configured free-text fields.

Snapshot payload and CSV content are stored once and protected by a database trigger from mutation. A required `Idempotency-Key` identifies the normalized requested `fromSku`/`toSku` pair. Reuse for the same range returns the same snapshot; reuse for a different range returns `409`, including the loser of a concurrent insert race.

Confirmation is idempotent and locks the snapshot. The singleton export cursor advances with `GREATEST(exported_to_product_id)` and cannot move backward when snapshots are confirmed concurrently or out of order. `last_snapshot_id` follows the non-regressing cursor. Legacy `export_events` are retained only for status compatibility.

CSV fields are quoted/escaped for commas, quotes, and newlines. Text beginning with spreadsheet formula sigils (`=`, `+`, `-`, or `@`, including after leading whitespace/tab) is prefixed to prevent formula execution.

## Catalog and schema editing restrictions

- A category code cannot change after products, reserved SKUs, or published schemas linked to products establish use. Name, weight behavior, and hidden-question behavior remain editable.
- Changing live SKU questions/options edits the draft. Publish a new immutable schema version for new products; do not mutate historical snapshots.
- A used option's semantic `value_id` cannot be changed. Archive options instead of deleting/reinterpreting historical meaning.
- A schema cannot map the same SKU code to different semantic values within one question, though conditional labels may share the same value/code.
- Duplicate `(category_code, question.key)` writes are serialized by a transaction advisory lock and rejected by the trigger. Existing legacy duplicates are not automatically cleaned because no unconditional unique index can be installed safely without a data decision.

## Migration system

`server/src/db/run-migrations.js` runs every `.sql` file in lexical order before seeding/listening. It uses a dedicated PostgreSQL client, a session advisory migration lock, and disables query/statement timeouts for legitimate long DDL. Each new file is its own transaction; a failure rolls back that file and leaves it unapplied.

Applied files are recorded by name and SHA-256 checksum. SQL line endings are canonicalized (`CRLF` and lone `CR` to `LF`) before hashing, so Linux and Windows checkouts agree and existing LF-generated production checksums remain valid. Databases created before checksum support have null checksums backfilled on first verification. A non-null checksum mismatch aborts startup, preserving protection against real content edits.

Never edit an already-applied migration. Add a new forward migration.

| Migration | Purpose and safety notes |
| --- | --- |
| `000_initial_schema.sql` | Idempotent baseline table creation for a fresh database. `CREATE TABLE IF NOT EXISTS` does not retrofit arbitrary missing columns/constraints into an unknown partial legacy table; later migrations and tested known upgrade paths supply expected upgrades. |
| `001`–`005` | Permanent SKU registry/indexes, scenario controls/weight bands, repricing batches, option hiding, and option archiving. |
| `006`–`007` | Immutable SKU schema tables/product links and compact V2+ markers. |
| `008`–`010` | Repricing rollback semantics, drafts, and reviewed-product state. |
| `011` | Correction-request workflow and status cleanup. |
| `012` | Positive, dated USD/UAH last-known-good cache. |
| `013` | Immutable export snapshots and monotonic singleton export state. |
| `014` | Converts pricing/weight columns to `NUMERIC` and adds `NOT VALID` business checks/FKs plus the first duplicate-question trigger. Type conversions can take locks and be long-running on production data; startup timeouts are disabled, but deployment still needs an operational window and backup. |
| `015` | Makes known fresh/legacy foreign-key topology equivalent and fixes the duplicate-question race with an advisory transaction lock. |
| `016` | Deletes zero matrix cells as absent prices and grandfathers existing zero-price products without allowing new zero-priced products. |
| `017` | Adds scenario/global scope to repricing drafts and batches and enforces one active global draft. |
| `018` | Adds hashed capability claims and claim timestamps to correction requests, including compatibility for legacy unowned in-progress rows. |

The integration suite compares fresh, pre-checksum legacy, and checkpoint-upgrade topology and tests repeated startup, failed-file rollback, timeout independence, checksum normalization, legacy-zero compatibility, and migration of legacy unowned in-progress correction requests. This covers the repository's known upgrade shapes; it is not a guarantee for an arbitrary manually altered database.

`server/src/db/init-db.js` still contains `legacyInitDb()` for compatibility/tests, but normal startup treats migrations as DDL source of truth, then seeds only an empty catalog and ensures calibration questions.

## Concurrency and database invariants

Important protections are intentionally layered:

- migrations use a global session advisory lock;
- default seeding/calibration creation and legacy schema capture each use shared session locks and transaction/recheck logic, making parallel replica bootstrap idempotent;
- SKU schema publication uses a per-category transaction advisory lock and row lock;
- product sequence allocation, variation resolution, and exact SKU reservation are serialized and backed by the permanent `sku_registry` trigger;
- save rebuilds authoritative preview inside its transaction;
- recount/correction locks and signs the source before inserting/linking a successor;
- one active correction request per source and active repricing drafts per scope owner are enforced by partial unique indexes;
- correction-request claiming is a conditional atomic update; subsequent owner operations compare the stored token hash, while confirmed force-release deliberately bypasses ownership;
- repricing locks product rows in ID order and applies or rolls back atomically;
- export snapshots have unique idempotency keys, immutable payloads, row-locked confirmation, and a monotonic cursor.

Lock ordering matters. New code that touches products, correction requests, repricing drafts/batches, schema publication, or SKU allocation must follow existing ordering and revalidation patterns rather than adding an isolated lock. PostgreSQL can still report a deadlock if future paths acquire these resources in a different order; callers should surface/handle the transaction failure rather than partially continuing.

## Operations, health, and shutdown

The ordinary request pool has configurable maximum size, idle/connect timeout, query timeout, and statement timeout. Migration DDL deliberately uses a separate client with no query/statement timeout. Long legitimate non-migration operations still use the normal request limits.

`/health/live` reports that Express is running. `/health/ready` performs `SELECT 1`; because the listener starts only after migration/seed/schema bootstrap, readiness also implies those startup phases completed for that process. It does not perform a full business-data audit or verify NBU availability.

Requests receive/return an `X-Request-ID`; completion and mutations are logged as structured JSON. Mutation audit entries currently have `actorId: null` because authentication is absent.

SIGTERM/SIGINT stop accepting HTTP connections, wait for the HTTP server to close, close the PostgreSQL pool, and force-exit after ten seconds if shutdown stalls.

Docker Compose builds PostgreSQL 16, the Node server, and an nginx-hosted production client. The checked-in Compose configuration is suitable as a development/single-host baseline, not a hardened security boundary: it exposes PostgreSQL and contains static development-style connection configuration. Production must supply protected credentials/networking externally.

`scripts/postgres-backup.sh` creates a timestamped PostgreSQL custom-format archive, removes an incomplete archive on failure, verifies it is non-empty, and checks its archive listing. `scripts/postgres-restore.sh` requires both an explicit path and `--confirm`, validates the archive, stops client/server if running, restores with `--clean --if-exists --single-transaction --exit-on-error`, performs basic product/migration table checks, and restarts only services that were previously running. Backups must be copied to a monitored off-host destination and restore-tested; that infrastructure is intentionally outside this repository.

The optional SQLite importer migrates configuration/pricing, not product history. It refuses implicit replacement of a non-empty target and refuses replacement when target products exist; `--replace` is explicit.

## Tests and CI

Server unit tests cover SKU parsing/history/placeholders, schema markers and code semantics, rule matching, calibration, preview-token behavior, pricing scenarios/context, marketing rounding, global/manual/automatic repricing resolutions, money/numeric validation, currency fallback/concurrency, HTTP retry limits, correction signatures/history, CSV injection safety, migration checksums, and backup/restore script safeguards. Semi-calibrated state `2` is exercised by PostgreSQL recount integration fixtures, but there is no dedicated unit assertion that directly compares preview tokens for `0`, `1`, and `2`.

Client tests cover visibility rules, answer labels, admin conditions, manual-price validation/payloads, matrix-zero UI behavior, numeric display formatting, explicit recount clearing/zero preservation, correction-claim persistence and visibility-aware polling, and global repricing resolutions.

`server/integration-test/critical-flows.test.js` uses real PostgreSQL and independent processes/connections where races require them. It verifies final database state as well as HTTP responses. Major cases include:

- liveness/readiness;
- calibrated-to-semi-calibrated recount with target-hidden answer removal, explicit optional clearing, real-zero preservation, legacy hidden zero, and visible-target rejection;
- parallel replica seed/schema bootstrap and rollback/retry;
- migration timeout isolation, failure rollback, checksum compatibility, and fresh/upgrade equivalence;
- migrations 016–018 legacy-zero and correction-claim upgrade behavior;
- atomic duplicate-question enforcement;
- positive-or-delete matrix cells;
- authoritative preview/save, stale pricing rejection, fail-closed payload validation, and concurrent sequences;
- manual-price correction, concurrent correction, concurrent exclusive correction-request claims, release/force-release, completion ownership, and repricing blocking;
- exchange-cache ordering;
- category-code immutability;
- scenario/global repricing, explicit keep/set-manual and manual-to-automatic resolutions, apply/rollback cycles, and forced mid-apply rollback;
- immutable/idempotent/concurrently confirmed exports with a monotonic cursor;
- SQLite import safety.

The integration setup is intentionally destructive: it drops/recreates the `public` schema and temporary databases, and refuses to run unless the configured database name ends in `_test`. Use only a disposable PostgreSQL database.

CI uses Node 20 and a PostgreSQL 16 service, then runs server unit tests, PostgreSQL integration tests, client tests, client lint, and the client production build.

## Known limitations and deferred work

- PostgreSQL exposure/static credentials and broader deployment secret management are intentionally deferred security issue #1. Do not copy checked-in development values into new documentation or production infrastructure.
- Authentication, authorization, RBAC, and attributable actor IDs are intentionally deferred security issue #2. All public/admin API routes are currently reachable to any network client that can reach the server.
- Live catalog contents and production data quality cannot be confirmed from the repository. Seed defaults describe only a newly initialized empty database.
- The client README is generic template text.
- The repository provides backup/restore mechanics but not scheduling, retention, encryption, off-host transfer, monitoring, or disaster-recovery orchestration.
- JavaScript calculation boundaries use `Number`, so PostgreSQL's full arbitrary `NUMERIC(18,*)` precision is not preserved for values near JavaScript's safe-integer limits. Normal business-scale behavior is covered; no explicit maximum business value is encoded in the application.

## Decisions that must not be casually reversed

- Keep server-side preview/save/recount/repricing validation authoritative and fail closed.
- Preserve `is_calibrated` as a three-value number; never boolean-normalize state `2`.
- Do not include manual price in stale-preview pricing context, but always validate it independently at write time.
- Preserve pre-rounding `calculatedPriceUah`, rounded automatic price, and final/manual price as separate meanings. Marketing-round automatic prices only; manual prices stay exact.
- Treat a blank matrix cell as absent and reject zero; do not silently coerce zero to another price.
- Preserve legacy product zero in storage with its compatibility flag; converting it to null can incorrectly select today's automatic price.
- In recount patches, explicit null/blank clears an answer and omitted keys inherit; never treat numeric `0` as globally empty.
- In recount only, separately drop inherited SKU answers hidden by the target configuration; keep target-visible and all ordinary new-product validation strict.
- Never reuse a SKU, mutate a historical schema snapshot, or reinterpret a used semantic option value.
- Preserve migration checksums and line-ending canonicalization; use new forward migrations.
- Keep scenario/global repricing apply/rollback atomic and require explicit keep/set-manual or eligible global manual-to-automatic resolutions.
- Keep correction claims exclusive and capability-based until real authentication is deliberately added; do not present browser ownership as user identity.
- Keep export CSV immutable after generation, idempotency range-bound, formula-safe, and cursor advancement monotonic.

## Current status

The PostgreSQL architecture and workflow protections through migrations `000`–`018` are present on `feature/postgresql`, with focused unit/integration regression coverage and CI configuration. Authentication/security issues #1 and #2 remain deliberately unresolved, and actual production configuration/data must be checked operationally rather than inferred from this checkout.
