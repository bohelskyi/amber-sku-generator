# AGENTS.md

## Repository orientation

- `server/` — Node 20/CommonJS Express API and all authoritative business logic.
- `server/src/services/` — product/SKU, schemas, pricing, recount/corrections, repricing, exports.
- `server/migrations/` — ordered PostgreSQL schema source of truth (`000`–`018` currently).
- `server/test/` — unit tests; `server/integration-test/critical-flows.test.js` — real PostgreSQL tests.
- `client/` — React 19/Vite UI; client orchestration is in `src/hooks`, reusable rules in `src/lib`.
- `scripts/` — PostgreSQL backup/restore; `server/scripts/` — integrity audit and SQLite config import.
- `docker-compose.yml` — PostgreSQL/server/nginx-client stack.
- Read `PROJECT_CONTEXT.md` before changing business behavior.

## Run locally

Use Node 20 and a PostgreSQL connection supplied through environment variables. Never put real credentials in commands that will be committed or documented.

Server:

```text
cd server
npm ci
set DATABASE_URL in your shell
npm start
```

Startup applies migrations, seeds only an empty catalog, captures missing legacy V1 schemas, then listens on port 5000 by default.

Client (a separate terminal):

```text
cd client
npm ci
npm run dev
```

Vite proxies `/api` to `http://localhost:5000`. Override the client API with `VITE_API_BASE_URL` when needed.

Docker build/run:

```text
docker compose up -d --build
docker compose ps
docker compose logs -f
```

The checked-in Compose connection settings are development-style. Do not reuse them as production secret/network configuration.

## Required verification

For a localized fix, first add and run the narrow regression test. Before committing, run all applicable checks:

```text
cd server
npm test

set TEST_DATABASE_URL to a disposable database whose name ends in _test
npm run test:integration

cd ../client
npm test
npm run lint
npm run build

cd ..
git diff --check
git status --short
```

The integration suite destroys/recreates its target `public` schema and creates temporary databases. Never point it at production, staging, a developer database with useful data, or any database not dedicated to tests. It deliberately refuses a primary database name that does not end in `_test`.

There is no separate server lint/build script. For deployment-image changes, also run:

```text
docker compose build
```

CI (`.github/workflows/ci.yml`) uses Node 20 and PostgreSQL 16 and runs server unit/integration tests plus client test/lint/build.

## Change discipline

- Reproduce a concrete bug before changing production code.
- Make the smallest scoped fix and add a focused regression test that exercises the original failure.
- Concurrency tests must execute concurrently, use independent PostgreSQL connections/processes where required, create a real race window, and assert final database state—not only response codes.
- Do not make unrelated refactors while fixing a localized production bug.
- Do not change production database data or migrations unless the task explicitly requires it.
- Preserve user changes in a dirty worktree. Do not reset or rewrite unrelated work.
- Never commit `.env` files, database dumps, backups, SQLite files, tokens, passwords, or other secrets.

## Migration and database rules

- Never modify an already-applied migration. Add the next forward migration.
- Preserve migration checksum compatibility. `getMigrationChecksum()` canonicalizes CRLF/lone CR to LF; do not remove or bypass this behavior.
- Do not rewrite stored production checksums to hide a mismatch. A real SQL-content change must fail startup.
- Keep migrations transactional and safe for both fresh and known upgrade paths. Add integration coverage for fresh DB, existing/checkpoint DB, repeated startup, and failure rollback as applicable.
- Remember that `NOT VALID` constraints enforce new/updated rows but do not validate every legacy row.
- Migration DDL uses a dedicated no-query-timeout connection because legitimate operations such as migration 014 type conversion can run longer than request queries.
- Treat migrations as DDL source of truth. `legacyInitDb()` is compatibility/test code, not permission to add runtime DDL.
- Use parameterized SQL for data. Validate any unavoidable dynamic database identifier against a strict allowlist/pattern first.
- Respect existing transaction and lock ordering. Product, correction, repricing, schema, and export paths rely on row locks, advisory locks, unique indexes, and final-state revalidation together.

## Business invariants

### SKU and catalog

- The server is authoritative for SKU generation and pricing. Never trust client-computed SKU/price fields on save.
- Published SKU schemas are immutable history. Edit the live draft and publish a new version.
- V1 has no marker; V2+ uses compact markers such as `BR2/`. Preserve historical marker decoding.
- `value_id` is semantic; digit-only `sku_code` is encoded. Do not conflate them.
- Never reuse a SKU. `sku_registry` reservations survive archive/correction.
- Category codes are immutable after use. Used option semantic values must not be reinterpreted; archive instead.
- Preserve fail-closed validation for every active/visible required SKU and non-SKU question. Hidden/archived/invalid options must not become valid for new products.
- `is_calibrated` has three distinct numeric states: `0` not calibrated, `1` calibrated, `2` semi-calibrated. Never coerce it to boolean; token normalization must preserve `2` distinctly.

### Pricing

