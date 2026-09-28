# Amber SKU Manager: project context

Amber SKU Manager is an internal application for catalog configuration, authoritative SKU and price generation, inventory history, recount/corrections, controlled repricing, direct Magento synchronization, and immutable product and price CSV exports. Start here, then use the [documentation index](docs/README.md) for each maintained domain contract. Code and migrations define implementation; deployment and external-system facts require operational evidence.

## Architecture

- React 19/Vite presents workflows and effective permissions. It is not a business or security authority.
- Node 20/CommonJS Express 5 owns authentication, authorization, validation, SKU allocation, pricing, workflow transactions and CSV capture.
- PostgreSQL 16 stores catalog configuration, immutable SKU schemas, permanently reserved identifiers, products, sessions/RBAC, audit events, workflow state and immutable export evidence.
- Docker Compose runs PostgreSQL, the server and an nginx client serving the SPA and proxying `/api/`. Startup verifies/applies migrations before catalog compatibility initialization and listening; preparation mode skips seed/schema writes.

Server-owned OIDC Authorization Code with PKCE resolves immutable `issuer` + `sub` links to local application users. Opaque PostgreSQL sessions, active-user checks, current effective permissions and synchronizer-token CSRF protect business routes. Administrator is immutable; Manager, Storekeeper and custom roles are editable. Actor fields use local user IDs. See [authentication and RBAC](docs/AUTH_RBAC.md).

## Business domains

| Domain | Current behavior and authoritative guide |
| --- | --- |
| [SKU and catalog](docs/SKU_CATALOG.md) | Server preview/save/decode, immutable published schema versions, semantic option IDs, permanent SKU reservation and distinct calibration states `0`, `1`, `2`. |
| [Pricing](docs/PRICING.md) | Positive-or-absent matrices, scenario/modifier rules, exchange-rate evidence, separate calculated/automatic/manual values and legacy zero-price compatibility. |
| [Recount and corrections](docs/RECOUNT_CORRECTIONS.md) | Target-schema validation, source retirement, successor identity/delivery routing, inherited UA/EN names/review, direct/request parity and local-user claims. Narrow information and price changes preserve identity. |
| [Repricing](docs/REPRICING.md) | Scenario/global drafts, reviewed authoritative previews, atomic apply and exact-state rollback. |
| [Exports](docs/EXPORTS.md) | Immutable snapshots/artifacts, exact membership, revision acknowledgment, New/Update/Replacement/Held selection after activation, and a separate `sku,price` stream. Confirmation is local acknowledgment, not proof of Magento import. |
| [Magento integration](docs/MAGENTO_INTEGRATION.md) | Persistent published bindings, category creation/binding, GET-only previews and durable jobs with read-after-write acknowledgement. Automatic mutation requests/worker/status are implemented behind a default-disabled gate; final production activation and CSV retirement remain pending. |
| [Export templates](docs/EXPORT_TEMPLATES.md) | Revisioned drafts, immutable publications, editable columns, source validation and signed published-preview binding. Explicit `template-v1` requests use publications; omitted discriminator uses the system mapper. No automatic template seeding/publication. |
| [Shared export sessions](docs/SHARED_EXPORT_SESSIONS.md) | Durable private/shared template workspaces, explicit local-user invitations, membership epochs and recovery of the original attempt/result after reload. Invitations grant no global permissions. |

Business mutations preserve their transaction, lock-order, stale-evidence, idempotency and audit boundaries. Historical plans are not current behavior contracts.

## Implementation and deployment status

Migration **044** adds [automatic Magento synchronization](docs/MAGENTO_AUTOMATIC_SYNC.md):
transactional product requests, generation-aware acknowledgement, a bounded worker
and safe product-history status. Its durable gate defaults disabled. No automatic
activation, real Magento write or CSV cutover is part of this implementation.
The operator reports successful installation-wide publication and manual APPLY on
KL/BR/NM/CH/AR in the restored dump; the final frozen production database must have
its own verified current publication. Historical receipts below are not defaults.

The repository includes migrations **000–044** and the full-product lifecycle/cutover implementation through **Phase 3B / Phase 4**. Migration **041** supplies persistent versioned Magento bindings; **042** supplies immutable sync intent and durable dispatch/verification evidence. Both are installed in the local operator database. Forward migration **043** supports literal numeric Amber question keys in Magento binding identities without rewriting existing bindings; it is installed in the current office operator database. Binding bootstrap/review, category creation/binding, complete sync previews and explicit CLI APPLY are implemented. Migration 044 adds the disabled automatic workflow; its installation in the restored operator database is not asserted here.

