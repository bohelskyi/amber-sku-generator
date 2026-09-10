# Comprehensive refactoring audit and phased plan

## Document status

This document records the read-only repository audit performed on 2026-09-11 before any refactoring work. The audited revision was:

- commit: `b5617ace75b2617a3454768341bc6a6182e5ab3e`;
- checked-out branch: `refactor/codebase-cleanup`;
- local `main` contained the same commit;
- the working tree was clean before and after the audit.

`PROJECT_CONTEXT.md` still described the checkout as `feature/auth-rbac` at the time of the audit. Confirm the intended implementation base before beginning Phase 1.

This is a plan, not an authorization to change production behavior, data, migrations, dependencies, or configuration. Current code and PostgreSQL migrations remain authoritative where this document or older domain documentation becomes stale.

## Executive assessment

The repository is healthy enough to refactor incrementally and does not need a rewrite. No correctness failure was found during the audit, and the untouched checkout passed the complete required test suite.

The primary maintainability problem is concentration rather than a fundamentally unsound architecture:

- server business rules, PostgreSQL operations, transaction orchestration, audit writing, and response shaping are often colocated in large service files;
- several client pages and hooks act as implicit workflow state machines with dozens of independent state variables and direct API calls;
- backend integration coverage is strong but concentrated in one 8,614-line test file;
- some client regression tests inspect source text instead of observable behavior, making safe structural changes unnecessarily difficult;
- documentation is materially behind the deployed code.

The recommended strategy is to strengthen behavioral characterization, establish transport and read-model seams, and only then extract business-critical internals. Transaction scope, locks, tokens, stored payloads, public API behavior, historical compatibility, and server authority must remain unchanged unless a separately approved behavior change explicitly requires otherwise.

## Baseline verification

### Audit results

The following checks passed on the untouched audited revision:

| Check | Result |
| --- | --- |
| Server unit suite | 145 passed, 0 failed |
| PostgreSQL integration suite using the prescribed disposable `amber_test` database on port 55432 | 77 passed, 0 failed |
| Client Node tests | 101 passed, 0 failed |
| Client Vitest tests | 37 passed across 4 files |
| Client ESLint | Passed |
| Client production build | Passed |
| Compose configuration validation | Passed |
| `git diff --check` | Passed |
| Final working-tree status | Clean |

The canonical `postgres-test` service was stopped after verification. Existing development Compose services were left untouched.

The client build did not indicate an urgent bundle-size problem. The lazy-loaded main JavaScript chunk was approximately 299 KB uncompressed and 100 KB gzip, with separate Admin and Repricing chunks. The global CSS asset was approximately 114 KB uncompressed and 16 KB gzip. Its organization is a maintainability issue, but its transferred size is not currently evidence of a performance emergency.

### Baseline to repeat before and after implementation phases

Use lockfile-clean dependency installs in CI or a clean disposable worktree, then run:

```text
git status --short

cd server
npm ci
npm test

docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test
set TEST_DATABASE_URL=postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/amber_test
npm run test:integration
docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test

cd ../client
npm ci
npm test
npm run lint
npm run build

cd ..
docker compose -f docker-compose.yml -f docker-compose.local.yml config --quiet
git diff --check
git status --short
```

The environment-variable assignment should use the native syntax of the active shell. Never substitute another PostgreSQL instance if the canonical disposable test environment fails.

Add `docker compose build` and health/startup/shutdown smoke testing to phases that alter Docker, Compose, startup, nginx, or deployment behavior. Do not require an image build for unrelated source-only phases.

## Current architecture

### Strong boundaries to preserve

- `server/src/app.js` mounts session handling, OIDC routes, authenticated-session enforcement, active application-user resolution, method-aware CSRF enforcement, and business routers in the correct order.
- Effective application-user status, roles, and permissions are read from PostgreSQL on every business request, so disablement and permission revocation affect existing sessions immediately.
- Durable audit events require a transaction-scoped database client and a valid local application-user mutation context.
- User and role administration share an advisory-lock boundary and final authorization revalidation in `server/src/services/access-admin-transaction.js`.
- SKU reservation, product save/recount, repricing apply/rollback, export confirmation, schema publication, seed/schema capture, and migration execution contain meaningful transactional and concurrency protections.
- Service dependencies are mostly directional: routes call services, and services call focused utilities and PostgreSQL. A new application framework is not required.
- Client route-level lazy loading is already implemented, and the current production bundle does not justify a framework or bundler migration.

### Weak boundaries