- Matrix prices are strictly positive decimals. Blank/missing means delete the cell/no automatic price. Explicit zero is invalid and must never be silently converted.
- Missing automatic price requires an independently validated positive manual UAH price for save/correction.
- Manual price is user input and must not itself stale a preview; real matrix/scenario/modifier/schema/rate changes must still stale it.
- Automatic UAH prices use marketing rounding based on the unrounded amount. Preserve the unrounded `calculatedPriceUah` separately from rounded `autoPriceUah`/final price so save, recount, repricing, audit data, and historical decode retain both meanings.
- Manual UAH prices must not receive automatic marketing rounding; preserve their decimal amount subject only to validated storage precision.
- Historical decode must prefer stored calculated/automatic/final price fields. Keep compatibility fallbacks for older products that lack the newer split fields; do not recalculate their history from current pricing.
- New saves/corrections must reject zero final prices.
- Preserve legacy `total_price_uah=0` plus `legacy_uah_price_unset=true`. Do not convert it to null: null can fall back to current automatic pricing. Legacy zero-price products must remain recountable/editable.
- Keep NBU response validation, bounded retries/timeouts, stale-age limit, in-process request deduplication, and newer-fetch-wins persisted cache behavior.

### Recount and corrections

- Recount validates the **target** configuration. Before target validation/apply, remove every inherited answer for a SKU question hidden/inactive in the target, regardless of its old value. The current helper is scoped to published SKU-schema questions; do not claim it cleans hidden non-SKU metadata without adding that behavior and coverage in an explicitly scoped task.
- If the question is visible in the target, require and validate it normally.
- Apply target-hidden cleanup only to recount/correction transitions. Never weaken ordinary new-product validation or add legacy placeholders as normal active options.
- Recount answer updates are patches: an explicit `null`/blank clears that answer, while an omitted key inherits the old value. Optional clearing is separate from target-hidden cleanup and must still pass target validation.
- Numeric `0` is a real answer (including calibration state `0` and configured zero-valued options), not a global empty sentinel. Do not use truthiness-based answer clearing or normalization.
- Corrected product details must not retain obsolete hidden answers.
- Recount apply must lock/revalidate the source, rebuild current target pricing, and atomically insert/link audit records. Preserve correction-request blocking and stale signatures.
- Correction-request claiming is an atomic compare-and-set: concurrent claim attempts must produce one owner. Owner-only refresh, reject, complete, and release require the capability token; confirmed force-release returns an in-progress request to pending without it.
- Claim tokens do not expire automatically. The raw token is kept in browser-local storage and only its hash is stored in PostgreSQL; queue responses expose a short fingerprint. The queue polls every five seconds only while visible, refreshes immediately on focus/visibility return, and prevents overlapping/stale responses.
- A correction claim represents control by one browser installation, not authenticated user identity. Preserve this distinction when adding future authentication.

### Repricing

- Preserve both scenario-scoped repricing and global repricing. Global preview covers every active product once and uses normal authoritative scenario precedence across the current pricing configuration.
- Preview/drafts bind scope, candidate/product state, pricing configuration, calculations, and normalized resolutions. Apply must re-preview/revalidate and remain all-or-nothing; one active global draft is allowed alongside per-scenario drafts.
- Manual-priced and missing-automatic-price rows require explicit resolution. A positive manual override may keep the same manual price or set a new one. In global repricing only, a manual-priced row with a valid authoritative automatic result may explicitly switch to automatic; clear `manualPriceUah` only for that explicit choice. Missing-price rows cannot switch to a nonexistent automatic price.
- Lock product rows in stable ID order. Rollback only when every product still exactly matches and is owned by the batch, and restore atomically.
- Active correction requests block repricing of the same product.

### Export

- Use immutable export snapshots; the legacy direct export endpoint stays disabled.
- Bind each idempotency key to the same normalized requested range. Same key/different range is a conflict, including concurrent insert losers.
- Confirmation is idempotent and the product-ID cursor must only advance, never regress under out-of-order/concurrent confirmations.
- Never mutate stored snapshot payload/CSV after creation.
- Preserve CSV quoting and spreadsheet-formula neutralization.

## Operations safety

- `/health/live` is process liveness; `/health/ready` checks PostgreSQL and is served only after startup migration/seed/schema work completes.
- Preserve graceful SIGTERM/SIGINT behavior and pool shutdown.
- Use `scripts/postgres-backup.sh` for verified custom-format backups.
- `scripts/postgres-restore.sh` is destructive: it requires `--confirm`, stops app services, and uses a single-transaction, exit-on-error restore. Use it only against the explicitly intended environment after validating the dump path and target.
- Keep backups outside the repository and test restores in a disposable environment.

## Deferred security scope

Database exposure/static credential hardening and authentication/authorization/RBAC are known, intentionally deferred issues. Do not claim admin routes are protected. Do not opportunistically implement or remove security behavior during unrelated fixes; address it only in an explicitly scoped task.
