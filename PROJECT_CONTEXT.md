# Amber SKU Manager: project context

## Purpose

Amber SKU Manager is an internal application for defining amber-product classifications, generating authoritative SKUs and prices, saving and decoding inventory records, recounting/correcting products, controlled mass repricing, and immutable CSV exports.

This document summarizes the current `feature/auth-rbac` checkout. Runtime PostgreSQL data and the current code/migrations remain authoritative. Detailed invariants live in the linked domain documents.

## Current architecture

The application is a three-tier system:

1. React 19/Vite single-page client calling JSON and CSV endpoints under `/api`.
2. Node 20/CommonJS Express 5 server owning all authentication boundaries and business decisions.
3. PostgreSQL 16 storing catalog configuration, immutable SKU schemas, products, sessions/RBAC, workflows, exchange-rate cache data, and export snapshots.

In Docker, nginx serves the client, provides SPA fallback, and proxies `/api/` to the server. Startup runs migrations, seeds only an empty catalog, captures missing legacy V1 schemas, and begins listening only after those phases complete. The client is never a trust boundary.

## Authentication and RBAC state

Server-owned Keycloak OIDC Authorization Code flow with PKCE, state, and nonce is implemented. Sessions are opaque, PostgreSQL-backed, fixed/non-rolling, and exposed through a host-only `HttpOnly` `amber.sid` cookie. OIDC tokens and the client secret remain server-side.

Local application users and exact immutable `issuer` + `sub` identity links are implemented. Users move through `pending`, `active`, and `disabled` states. Every business request resolves current local status, roles, and permissions from PostgreSQL, so disablement and role revocation affect existing sessions immediately.

Stable capability keys guard every business endpoint after authentication, active-user resolution, and method-aware CSRF enforcement. `/api/auth/me` returns safe identity/user data, roles, effective permission keys, and the in-memory synchronizer CSRF token. React navigation and controls use only those effective keys; server-side `403` enforcement remains authoritative.

The three built-in roles are Administrator, Manager, and Storekeeper. Administrator has full access and `users.manage`; Manager has read-only pricing, repricing preparation, and correction view/create/reject without claim/complete/force-release; Storekeeper retains product create/archive/direct recount and correction claim/complete processing without catalog/pricing or final administrative actions. All three can view existing exports; export creation/confirmation is Administrator-only.

Administrators can approve pending users with exactly one built-in role, replace an assigned role while retaining assignment history, disable, and re-enable users. The one-use offline first-Administrator bootstrap and concurrency-safe last-Administrator protection are implemented. Custom roles, invitations, actor attribution/audit events, and user-owned correction claims remain pending. Correction ownership is still browser capability-token based.

See [`docs/AUTH_RBAC.md`](docs/AUTH_RBAC.md) for the complete boundary and permission model.

## Repository map

| Path | Responsibility |
| --- | --- |
| `server/server.js` | Startup ordering, listener, signals, graceful shutdown. |
| `server/src/app.js` | Express middleware/routes, health, request IDs, structured logging, errors. |
| `server/src/auth/`, `server/src/routes/auth.routes.js` | OIDC, sessions, local-user resolution, access/permission/CSRF middleware, auth endpoints. |
| `server/src/routes/public.routes.js` | Authenticated product, recount, history, and export APIs; the historical name does not mean unauthenticated. |
| `server/src/routes/admin.routes.js` | Catalog, pricing, corrections, repricing, and user-administration APIs. |
| `server/src/services/` | Authoritative domain services. |
| `server/src/db/`, `server/migrations/` | Pool, startup seed compatibility, migration runner, ordered schema history. |
| `server/src/utils/` | SKU/rule/pricing helpers, numeric parsing, CSV safety, HTTP/logging utilities. |
| `server/data_config.js` | Defaults for an empty catalog only; not deployed live configuration after seeding. |
| `server/test/` | Server unit tests. |
| `server/integration-test/critical-flows.test.js` | Destructive real-PostgreSQL API, migration, upgrade, and concurrency tests. |
| `server/scripts/` | Administrator bootstrap, integrity audit, optional SQLite configuration import. |
| `client/src/auth/` | Memory-only authentication state and AuthGate. |
| `client/src/hooks/`, `client/src/lib/` | Client orchestration and testable presentation rules. |
| `client/src/components/`, `client/src/pages/` | React UI. |
| `client/test/` | Client behavior and regression tests. |
| `scripts/postgres-*.sh` | Verified backup and explicit transactional restore. |
| `docker-compose*.yml`, `*/Dockerfile`, `client/nginx.conf` | Runtime and image wiring. |
| `.github/workflows/ci.yml` | Node 20/PostgreSQL 16 CI. |

## Module summaries

| Domain | Current module responsibility | Detail |
| --- | --- | --- |
| Authentication and access | OIDC identity, PostgreSQL sessions, local users, built-in roles, permissions, AuthGate states, user administration | [`docs/AUTH_RBAC.md`](docs/AUTH_RBAC.md) |
| SKU and catalog | Draft catalog, immutable schema publication, SKU encoding/decoding, permanent reservation, product preview/save | [`docs/SKU_CATALOG.md`](docs/SKU_CATALOG.md) |
| Pricing | Scenario selection, matrices, modifiers, manual pricing, marketing rounding, NBU cache | [`docs/PRICING.md`](docs/PRICING.md) |
| Recount and corrections | Target-schema transitions, correction request queue, capability claims and completion | [`docs/RECOUNT_CORRECTIONS.md`](docs/RECOUNT_CORRECTIONS.md) |
| Repricing | Scenario/global previews, drafts, explicit resolutions, atomic apply and rollback | [`docs/REPRICING.md`](docs/REPRICING.md) |
| Exports | Immutable snapshots, range-bound idempotency, safe CSV, monotonic confirmation cursor | [`docs/EXPORTS.md`](docs/EXPORTS.md) |
| Database | PostgreSQL schema, transactional/checksummed forward migrations `000`–`022`, upgrade/concurrency protections | [`docs/DATABASE_MIGRATIONS.md`](docs/DATABASE_MIGRATIONS.md) |
| Operations | Deployment topology, health/readiness, logs, shutdown, backup/restore, SQLite import | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |

## Current status

- PostgreSQL architecture and migrations `000`–`022` are implemented and immutable history.
- Authoritative product preview/save/decode, catalog schema versioning, pricing, recount/corrections, scenario/global repricing, and export snapshots are implemented with focused unit and PostgreSQL integration coverage.
- OIDC authentication, PostgreSQL sessions, active-user access gating, application-owned RBAC, user management, first-admin bootstrap, permission-aware UI, and live access-state transitions are implemented.
- Server-side authorization and CSRF remain authoritative. `APP_ACCESS_PENDING`/`APP_ACCESS_DISABLED` move the client to the matching AuthGate state; `INSUFFICIENT_PERMISSION` preserves the active session.
- Actor attribution remains unset (`actorId: null`); `audit_events`, user-based correction ownership, custom roles, and invitations are not implemented.
- Live catalog contents and production data quality cannot be inferred from seed defaults or the repository and require operational verification.

## Testing and operations summary

CI runs server unit tests, destructive PostgreSQL integration tests, client tests, client lint, and the production client build. Integration tests refuse a database name that does not end in `_test`; use only a disposable database.

The checked-in Compose setup is a development/single-host baseline, not a complete hardened infrastructure design. PostgreSQL is host-exposed by the base Compose file, secrets come from ignored environment configuration, and backup scheduling/retention/encryption/off-host monitoring remain external responsibilities. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