On **2026-09-28 (Europe/Kiev)**, the first direct Amber → Magento synchronization **without CSV** succeeded for `KL3/11131351005`, job `f2253960-527a-40e9-b879-9041bb036453`, Magento product `5509`. The first published binding is `4d563554-bfe3-4d01-9df5-225aa5b61d48`, installation `amber`, version **1**, counter **37** (published from counter 36). All three operations, **coreProduct → categories → storeViews**, were verified before acknowledgement at `2026-09-27T23:50:46.739Z`. The [integration guide](docs/MAGENTO_INTEGRATION.md#achieved-state-2026-09-28) records the receipt, policies and bounded remaining-group review. This is one verified real UPDATE, not acceptance of every route or CREATE.

Current approved KL ownership sends Amber-managed core fields and produced EN fields, preserves descriptions/media/unmanaged fields, creates products with disabled status `2`, and preserves status and inventory on UPDATE. Websites are additive; EN is scoped separately. Category `649 / Default/Кулони/З інклюзом` was explicitly created and bound before sync. Acknowledgement requires fresh read-after-write verification of intended and preserved state.

Legacy CSV export is **planned for retirement**, not disabled. Existing queued product/price work, captured/downloaded exports, unconfirmed deliveries and held/replacement cases must be reconciled before export cutover; direct sync does not advance their acknowledgement ledgers or cursor. Final production publication and automatic activation require the frozen database and explicit cutover review; retain CH's Amber dimension semantics and keep AR gaps/SV route decisions fail-closed.

**The production CSV lifecycle cutover remains unconfirmed** in the retained handoff evidence; the successful direct Magento sync does not establish selector activation or CSV retirement. Installing migrations alone does not activate selection. The one-time transition requires maintenance/freeze, draining old writers, fresh production indexing and post-index cutover manifests, explicit approval, batches, validation and activation. Later reconciliations/attestations remain separate operator decisions. Follow the [cutover runbook](docs/FULL_PRODUCT_CUTOVER_RUNBOOK.md).

A local rehearsal restored from a production backup completed through activation with 4,978 products. Its reported counts and limits are recorded as **rehearsal evidence** in the runbook; they are not production expectations. Historical duplicate-SKU/data-quality cases remain separate unresolved work. The final 2026-09-28 review used read-only database queries and live Magento GETs; it did not execute a cutover or another sync.

## Repository and verification

| Path | Responsibility |
| --- | --- |
| `server/server.js`, `server/src/app.js` | Startup, middleware, health, request logging and graceful shutdown. |
| `server/src/auth/`, `server/src/audit/` | Authentication/access boundaries and transaction-coupled audit. |
| `server/src/routes/public/`, `server/src/routes/admin/` | Authenticated domain APIs; the historical name `public` does not mean unauthenticated. |
| `server/src/services/`, `server/src/utils/`, `server/src/presenters/` | Authoritative domain logic, helpers and response/CSV presentation. |
| `server/src/db/`, `server/migrations/` | Pool, migration runner and startup compatibility. |
| `server/scripts/`, `scripts/` | Offline administration, cutover/evidence commands, integrity audit, optional configuration import and backup/restore. |
| `client/src/` | AuthGate, permission-aware pages, workflow controllers and presentation. |
| `server/test/`, `server/integration-test/`, `client/test/` | Unit, serialized destructive PostgreSQL and client/rendered regressions. |
| `docker-compose*.yml`, `*/Dockerfile`, `.github/workflows/` | Runtime/container wiring and CI. |

Use the [root quickstart](README.md), [engineering requirements](AGENTS.md), [migration guide](docs/DATABASE_MIGRATIONS.md) and [operations](docs/OPERATIONS.md). CI uses Node 20/PostgreSQL 16 and checks Compose, server lint/unit/integration, and client tests/lint/build. Windows integration tests use only the canonical disposable `postgres-test`; failure is not permission to try another database.

Current deferrals and pending acceptance are listed in the [index](docs/README.md#deferred-work-and-operationally-pending-items). Completed plans, investigations and audits live in the [archive](docs/archive/README.md).