- `server/src/routes/admin.routes.js` is 906 lines and exposes 59 endpoints across audit, user, role, catalog, pricing, correction, history, and repricing domains.
- Several services act simultaneously as calculator, repository, command handler, transaction coordinator, audit assembler, and response presenter.
- `server/src/services/repricing.service.js` is 2,129 lines; `product.service.js` is 1,564; `pricing.service.js` is 1,178; and `catalog.service.js` is 1,106.
- Raw PostgreSQL is appropriate for the business invariants, but direct pool use and inconsistent `queryable` injection make transaction intent and testing harder to see. The inspected server source contains approximately 284 SQL statement lines and 85 direct pool access sites.
- Client workflows are concentrated in `client/src/pages/RepricingPage.jsx` at 1,664 lines, `client/src/components/app/HomeDashboard.jsx` at 992 lines, `client/src/hooks/useAdminPanel.js` at 721 lines, and `client/src/hooks/useSkuManager.js` at 591 lines.
- Client API access is scattered across approximately 82 direct `api.get`, `api.post`, `api.put`, `api.patch`, and `api.delete` call sites.
- Database rows, legacy API contracts, and client models mix snake_case and camelCase. Much of that is compatibility-sensitive; normalization should be introduced only at new internal boundaries rather than through wholesale API or schema renaming.

## Refactoring portfolio

Risk classifications used throughout this plan:

1. **Low risk / behavior-preserving**
2. **Medium risk / structural**
3. **High risk / business-critical**

### 1. Documentation reconciliation

**Classification:** 1 — Low risk / behavior-preserving

**What is wrong today**

- `PROJECT_CONTEXT.md` says that the audit viewer is pending and omits implemented catalog/pricing audit coverage.
- `docs/AUTH_RBAC.md` still describes the Administrator-only audit viewer as absent.
- `docs/OPERATIONS.md` says mutation actor attribution remains null, while `server/src/app.js` logs the resolved application-user ID.
- `client/README.md` is the default Vite template rather than project documentation.
- `README.md` says `cd amber-app`, and its generic HTTP opening instruction does not match the documented production HTTPS topology.

**Files/modules involved**

- `PROJECT_CONTEXT.md`
- `docs/AUTH_RBAC.md`
- `docs/OPERATIONS.md`
- `README.md`
- `client/README.md`
- audit route, client page, event writers, and request logging code used as authoritative evidence

**Why valuable**

Accurate documentation is a safety control for future work in authentication, audit, operations, and business-critical domains.

**Expected scope**

One documentation-only pull request. Update only claims that can be verified from current code and migrations; do not infer live production data.

**Risks/regressions**

The main risk is overstating unfinished invitation functionality or audit coverage.

**Tests required**

Check links and compare documented routes/events with the code, then run the normal baseline.

**Dependencies**

None.

### 2. Behavior-level characterization coverage

**Classification:** 1 — Low risk / behavior-preserving

**What is wrong today**

`client/test/ui-regressions.test.js` and `client/test/recount-live-pricing.test.js` frequently assert source strings, regular expressions, and CSS text. Those tests can fail when code is moved even if runtime behavior is unchanged.

High-value gaps include:

- rendered Repricing autosave, stale-response, draft-conflict, apply, and rollback flows;
- Admin catalog/pricing mutation, publication, permission-limited, and error states;
- Product Builder preview/save/manual-price/variation flows;
- Correction claim/release/complete polling behavior;
- server integration coverage for full question-key reference rewriting;
- server integration coverage for used option semantic-value protection;
- explicit HTTP status/code/body contracts before error handling is centralized.

**Files/modules involved**

- `client/test/ui-regressions.test.js`
- `client/test/recount-live-pricing.test.js`
- existing client Vitest suites and workflow components/hooks
- `server/integration-test/critical-flows.test.js`
- catalog, pricing, product, correction, repricing, auth, and route modules

**Why valuable**

This creates the safety envelope required by every later structural change.

**Expected scope**

Add behavior tests first. Retain source-inspection tests until equivalent observable behavior is covered, then remove them incrementally.

**Risks/regressions**

Mocks can accidentally hide response ordering, transaction, or concurrency problems.

**Tests required**

Use fake timers, deferred promises with reversed completion order, rendered accessibility assertions, and real PostgreSQL tests that use independent clients and assert final database state.

**Dependencies**

None. This is a prerequisite for items 4–15.

### 3. Safe integration-test organization

**Classification:** 2 — Medium risk / structural

**What is wrong today**

All 77 PostgreSQL integration tests, their authentication helpers, migration checkpoint construction, SQL fixtures, and process helpers live in the 8,614-line `server/integration-test/critical-flows.test.js`.

Simply splitting the file is unsafe because Node can execute test files concurrently against the same destructive database.

**Files/modules involved**

- `server/integration-test/critical-flows.test.js`
- `server/package.json`
- new integration-test harness modules and domain test files

**Why valuable**

Domain-focused tests are easier to understand, review, run narrowly, and extend without weakening the strongest safety net in the project.

**Expected scope**

First extract a shared harness. Then split authentication/RBAC, migrations, catalog/pricing, products/recount, repricing, exports, and audit tests. Explicitly serialize files or provision isolated test databases.

**Risks/regressions**

- hidden test ordering or fixture dependencies;
- accidental cross-file destructive races;
- replacing a real concurrency test with sequential calls.

**Tests required**

All existing 77 cases must remain. Database-name validation must remain. Tests that intentionally race must continue to use independent clients/processes and assert final rows.

