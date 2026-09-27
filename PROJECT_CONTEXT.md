# Amber SKU Manager: project context

Amber SKU Manager is an internal application for catalog configuration, authoritative SKU and price generation, inventory history, recount/corrections, controlled repricing, and immutable product and price CSV exports. Start here, then use the [documentation index](docs/README.md) for each maintained domain contract. Code and migrations define implementation; deployment and external-system facts require operational evidence.

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
| [Export templates](docs/EXPORT_TEMPLATES.md) | Revisioned drafts, immutable publications, editable columns, source validation and signed published-preview binding. Explicit `template-v1` requests use publications; omitted discriminator uses the system mapper. No automatic template seeding/publication. |
| [Shared export sessions](docs/SHARED_EXPORT_SESSIONS.md) | Durable private/shared template workspaces, explicit local-user invitations, membership epochs and recovery of the original attempt/result after reload. Invitations grant no global permissions. |

Business mutations preserve their transaction, lock-order, stale-evidence, idempotency and audit boundaries. Historical plans are not current behavior contracts.

## Implementation and deployment status

The repository includes migrations **000–041** and the full-product lifecycle/cutover implementation through **Phase 3B / Phase 4**: lifecycle state, exact membership, recount/request parity, information/name revisions, historical indexing, manifest approval, bounded batches, activation gate, typed exclusions, reconciliation and lifecycle queues. Magento Phase 1B.2a supplies the [persistent binding foundation](docs/MAGENTO_INTEGRATION.md#phase-1b2a-persistent-binding-foundation). Phase 1B.2b adds CLI bootstrap/review using that model and GET-only product sync previews with separate operation sendability. A separate `magento:category` CLI supports one explicitly applied KL inclusion category creation; the separate durable `magento:sync` worker requires a current published binding and explicit `--apply` for product/domain writes. Admin UI/API remain unimplemented.

**Production cutover has not been performed**, as reported for this documentation handoff. Installing migrations alone does not activate selection. The one-time transition requires maintenance/freeze, draining old writers, fresh production indexing and post-index cutover manifests, explicit approval, batches, validation and activation. Later reconciliations/attestations remain separate operator decisions. Follow the [cutover runbook](docs/FULL_PRODUCT_CUTOVER_RUNBOOK.md).

A fresh local rehearsal restored from the current production backup completed through activation with 4,978 products. Its reported counts and limits are recorded as **rehearsal evidence** in the runbook; they are not production expectations. Historical duplicate-SKU/data-quality cases remain separate unresolved work. This documentation task did not connect to production or execute a cutover.

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
