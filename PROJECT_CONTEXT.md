# Amber SKU Manager: project context

Amber SKU Manager is an internal application for catalog configuration, authoritative SKU and price generation, inventory history, recount/corrections, controlled repricing, direct Magento synchronization, and immutable historical product exports plus a separate price CSV stream. Start here, then use the [documentation index](docs/README.md) for each maintained domain contract. Code and migrations define implementation; deployment and external-system facts require operational evidence.

## Architecture

- React 19/Vite presents workflows and effective permissions. It is not a business or security authority.
- Node 20/CommonJS Express 5 owns authentication, authorization, validation, SKU allocation, pricing, workflow transactions and CSV capture.
- PostgreSQL 16 stores catalog configuration, immutable SKU schemas, permanently reserved identifiers, products, sessions/RBAC, audit events, workflow state and immutable export evidence.
- Docker Compose runs PostgreSQL, the server and an nginx client serving the SPA and proxying `/api/`. Startup verifies/applies migrations before catalog compatibility initialization and listening; preparation mode skips seed/schema writes.

Server-owned OIDC Authorization Code with PKCE resolves immutable `issuer` + `sub` links to local application users. Opaque PostgreSQL sessions, active-user checks, current effective permissions and synchronizer-token CSRF protect business routes. Administrator is immutable; Manager, Storekeeper and custom roles are editable. Actor fields use local user IDs. See [authentication and RBAC](docs/AUTH_RBAC.md).

## Business domains

| Domain | Current behavior and authoritative guide |
| --- | --- |
| [SKU and catalog](docs/SKU_CATALOG.md) | Server preview/save/decode, immutable published schema versions, semantic option IDs, permanent internal-SKU reservation, and a separate immutable stable public product identity active in production (the fresh-install activation gate remains default-off). |
| [Pricing](docs/PRICING.md) | Positive-or-absent matrices, scenario/modifier rules, exchange-rate evidence, separate calculated/automatic/manual values and legacy zero-price compatibility. |
| [Recount and corrections](docs/RECOUNT_CORRECTIONS.md) | Target-schema validation, source retirement, successor identity/delivery routing, three-way exact UA/EN shared names, direct/request parity and local-user claims. Narrow information and price changes preserve identity. |
| [Repricing](docs/REPRICING.md) | Scenario/global drafts, reviewed authoritative previews, atomic apply and exact-state rollback. |
| [Exports](docs/EXPORTS.md) | Immutable snapshots/artifacts, exact membership, revision acknowledgment, New/Update/Replacement/Held selection after activation, and a separate `sku,price` stream. Confirmation is local acknowledgment, not proof of Magento import. |
| [Magento integration](docs/MAGENTO_INTEGRATION.md) | Persistent published bindings, category creation/binding, GET-only previews and durable jobs with read-after-write acknowledgement. Automatic requests/worker/status and shared-name discovery are active in production; fresh installations retain default-disabled gates. |
| [Export templates](docs/EXPORT_TEMPLATES.md) | Revisioned drafts, immutable publications, editable columns, source validation and signed published-preview binding. Explicit `template-v1` requests use publications; omitted discriminator uses the system mapper. No automatic template seeding/publication. |
| [Shared export sessions](docs/SHARED_EXPORT_SESSIONS.md) | Durable private/shared template workspaces, explicit local-user invitations, membership epochs and recovery of the original attempt/result after reload. Invitations grant no global permissions. |

Business mutations preserve their transaction, lock-order, stale-evidence, idempotency and audit boundaries. Historical plans are not current behavior contracts.

## Implementation and deployment status

As reported by the production operator on 2026-10-01, Wave 1 is deployed at PR #19 / `daf627fc2458e5215cbf52735a8f186a3777361f`, with migrations through `050_test_product_deletion.sql`. Stable public `AG-*` identities, the reviewed production binding and automatic Amber → Magento synchronization are active. Magento product CSV delivery is retired; the separate price-export stream and immutable historical evidence remain supported. Historical delivery/collision cutover is complete and the operational freeze has been lifted. This documentation update did not query production or Magento.

Production acceptance includes a real Magento CREATE and the dedicated safe test-product deletion workflow: `AG-000002` was deleted remotely and retained as `voided` in Amber. The reported synchronization-problem count was zero; the public sequence was 2 (next allocation `AG-000003`). These are dated operator receipts, not seeds, defaults or current telemetry. Earlier 2026-09-28 UPDATE and disposable-rehearsal records remain historical evidence in the linked domain guides.

The repository includes forward migration **051** for the opt-in [v4 integration contract](docs/EXPORT_TEMPLATES.md#extensible-v4-integration-contract), H1 bounded readiness/discovery/product previews and H2 reviewed category creation with permanent dispatch/read-verification evidence in migration **052**. These changes are not production activation or successor publication. Evaluator 1–3, published definitions/bindings, current selection and durable Magento jobs are unchanged. H4 reviewed option creation adds action-specific Administrator attestations in migration **053**. H3 successor publication/handoff remain later Wave 2 phases.

Fresh installations still require explicit reviewed activation, publication and cutover. Migration installation alone never allocates public identities, confirms old delivery, enrolls existing products, publishes a binding or calls Magento. Follow the [cutover runbook](docs/FULL_PRODUCT_CUTOVER_RUNBOOK.md) only for installations that have not completed it; ordinary deployments follow [Operations](docs/OPERATIONS.md).

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