**Dependencies**

Prefer item 2 first.

### 4. Domain-specific server routers

**Classification:** 2 — Medium risk / structural

**What is wrong today**

`server/src/routes/admin.routes.js` combines unrelated domains and constructs correction/repricing CSVs inside HTTP handlers. `public.routes.js` is smaller but still mixes product, recount, history, timeline, and export transport concerns.

**Files/modules involved**

- `server/src/routes/admin.routes.js`
- `server/src/routes/public.routes.js`
- `server/src/app.js`
- `server/src/utils/csv.js`
- correction-history and repricing services

**Why valuable**

Smaller routers make permission reviews, error-contract reviews, and domain ownership substantially easier.

**Expected scope**

Introduce domain routers for users, roles, catalog, pricing, corrections/history, repricing, audit, products, and exports. Move CSV row/header construction into pure presenters. Preserve every current route, method, permission, status, header, and response shape, including legacy `/admin/delete-item` and `/admin/question/update` paths.

**Risks/regressions**

A route could lose or gain permission middleware, move outside the global CSRF boundary, or subtly change response headers/status.

**Tests required**

Create an endpoint manifest covering path, method, permission, authentication, active-user state, CSRF, response shape, CSV BOM/header order, and `Content-Disposition`.

**Dependencies**

Items 2 and preferably 5.

### 5. Explicit HTTP error contract

**Classification:** 2 — Medium risk / structural

**What is wrong today**

- `/price-preview` always maps calculation failures to 500.
- Decode and recount default to 400 while save defaults to 500.
- Modifier routes ignore an error's `statusCode`.
- Some handlers include `code` or `details`; others discard them.
- The global Express error handler returns arbitrary `error.message` text for unexpected 500 errors.

**Files/modules involved**

- `server/src/app.js`
- `server/src/routes/public.routes.js`
- `server/src/routes/admin.routes.js`
- service-specific error classes and validation paths
- client error handling in pages/hooks

**Why valuable**

Consistent typed errors improve security, observability, API stability, and client behavior.

**Expected scope**

Add typed public errors and one response serializer that preserves every established business status, code, details object, and message contract. Log unexpected failures privately. Migrate one router at a time.

**Risks/regressions**

Clients depend on stable auth, permission, stale-preview, and correction-claim responses. Changing existing 400/409/422/500 behavior can be breaking even if the new status appears cleaner.

**Tests required**

Characterize existing errors first, including auth/RBAC/CSRF, stale preview, claim conflict, audit cursor, validation, and injected database failures. Verify unexpected failures do not expose SQL details.

**Dependencies**

Item 2. Prefer this before large router/service moves.

### 6. Shared pure server primitives and presenters

**Classification:** 1 — Low risk / behavior-preserving

**What is wrong today**

`stableValue`, `valuesEqual`, and audit change-set construction are duplicated in catalog and pricing services. Object normalization, matrix-name fallbacks, stored-product pricing projection, and CSV presentation are also repeated.

**Files/modules involved**

- `server/src/services/catalog.service.js`
- `server/src/services/pricing.service.js`
- `server/src/services/product.service.js`
- `server/src/services/repricing.service.js`
- `server/src/services/correction-history.service.js`
- `server/src/services/product-timeline.service.js`
- route-local CSV builders

**Why valuable**

Small, domain-named pure modules reduce drift and make later extraction safer.

**Expected scope**

Introduce narrowly named modules such as audit change-set, stored-product pricing, and domain CSV presenters. Do not create a generic catch-all utility module.

**Risks/regressions**

JSON ordering, null versus undefined, legacy log-message parsing, fixed decimal serialization, and CSV bytes are behavior-sensitive.

**Tests required**

Table-driven equivalence fixtures, historical payload fixtures, and byte-for-byte CSV golden tests.

**Dependencies**

Item 2. CSV presenters support item 4.

### 7. Client API and shared UI boundaries

**Classification:** 1 — Low risk / behavior-preserving

**What is wrong today**

Direct Axios calls are scattered across pages and hooks. Error extraction, blob downloads, copy buttons, SKU transitions, field wrappers, section wrappers, and signed-currency formatting are duplicated.

**Files/modules involved**

- `client/src/lib/api.js`
- `client/src/pages/CorrectionHistoryPage.jsx`
- `client/src/pages/CorrectionRequestsPage.jsx`
- `client/src/pages/RepricingPage.jsx`
- `client/src/components/app/ProductTimeline.jsx`
- `client/src/components/admin/AdminPricingEditor.jsx`
- `client/src/components/admin/AdminStructureEditor.jsx`
- `client/src/hooks/useAdminPanel.js`
- `client/src/hooks/useSkuManager.js`
- `client/src/hooks/useProductRecount.js`

**Why valuable**

Domain API modules and shared presentational primitives shrink workflow files without changing server authority or adding a data-fetching dependency.

**Expected scope**

Retain the existing configured Axios client and its auth/CSRF interceptors. Add domain wrappers and shared error, download, copy, transition, and form-section components. Group props into domain view models where useful.

