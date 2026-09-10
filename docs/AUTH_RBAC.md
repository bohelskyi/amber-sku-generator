# Authentication and RBAC

## Architecture

Keycloak realm `amber` is the OpenID Provider. The confidential client is `amber-sku-manager`; Keycloak authenticates `amber.local` Active Directory users through LDAP federation over LDAPS. Express owns OIDC discovery and the Authorization Code flow with PKCE, state, and nonce. The client secret never enters the browser bundle.

The authentication endpoints are:

- `GET /api/auth/login`: validates a relative application return path and begins login.
- `GET /api/auth/callback`: validates the OIDC transaction, resolves the exact external identity, regenerates the session, and stores normalized identity.
- `GET /api/auth/me`: returns normalized identity, safe local-user state, active roles, effective permission keys, and a synchronizer CSRF token.
- `POST /api/auth/logout`: requires authentication and CSRF, destroys the local session, and returns a server-generated Keycloak logout URL for top-level navigation.

OIDC identity is the immutable pair `issuer` + `sub`. Username, email, display name, and other mutable claims may refresh the local profile but must never be used to fuzzy-link or replace identity. OIDC access, refresh, and ID tokens are not stored in React or browser storage, and OIDC `sub` must not be copied into application actor fields.

## Sessions and request boundary

Sessions are opaque and PostgreSQL-backed through the migration-owned `session` table. Runtime session-table creation is disabled. The `amber.sid` cookie is host-only, `HttpOnly`, `SameSite=Lax`, scoped to `/api`, and fixed/non-rolling for `SESSION_MAX_AGE_MS` (eight hours by default). It is `Secure` for production HTTPS and non-`Secure` only for local HTTP development.

`/health/live`, `/health/ready`, and OIDC login/callback remain unauthenticated. Every business route in both historical router trees requires an authenticated application session and active local user. Unauthenticated API requests receive JSON `401`, never an OIDC redirect.

For authenticated business traffic, `GET`, `HEAD`, and `OPTIONS` do not require CSRF. Unsafe methods require the in-memory synchronizer token in `X-CSRF-Token`. After authentication, active-user resolution and CSRF, each route enforces its stable permission key server-side. React checks affect visibility only.

## Local users and access states

A first validated login atomically creates one `pending` `application_users` row and one immutable external-identity link. It does not activate the user or assign a role. Later logins update mutable profile fields and authentication timestamps.

Application access states are:

- `pending`: `/api/auth/me` and CSRF-protected logout remain available; business APIs return `403 APP_ACCESS_PENDING`.
- `active`: business access is determined by effective database permissions.
- `disabled`: `/api/auth/me` and logout remain available; business APIs return `403 APP_ACCESS_DISABLED`.

Roles, permissions, and status are resolved from PostgreSQL on every business request, so revocation or disablement affects an existing session immediately. The client `AuthProvider`/`AuthGate` bootstraps through `/api/auth/me` and keeps identity, access, roles, permissions, and CSRF state in memory only. Stable pending/disabled errors move an already-mounted client to the corresponding AuthGate without refresh. `403 INSUFFICIENT_PERMISSION` does not log out or change access state; existing `401` handling remains the unauthenticated transition.

## Permission model

Permission keys are stable capabilities stored in `permissions` and mapped to roles through `role_permissions`. Every application user has at most one active assignment per built-in role; current administration maintains exactly one active built-in role for managed users and revokes rather than deletes assignment history.

| Area | Permission keys |
| --- | --- |
| Products/history | `products.view`, `products.decode`, `products.create`, `products.archive`, `products.recount`, `history.view` |
| Corrections | `corrections.view`, `corrections.create`, `corrections.claim`, `corrections.complete`, `corrections.reject`, `corrections.force_release` |
| Repricing | `repricing.view`, `repricing.prepare`, `repricing.apply`, `repricing.rollback` |
| Exports | `exports.view`, `exports.create` |
| Catalog/pricing | `catalog.view`, `catalog.manage`, `sku_schemas.publish`, `pricing.view`, `pricing.manage` |
| Access administration | `users.manage`, `roles.manage` |
| Audit | `audit.view` |

Current built-in mappings after migration `023`:

| Role | Effective scope |
| --- | --- |
| Administrator | Every defined permission, including the explicitly Administrator-only `audit.view`. Full product, catalog, pricing, correction, repricing, export, user, role-management, and future audit-view access. |
| Manager | Product view/decode, history, correction view/create/reject, repricing view/prepare, pricing view, and export view. No product creation/archive/direct recount, correction claim/complete/force-release, catalog access, pricing edits, repricing apply/rollback, export create/confirm, or user/role administration. |
| Storekeeper | Product view/decode/create/archive/direct recount, history, correction view/create/claim/complete/reject, repricing view/prepare, and export view. No catalog/pricing access, correction force-release, repricing apply/rollback, export create/confirm, or user/role administration. |

The permission-aware client uses only the effective keys from `/api/auth/me`, never role-name checks, to hide unavailable controls. Manager pricing uses the published product catalog projection to select a category and the category pricing endpoint to render matrices/modifiers read-only; this does not grant `catalog.view`.

## First-Administrator bootstrap

Bootstrap is deliberately offline and permanently one-use:

1. The intended Administrator logs in normally, creating a verified pending local user.
2. An operator runs `npm run auth:bootstrap-admin -- --user-id <id>` from `server/`.
3. One transaction under an advisory lock verifies an external identity, assigns Administrator, activates the user, and completes `security_bootstrap_state` permanently.

There is no HTTP bootstrap route, automatic Administrator assignment, or reopening after completion.

## User administration

All `/api/admin/users` operations require `users.manage`. Administrators can list safe OIDC-synchronized profile/status fields and assignable built-in roles, approve a pending user with one role, replace an active or disabled user's role, disable an active user, and re-enable a disabled user with its retained or selected role.

Issuer and subject are neither edited nor returned by these administration endpoints. Mutations use one transaction-scoped advisory lock. Disabling or demoting an Administrator rechecks active Administrator count under that lock and returns `409 LAST_ADMINISTRATOR_REQUIRED` if none would remain, including concurrent or self-removal attempts.

Successful approve, role-change, disable, and enable operations append one immutable `audit_events` row inside the same database transaction. Attribution uses `application_users.id`, the request ID, and a minimal event-time snapshot containing display name and preferred username; historical rendering must not depend on the actor's current OIDC-synchronized profile. Existing `user_role_assignments.assigned_by` and `revoked_by` history is preserved. Failed operations and same-role no-ops do not write success events, and an audit insert failure rolls back the user mutation.

Operational HTTP mutation logs are separate, non-durable telemetry. Their `actorId` uses the resolved local application-user ID where available; neither operational nor durable attribution uses OIDC `sub` or username as the actor key. Migration `023` defines `audit.view`, but this foundation does not add an audit-view endpoint or client UI.

## Deferred authorization work

Application authentication, local users, built-in RBAC, user administration, the durable audit foundation, product create/archive/recount attribution, permission-aware UI, and live access-state handling are implemented. The following remain intentionally pending:

- durable audit coverage outside application-user administration and product create/archive/recount, plus the Administrator-only audit viewer;
- user-based correction ownership (claims are still browser capability tokens);
- invitations and custom-role management.

Do not infer actor identity from OIDC `sub` or from a correction claim token. See [`RECOUNT_CORRECTIONS.md`](RECOUNT_CORRECTIONS.md) for current ownership semantics.
