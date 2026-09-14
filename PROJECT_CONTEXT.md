# Amber SKU Manager: project context

## Purpose

Amber SKU Manager is an internal application for defining amber-product classifications, generating authoritative SKUs and prices, saving and decoding inventory records, recounting/correcting products, controlled mass repricing, and immutable CSV exports.

This is a branch-independent overview. Current code and PostgreSQL migrations are authoritative for implemented behavior; deployed configuration and data determine environment-specific facts. The maintained guides are listed in the [documentation index](docs/README.md).

## Current architecture

The application is a three-tier system:

1. React 19/Vite single-page client calling JSON and CSV endpoints under `/api`.
2. Node 20/CommonJS Express 5 server owning all authentication boundaries and business decisions.
3. PostgreSQL 16 storing catalog configuration, immutable SKU schemas, products, sessions/RBAC, durable audit events, workflows, exchange-rate cache data, and export snapshots.

In Docker, nginx serves the client, provides SPA fallback, and proxies `/api/` to the server. Startup runs migrations, seeds only an empty catalog, captures missing legacy V1 schemas, and begins listening only after those phases complete. The client is never a trust boundary.

## Authentication and RBAC state

Server-owned OIDC Authorization Code flow with PKCE, state, and nonce is implemented; the example deployment uses Keycloak. Sessions are opaque, PostgreSQL-backed, fixed/non-rolling, and exposed through a host-only `HttpOnly` `amber.sid` cookie. OIDC tokens and the client secret remain server-side.

Local application users and exact immutable `issuer` + `sub` identity links are implemented. Users move through `pending`, `active`, and `disabled` states. Every business request resolves current local status, roles, and permissions from PostgreSQL, so disablement and role revocation affect existing sessions immediately.

Stable capability keys guard every business endpoint after authentication, active-user resolution, and method-aware CSRF enforcement. `/api/auth/me` returns safe identity/user data, roles, effective permission keys, and the in-memory synchronizer CSRF token. React navigation and controls use only those effective keys; server-side `403` enforcement remains authoritative.

The three system roles are Administrator, Manager, and Storekeeper. Administrator is permanent, immutable, and always receives every defined permission. Manager and Storekeeper retain their initial mappings but are editable through role administration like custom roles. `users.manage`, `roles.manage`, and `audit.view` are reserved to Administrator. Exactly one current role may be assigned to each user.

Administrators can create and edit custom roles, edit Manager and Storekeeper, assign any active role, and approve, disable, or re-enable users while retaining assignment history. Role and user mutations share one advisory-lock boundary, optimistic role/assignment conflict detection, last-Administrator protection, and transaction-coupled durable audit. Product, correction, repricing, export, and schema-publication records retain the applicable nullable local-user actor foreign keys. Correction requests record their creator and use local application-user ownership plus a monotonic claim epoch; retained browser capability tokens authorize only one-time adoption of legacy token-only claims. The one-use offline first-Administrator bootstrap and Administrator-only global audit viewer are implemented. Invitations remain pending.

See [`docs/AUTH_RBAC.md`](docs/AUTH_RBAC.md) for the complete boundary and permission model.

## Repository map

| Path | Responsibility |
| --- | --- |
| `server/server.js` | Startup ordering, listener, signals, graceful shutdown. |
| `server/src/app.js` | Express middleware/routes, health, request IDs, structured logging, errors. |
| `server/src/auth/`, `server/src/routes/auth.routes.js` | OIDC, sessions, local-user resolution, access/permission/CSRF middleware, auth endpoints. |
| `server/src/audit/` | Local-user mutation context and transaction-scoped durable audit writer. |
| `server/src/routes/public.routes.js`, `server/src/routes/public/` | Aggregator and domain routers for authenticated product, recount, history, and export APIs; the historical name does not mean unauthenticated. |
| `server/src/routes/admin.routes.js`, `server/src/routes/admin/` | Aggregator and domain routers for catalog, pricing, corrections, repricing, audit, and access administration. |
| `server/src/services/`, `server/src/presenters/` | Authoritative domain services, extracted domain modules, and response/CSV presenters. |
| `server/src/db/`, `server/migrations/` | Pool, startup seed compatibility, migration runner, ordered schema history. |
| `server/src/utils/` | SKU/rule/pricing helpers, numeric parsing, CSV safety, HTTP/logging utilities. |
| `server/data_config.js` | Defaults for an empty catalog only; not deployed live configuration after seeding. |
| `server/test/` | Server unit tests. |
| `server/integration-test/` | One serialized destructive PostgreSQL entrypoint, ordered domain case modules, shared fixtures, API/migration/upgrade coverage, and real concurrency tests. |
| `server/scripts/` | Administrator bootstrap, integrity audit, optional SQLite configuration import. |
| `client/src/auth/` | Memory-only authentication state and AuthGate. |
| `client/src/hooks/`, `client/src/lib/` | Client orchestration and testable presentation rules. |
| `client/src/components/`, `client/src/pages/` | React UI. |
| `client/test/` | Client behavior and regression tests. |
| `scripts/postgres-*.sh` | Verified backup and explicit transactional restore. |
| `docker-compose*.yml`, `*/Dockerfile`, `client/nginx.conf` | Runtime and image wiring. |
| `.github/workflows/ci.yml` | Node 20/PostgreSQL 16 CI. |

## Current behavior

Authoritative product preview/save/decode, catalog schema versioning, pricing, recount/corrections, scenario/global repricing, export snapshots, and the Administrator-only audit viewer are implemented. Product history includes a timeline and a `configurationEvolution` projection: it reconstructs recorded configuration states across a correction lineage and reports partial or unavailable evidence rather than inventing missing history. See the [recount and corrections guide](docs/RECOUNT_CORRECTIONS.md).

Server-side authorization and CSRF remain authoritative. `APP_ACCESS_PENDING` and `APP_ACCESS_DISABLED` move the client to the matching AuthGate state; `INSUFFICIENT_PERMISSION` preserves the active session. Durable transaction-coupled audit events cover access administration, catalog/pricing changes, products, correction requests, repricing, exports, and SKU schema publication. Invitations are not implemented. See [authentication and RBAC](docs/AUTH_RBAC.md).

The completed refactor and its measured performance evidence are [historical records](docs/archive/REFACTOR_2026.md). Live catalog contents and production data quality require operational verification.

## Testing and operations summary

CI validates Compose, runs scoped server static checks, server unit tests with non-blocking coverage visibility, the serialized destructive PostgreSQL integration suite, client tests with non-blocking coverage visibility, client lint, and the production client build. The container smoke workflow also supports manual execution and runs weekly to detect mutable base-image compatibility drift. Integration tests refuse a database name that does not end in `_test`; use only a disposable database.

The checked-in Compose setup is a development/single-host baseline, not a complete hardened infrastructure design. PostgreSQL is host-exposed by the base Compose file, secrets come from ignored environment configuration, and backup scheduling/retention/encryption/off-host monitoring remain external responsibilities. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