**Risks/regressions**

Losing interceptor behavior, response types, correction claim-token headers, blob handling, or stable error extraction.

**Tests required**

API-wrapper tests and rendered tests for errors, downloads, clipboard behavior, and permission-driven controls.

**Dependencies**

Item 2. This supports all client decomposition.

### 8. Product/SKU client workflow decomposition

**Classification:** 2 — Medium risk / structural

**What is wrong today**

`client/src/hooks/useSkuManager.js` handles configuration, product building, live price preview, save, variation, decode, recent history, archive, export, clipboard state, and recount integration. It returns roughly 70 values/actions. `AppPage.jsx` passes very large prop surfaces into `HomeDashboard.jsx` and `ProductBuilder.jsx`.

**Files/modules involved**

- `client/src/hooks/useSkuManager.js`
- `client/src/hooks/useProductRecount.js`
- `client/src/pages/AppPage.jsx`
- `client/src/components/app/HomeDashboard.jsx`
- `client/src/components/app/ProductBuilder.jsx`
- `client/src/components/app/ExportTools.jsx`
- `client/src/components/app/HistoryTable.jsx`
- recount dialogs and helpers

**Why valuable**

Separating builder, decode, recent-history/archive, export, and recount workflows will reduce state coupling and make each workflow independently testable.

**Expected scope**

Create scoped controller hooks/view models. Split Home Dashboard into decode and recount workspaces. Avoid introducing a global application context for unrelated workflow state.

**Risks/regressions**

Stale preview acceptance, lost latest-response protection, manual-price leakage, clearing meaningful zero values, and permission regressions.

**Tests required**

Rapid edits with reversed responses, debounce timers, preview invalidation, manual/automatic price resolution, variation, export confirmation, archive permission, and calibration values `0`, `1`, and `2`.

**Dependencies**

Items 2 and 7.

### 9. Admin client state and editor decomposition

**Classification:** 2 — Medium risk / structural

**What is wrong today**

`client/src/hooks/useAdminPanel.js` combines catalog, schema, and pricing state. It repeatedly reloads full configuration or pricing data after mutations and participates in a UI with many `alert()` and `confirm()` calls. The two main Admin editors duplicate form structure.

**Files/modules involved**

- `client/src/hooks/useAdminPanel.js`
- `client/src/pages/AdminPage.jsx`
- `client/src/components/admin/AdminPricingEditor.jsx`
- `client/src/components/admin/AdminStructureEditor.jsx`
- `client/src/components/admin/ConditionBuilder.jsx`
- Admin validation/pricing state helpers

**Why valuable**

Separate catalog/schema and pricing controllers will make permissions, loading, selected-resource state, and mutation effects easier to reason about.

**Expected scope**

Split controllers and shared field/section components. Replace browser alerts with the existing Notice/dialog conventions. Keep authoritative reloads initially. Optimize matrix-cell updates only after the API returns sufficient authoritative state.

**Risks/regressions**

Selected category/question state can become stale after rename or delete; publication could target the wrong category; optimistic UI could disagree with PostgreSQL; permission-limited users could issue unauthorized requests.

**Tests required**

Category/question/option CRUD, archive/unarchive, question ordering, schema publication, matrix clearing versus positive values, modifier/scenario edits, permission-limited access, and audit failure rollback.

**Dependencies**

Items 2 and 7. Stable server error contracts are helpful.

### 10. Explicit Repricing client workflow

**Classification:** 2 — Medium risk / structural

**What is wrong today**

`client/src/pages/RepricingPage.jsx` contains 32 independent `useState` calls and approximately 22 direct API calls. Its autosave effect suppresses exhaustive dependency checking, which makes closure freshness and request ordering difficult to verify.

**Files/modules involved**

- `client/src/pages/RepricingPage.jsx`
- `client/src/lib/repricing.js`
- `client/src/components/app/RepricingRecountDrawer.jsx`
- dialog/accessibility helpers
- future Repricing controller and presentational components

**Why valuable**

A reducer/controller will make preview, draft synchronization, manual/automatic resolution, apply, and rollback transitions explicit.

**Expected scope**

Extract the workflow state and side effects, then split filters, summary, table, confirmation, conflict, and batch-history views.

**Risks/regressions**

Autosave ordering, applying unsaved choices, stale preview tokens, incorrect counts, correction blockers, and loss of idempotent retry behavior.

**Tests required**

Fake-timer autosave, concurrent response ordering, draft conflicts, correction blockers, repeated manual-price cycles, global/scenario preview, idempotent apply, and rollback conflicts.

**Dependencies**

Items 2 and 7. Complete before changing the Repricing server.

### 11. Reporting query/loaders and historical normalization

**Classification:** 2 — Medium risk / structural

**What is wrong today**

`server/src/services/correction-history.service.js` combines several concurrent loads, legacy label reconstruction, summary building, and offset pagination. Offset pagination can duplicate or skip append-only rows when newer corrections arrive. CSV export materializes all matching rows.

`server/src/services/product-timeline.service.js` combines lineage SQL, schema reconstruction, audit joins, graph integrity analysis, historical fallbacks, and presentation in one 728-line module.

**Files/modules involved**

- `server/src/services/correction-history.service.js`
- `server/src/services/product-timeline.service.js`
- correction-history and timeline routes/pages
- CSV presenters

**Why valuable**

Separating SQL loaders, historical normalization, graph analysis, and DTO presentation improves readability and enables safer paging/performance work.

**Expected scope**

Extract pure normalizers and query modules. Add keyset pagination only as a compatible cursor extension. Measure export volume before considering streaming.

**Risks/regressions**

Historical labels must come from stored immutable schemas where possible. Current-configuration fallbacks and explicit missing-history gaps must remain visible. Pagination changes affect load-more behavior.

**Tests required**

Historical schema changes, missing audit records, ambiguous/cyclic/branched lineage, insert-during-pagination, filter stability, and CSV golden files.

**Dependencies**

Items 2, 5, and 6.

### 12. Pricing calculation and administration separation

**Classification:** 3 — High risk / business-critical

**What is wrong today**

`server/src/services/pricing.service.js` combines pricing-context loading and calculation with scenario, weight-band, matrix, and modifier CRUD, audit writing, and transaction management.

`loadPricingContext()` uses several separate queries. When invoked through the pool, concurrent catalog/pricing edits can theoretically produce a mixed read that did not exist as one committed configuration snapshot.

**Files/modules involved**

- `server/src/services/pricing.service.js`
- pricing utilities under `server/src/utils/`
- `server/src/services/currency.service.js`
- product and repricing services that depend on pricing
- Admin pricing routes and tests

**Why valuable**

A pure calculator, coherent context loader, read model, and separate Admin command modules clarify one of the most reused business boundaries.

**Expected scope**

Extract without changing fixed/per-gram modes, modifier precedence, scenario ordering, positive-or-absent matrix behavior, automatic rounding, or legacy zero compatibility. If read coherence is changed, use one client and a clearly defined snapshot boundary.

**Risks/regressions**

Pricing feeds product creation, recount, and repricing. Small changes to null, zero, calibration, currency, or rounding behavior can corrupt stored history.

**Tests required**

All existing pricing tests plus cross-layer fixtures, missing/zero/manual cases, contextual rules, weight bands, NBU stale/fallback behavior, and a real concurrent configuration-edit snapshot test.

**Dependencies**

Items 2, 3, 5, and 6. Complete before product or repricing service extraction.

### 13. Product decode/preview and transactional command separation

**Classification:** 3 — High risk / business-critical

**What is wrong today**

`server/src/services/product.service.js` covers decode, variation, preview, recount preview/apply, save, archive, recent history, SKU locks, pricing, audit, and compatibility fallbacks.

**Files/modules involved**

- `server/src/services/product.service.js`
- `server/src/services/sku-schema.service.js`
- SKU, rule, calibration, answer-change, and money utilities
- public product/recount routes
- correction-request and export services that depend on product functions

**Why valuable**

Extracting read and pure transformation concerns will make the critical save/recount coordinators shorter without weakening them.

**Expected scope**

Extract query/read modules and pure decode, answer normalization, validation, state-signature, and preview-token modules. Keep `saveProduct()` and `applyProductRecount()` intact as orchestration units initially.

**Risks/regressions**

Historical schemas, separator variants, suffix parsing, permanent uniqueness, target-based recount cleanup, state signatures, audit atomicity, and legacy zero-price products.

**Tests required**

All SKU variants and markers, contextual labels, hidden placeholders, calibration `2`, authoritative save repricing, parallel sequence races, concurrent recount, audit failure rollback, and final database state.

**Dependencies**

Item 12 and the safety-net work.

### 14. Repricing separation without transaction fragmentation

**Classification:** 3 — High risk / business-critical

**What is wrong today**

`server/src/services/repricing.service.js` contains many extractable pure transformations as well as the large `applyRepricingScope()` and `rollbackRepricing()` transaction coordinators.

**Files/modules involved**

- `server/src/services/repricing.service.js`
- pricing and correction-request services
- Repricing routes, CSV output, and tests

**Why valuable**

Pricing-state projection, hashing/tokens, draft serialization, resolution logic, preview read models, and batch reporting can be tested independently while leaving the financial transaction explicit.

**Expected scope**

Extract pure/read-model modules. Keep apply/rollback lock order, product update loop, batch/item insertion, audit event, idempotency paths, and commit/rollback in one transaction coordinator.

**Risks/regressions**

Stale-token rejection, batch idempotency, draft state, manual resolutions, blocking corrections, full rollback, and immutable old/new payloads.

**Tests required**

Existing scenario/global tests, mid-apply injected failures, simultaneous apply, correction races, duplicate retries, manual-price cycles, rollback mismatch, attribution/audit, and final database state.

**Dependencies**

Items 10 and 12.

### 15. Catalog mutation and question-key rewrite isolation

**Classification:** 3 — High risk / business-critical

**What is wrong today**

`server/src/services/catalog.service.js` rewrites question and option rules, scenario axes and matches, modifier rules and legacy triggers, and product JSON when a question key changes. Its private `renameRuleKey()` helper constructs SQL identifiers dynamically. Current callers pass fixed values, but the helper does not itself enforce an allowlist.

The same service also handles configuration reads, all catalog CRUD, archiving, auditing, category changes, ordering, and multiplexed deletion.

**Files/modules involved**

- `server/src/services/catalog.service.js`
- `server/src/services/sku-schema.service.js`
- `server/src/services/pricing.service.js`
- catalog/pricing routes and Admin client
- product JSON and published SKU schema tables

**Why valuable**

Separating reads and resource-specific commands clarifies mutation scope. Replacing generic identifier interpolation with static statements or a strict allowlist directly supports the SQL guardrail.

**Expected scope**

Split config reads from commands. Split deletion by type behind the existing compatibility endpoint. Do not change the behavior of key/category renames or published snapshots.

**Risks/regressions**

This path can rewrite stored product payloads and live pricing rules. Published schemas must remain immutable, used semantic values must not be reinterpreted, and failures must roll back every related write.

**Tests required**

Nested `$and`/`$or` key rewriting, question/option visibility rules, combo axes, modifier legacy triggers, product JSON, published snapshots unchanged, used option-value rejection, audit failure rollback, and real duplicate-question races.

**Dependencies**

Items 2, 3, 5, 6, and preferably 12.

### 16. Explicit PostgreSQL access intent and evidence-based tuning

**Classification:** 2 initially; 3 for schema or transaction-semantic changes

**What is wrong today**

SQL and direct pool use are spread through services. Some list/summary pairs can observe slightly different committed states. Correction history uses offset pagination and broad JSON/filter expressions. History and export CSV generation is memory-bound.

No production-like query plan or volume measurement was available during this source audit, so these are risks rather than proven bottlenecks.

**Files/modules involved**

- service modules under `server/src/services/`
- `server/src/db/pool.js`
- correction history, audit viewer, product timeline, pricing context, export, and repricing queries
- future forward migrations only if measurement proves an index requirement

**Why valuable**

Domain query modules and consistent `queryable` arguments make transaction ownership visible. Bounded timing and representative query plans allow actual bottlenecks to be addressed without speculative schema changes.

**Expected scope**

Add domain query modules and query timing first. Run representative `EXPLAIN (ANALYZE, BUFFERS)` against sanitized production-like volumes. Consolidate queries only when measurement or consistency requires it.

**Risks/regressions**

A broad repository abstraction or generic transaction wrapper can hide lock ordering and idempotent paths. Every new index requires a new forward migration and upgrade/fresh/repeated-startup verification.

**Tests required**

Query-result equivalence, pagination under concurrent inserts, connection release on failures, real independent-client races, and performance budgets on representative data.

**Dependencies**

Read-model and service partitions. Do not create an index migration without evidence.

### 17. CI, development, and container boundaries

**Classification:** 1 for additive CI/tooling; 2 for container/runtime changes

**What is wrong today**

`.github/workflows/ci.yml` runs the essential tests but has no server lint/static check, Compose validation, coverage visibility, or container smoke build. Node 20 is used by CI and Docker but is not declared in package metadata. Docker images use broad defaults and mutable tags, and the base Compose file publishes PostgreSQL on all host interfaces.

**Files/modules involved**

- `.github/workflows/ci.yml`
- `server/package.json`
- `client/package.json`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `server/Dockerfile`
- `client/Dockerfile`
- `client/nginx.conf`
- `.dockerignore` files

**Why valuable**

Early static feedback and reproducible build checks reduce refactor risk. Container hardening can reduce operational exposure once compatibility is established.

**Expected scope**

- add a scoped server lint/check step that excludes frozen migrations;
- declare Node 20 compatibility;
- add Compose validation and path-filtered Docker build/smoke tests;
- add non-blocking coverage reporting before any threshold;
- evaluate SHA/digest pinning and controlled dependency-update automation;
- separately assess non-root/read-only operation and whether host PostgreSQL exposure is required.

**Risks/regressions**

Server lint can trigger an unreviewable formatting rewrite. Container hardening can break nginx temporary paths, administrative scripts, backup workflows, or database access.

**Tests required**

The full baseline plus Compose validation, image builds, healthy startup, public health/auth checks, JSON 401 behavior, callback log redaction, SIGTERM shutdown, and disposable backup/restore exercises where relevant.

**Dependencies**

Additive lint/CI work can occur early. Runtime hardening requires operational clarification.

### 18. Removal of proven dead scaffolding

**Classification:** 1 — Low risk / behavior-preserving

**What is wrong today**

- `client/src/App.css` and `client/src/assets/react.svg` are unused starter assets.
- `client/public/vite.svg` is still used as the favicon but is Vite branding rather than product branding.
- `recordExportEvent()` in `server/src/services/export.service.js` and the `initDb()` alias in `server/src/db/init-db.js` have no repository callers.

**Files/modules involved**

- `client/src/App.css`
- `client/src/assets/react.svg`
- `client/public/vite.svg`
- `client/index.html`
- `server/src/services/export.service.js`
- `server/src/db/init-db.js`

**Why valuable**

Removing verified scaffolding reduces false entry points and maintenance noise.

**Expected scope**

Remove unused assets/exports only after checking for external consumers. Replace the favicon only with an approved brand asset.

**Risks/regressions**

Operational scripts outside this repository may import an otherwise unreferenced export. The `export_events` table is not dead; it remains part of legacy status compatibility.

**Tests required**

Repository and external-consumer search, client build, export-status compatibility, and startup tests.

**Dependencies**

Consumer clarification. Do not include `legacyInitDb()` or `uncalibratedPrices` in automatic cleanup.

## Performance and unnecessary-work assessment

No production profiling data was available, so no current query should be called a proven bottleneck solely from this audit.

Potentially unnecessary or scale-sensitive work includes:

- Admin mutations frequently reloading all catalog or category pricing data;
- correction-request polling retrieving both item and global summary queries each time;
- correction-history requests running item, summary, category, and full configuration loads;
- offset pagination in append-only correction history;
- correction-history and export CSV generation materializing entire result sets in memory;
- pricing context loading requiring multiple queries per category;
- global repricing loading a context for every category, although it correctly reuses each context across products and fetches a single currency rate;
- global CSS organization making visual changes expensive to verify, despite acceptable transferred size.

Important existing optimizations should be retained:

- Repricing reuses loaded pricing contexts rather than performing per-product pricing queries.
- Audit viewer pagination is keyset-based.
- Correction polling is visibility-aware, non-overlapping, and protected against stale responses.
- Product live pricing is debounced and ignores results after effect cleanup.
- NBU fetching has timeout, size, retry, in-flight deduplication, and last-known-good behavior.
- Product timeline uses batched queries rather than a per-event N+1 loop.

## Things that must not be refactored away

- Never edit, rename, reorder, replace, or mechanically reformat migrations `000`–`028`.
- Do not replace raw PostgreSQL with an ORM or broad repository abstraction.
- Do not place all transactions behind one generic helper. Critical flows have intentional early commits, idempotent conflict handling, advisory locks, row locks, and rollback behavior.
- Do not split product save, product recount, repricing apply/rollback, SKU schema publication, export confirmation, or access administration into separately committed operations.
- Do not change lock ordering or replace real concurrency tests with sequential mocks.
- Do not cache application-user status or effective permissions across business requests.
- Do not move permission enforcement into React or treat route hiding as authorization.
- Do not share one executable pricing/SKU engine between browser and server. Cross-layer fixtures are useful; server authority must remain independent.
- Do not boolean-normalize calibration state `2`.
- Do not collapse null, zero, calculated, automatic, manual, and final price meanings.
- Do not release or reuse archived/corrected SKU reservations.
- Do not remove historical schema markers, legacy separators, archived historical options, placeholder decoding, or contextual semantic values.
- Do not remove legacy correction claim-token adoption while legacy token-owned records can exist.
- Do not remove legacy export status reads or the informative disabled `/export/csv` 410 route without a compatibility decision.
- Do not remove legacy endpoint aliases until external and operational clients are known.
- Do not remove `legacyInitDb()`. It is used by migration-upgrade topology tests and documented as compatibility/test infrastructure.
- Do not remove `uncalibratedPrices` merely because the current seed does not consume it; its business intent requires clarification.
- Do not optimize away the audit actor lookup by trusting browser identity or mutable/stale profile data.
- Do not rewrite the visibility-aware correction poller or latest-response gates without equivalent race tests.
- Do not add speculative indexes. Existing migrations already define focused indexes for SKU, correction, repricing, audit, session, export queue, and RBAC paths.

## Ordered phased roadmap

### Phase 0 — Baseline reference

**Status:** Completed for the audited revision.

Preserve the audit commit and green verification results as the comparison point. Confirm the intended implementation branch before beginning changes.

### Phase 1 — Documentation truth and behavioral safety net

This is the recommended first implementation phase and must not change production behavior.

1. Correct the stale branch, audit-viewer, audit-coverage, actor-logging, and developer documentation.
2. Add HTTP contract tests for authentication, active-user state, CSRF, permissions, and representative business errors.
3. Add rendered client tests for Repricing autosave/staleness, SKU live-preview ordering, Admin edits, and correction polling.
4. Add PostgreSQL integration tests for complete question-key rewriting and used option semantic-value protection.
5. Extract the integration test harness, but defer splitting test files until serialization or isolation is explicit.

### Phase 2 — Test and tooling structure

1. Split the integration suite by domain with explicit safe execution semantics.
2. Add scoped server lint/static checks without reformatting frozen migrations.
3. Add non-blocking coverage visibility.
4. Add Compose validation to CI.

### Phase 3 — Transport and common seams

1. Extract shared server change-set and CSV/presentation helpers.
2. Establish the typed HTTP error serializer with characterized compatibility.
3. Split Admin and public routers by domain while retaining all endpoints and permissions.
4. Add client domain API modules and shared UI primitives.
5. Remove only proven starter scaffolding in a separate small change.

### Phase 4A — Admin client

Split catalog/schema and pricing controllers, then break the large editors into focused views. Preserve authoritative server reloads until mutation responses are proven sufficient for safe local reconciliation.

### Phase 4B — Product/SKU client

Split builder, decode, recount, recent-history/archive, and export workflows. Preserve debounce, response-generation gates, manual pricing, and permission behavior.

### Phase 4C — Repricing client

Introduce an explicit reducer/controller and split Repricing presentation. Preserve autosave, stale-token, conflict, correction-blocker, apply, and rollback semantics.

### Phase 5 — Historical read models

Split correction history, product timeline, and reporting loaders from normalization and presentation. Add compatible keyset pagination only after contract and concurrent-insert tests exist.

### Phase 6A — Pricing core

Separate the pure pricing calculator, coherent context loader, read model, and Admin commands. This phase is the dependency for product and repricing service work.

### Phase 6B — Product core

Extract decode, normalization, validation, state-signature, preview-token, and query modules. Keep save and recount transaction coordinators intact.

### Phase 6C — Repricing core

Extract pure pricing-state, token, draft, preview, and reporting modules. Keep apply and rollback atomic and explicit.

### Phase 6D — Catalog core

Split reads and resource commands, constrain dynamic SQL identifiers, and isolate question-key reference rewriting. Preserve all historical and schema invariants.

### Phase 7 — Measured performance work

Add bounded query timing, gather production-like query plans and volumes, then address only demonstrated problems. Any index or schema adjustment requires the next forward migration and the full migration verification matrix.

### Phase 8 — Operational hardening

Add path-filtered container build/smoke coverage and evaluate image pinning, non-root/read-only operation, build-context minimization, and PostgreSQL port exposure. Treat runtime/network changes separately from source refactors.

## Relative effort and risk by phase

| Phase | Contents | Relative effort | Risk |
| --- | --- | --- | --- |
| 0 | Baseline reference | Small; completed | Low |
| 1 | Documentation, HTTP contracts, rendered workflows, missing catalog regressions | Medium | Low |
| 2 | Integration harness/split, scoped server lint, coverage visibility | Medium | Low–Medium |
| 3 | Domain routers, error serializer, presenters, client API/UI helpers | Medium | Medium |
| 4A | Admin client decomposition | Medium–Large | Medium |
| 4B | Product/SKU client decomposition | Large | Medium |
| 4C | Repricing client decomposition | Large | Medium |
| 5 | Correction history, timeline, and reporting read models | Medium | Medium |
| 6A | Pricing core separation | Large | High |
| 6B | Product core separation | Large | High |
| 6C | Repricing core separation | Large–Very large | High |
| 6D | Catalog command/reference-rewrite separation | Large | High |
| 7 | Measured query, pagination, and proven index work | Medium–Large | Medium–High |
| 8 | Container and operational hardening | Medium | Medium |

Phases 4A–4C and 6A–6D should each be implemented as independent, reviewable changes rather than combined pull requests.

## Top 10 highest-value refactors

1. Replace source-text client regressions with rendered workflow tests.
2. Add catalog key-rewrite and used-semantic-value PostgreSQL regressions.
3. Split `admin.routes.js` into permission-preserving domain routers.
4. Establish a stable, non-leaking HTTP error contract.
5. Decompose `RepricingPage` into an explicit tested workflow.
6. Split `useSkuManager` and `HomeDashboard` into builder, decode, recount, history, and export boundaries.
7. Split `useAdminPanel` into catalog/schema and pricing controllers.
8. Separate the pure pricing engine and coherent context loader from pricing administration.
9. Extract product decode/preview primitives while preserving save/recount transactions.
10. Extract Repricing pure/read-model modules while keeping apply/rollback atomic.

## Open questions requiring clarification

1. Is commit `b5617ace75b2617a3454768341bc6a6182e5ab3e`, currently on `refactor/codebase-cleanup` and local `main`, the exact deployed baseline for implementation?
2. Are any clients or operational scripts outside this repository using `/admin/question/update`, `/admin/delete-item`, `/export/csv`, `recordExportEvent`, or `initDb`?
3. Is `data_config.js`'s unused `uncalibratedPrices` section reserved for a future pricing policy, or can it eventually be retired?
4. What are the expected upper bounds for products, correction-history rows, audit events, and export CSV size? These determine whether keyset pagination, streaming, or new indexes are worthwhile.
5. Is direct host access to production PostgreSQL required for backup/administration, or can Compose exposure be removed or loopback-restricted?
6. Are the current Ukrainian/English API error messages a stable external contract, or are only HTTP statuses and machine-readable codes stable?
