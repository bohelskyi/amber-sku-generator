# Authentication and RBAC

## Architecture

The repository's example deployment uses Keycloak realm `amber` and confidential client `amber-sku-manager`. Its `amber.local` Active Directory federation over LDAPS is an external deployment setting, not something the application code verifies; confirm the active provider configuration operationally. Express owns OIDC discovery and the Authorization Code flow with PKCE, state, and nonce. The client secret never enters the browser bundle.

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

Permission keys are stable capabilities stored in `permissions` and mapped to roles through `role_permissions`. Every application user has at most one unrevoked role assignment across all roles. Administration revokes rather than deletes assignment history.

| Area | Permission keys |
| --- | --- |
| Products/history | `products.view`, `products.decode`, `products.create`, `products.archive`, `products.recount`, `history.view` |
| Corrections | `corrections.view`, `corrections.create`, `corrections.price_override`, `corrections.claim`, `corrections.complete`, `corrections.reject`, `corrections.force_release` |
| Repricing | `repricing.view`, `repricing.prepare`, `repricing.apply`, `repricing.rollback` |
| Exports | `exports.view`, `exports.create` |
| Catalog/pricing | `catalog.view`, `catalog.manage`, `sku_schemas.publish`, `pricing.view`, `pricing.manage` |
| Access administration | `users.manage`, `roles.manage` |
| Audit | `audit.view` |

`products.recount` authorizes both the existing direct recount apply and the separate direct in-place product price-change command, including `POST /api/product-price-change/preview` and `POST /api/product-price-change/apply`. The server enforces that permission independently of client visibility. `corrections.create` and `corrections.price_override` authorize the request-based correction workflow only and do not authorize either direct price-change endpoint.

Initial system-role mappings after migration `030`:

| Role | Effective scope |
| --- | --- |
| Administrator | Every defined permission, including the explicitly Administrator-only `audit.view`. Full product, catalog, pricing, correction, repricing, export, user, role-management, and future audit-view access. |
| Manager | Initially product view/decode, history, correction view/create/price-override/reject, repricing view/prepare, pricing view, and export view. Its name, description, permissions, and status are Administrator-editable. |
| Storekeeper | Initially product view/decode/create/archive/direct recount/direct in-place price change, history, correction view/create/claim/complete/reject, repricing view/prepare, and export view. Its name, description, permissions, and status are Administrator-editable. |

The built-in Administrator role is permanent and immutable and automatically receives every permission inserted into `permissions`. It cannot be renamed, disabled, deleted, or permission-edited. Manager, Storekeeper, and custom roles retain immutable `role_key` and `is_system` identity fields but otherwise use the same editable lifecycle. Roles are never hard-deleted. `users.manage`, `roles.manage`, and `audit.view` are reserved to Administrator and database constraints reject mappings to any other role.

The initial Manager role remains request-only for these operations: it has correction-request creation and price-override permissions but not `products.recount`, so the direct in-place price-change preview and apply remain denied. Adding the direct command does not broaden Manager access; an editable Manager or custom role receives it only when an Administrator explicitly grants `products.recount`.

The permission-aware client uses only the effective keys from `/api/auth/me`, never role-name checks, to hide unavailable controls. Manager pricing uses the published product catalog projection to select a category and the category pricing endpoint to render matrices/modifiers read-only; this does not grant `catalog.view`.

## First-Administrator bootstrap

Bootstrap is deliberately offline and permanently one-use:

1. The intended Administrator logs in normally, creating a verified pending local user.
2. An operator runs `npm run auth:bootstrap-admin -- --user-id <id>` from `server/`.
3. One transaction under an advisory lock verifies an external identity, assigns Administrator, activates the user, and completes `security_bootstrap_state` permanently.

There is no HTTP bootstrap route, automatic Administrator assignment, or reopening after completion.

## User administration

All `/api/admin/users` operations require `users.manage`. Administrators can list safe OIDC-synchronized profile/status fields and active assignable roles, approve a pending user with one numeric role ID, replace an active or disabled user's role, disable an active user, and re-enable a disabled user with its retained or selected role. Replacements require the expected current assignment ID and preserve revoked assignment history. Disabled users retain their role.

Issuer and subject are neither edited nor returned by these administration endpoints. Mutations use one transaction-scoped advisory lock and revalidate the actor's active state and permission after acquiring it. Disabling or demoting an Administrator rechecks active Administrator count under that lock and returns `409 LAST_ADMINISTRATOR_REQUIRED` if none would remain, including concurrent or self-removal attempts. Stale role replacement returns a stable assignment conflict.

## Role administration

All role-definition operations require `roles.manage`, which is reserved to Administrator. Administrators can list roles and the fixed permission catalog, create custom roles, edit Manager/Storekeeper/custom role metadata and permission sets, and deactivate/reactivate unassigned editable roles. Role updates require `expectedVersion`; stale concurrent changes return `409 ROLE_VERSION_CONFLICT`. A role with any current assignment, including a disabled user's retained assignment, cannot be deactivated.

Permission replacement is atomic and affects assigned active users on their next business request because effective permissions are always re-read from PostgreSQL. Role create/update/permission/deactivate/reactivate successes are durably audited in the same transaction. Failures and no-ops do not emit success events.

Successful approve, role-change, disable, and enable operations append one immutable `audit_events` row inside the same database transaction. Attribution uses `application_users.id`, the request ID, and a minimal event-time snapshot containing display name and preferred username; historical rendering must not depend on the actor's current OIDC-synchronized profile. Existing `user_role_assignments.assigned_by` and `revoked_by` history is preserved. Failed operations and same-role no-ops do not write success events, and an audit insert failure rolls back the user mutation.

Operational HTTP mutation logs are separate, non-durable telemetry. Their `actorId` uses the resolved local application-user ID where available; neither operational nor durable attribution uses OIDC `sub` or username as the actor key. The `GET /api/admin/audit-events` endpoint and `/admin/audit` client page enforce Administrator-only `audit.view` and expose filtered keyset pagination without making audit records mutable.

## Correction ownership and remaining gap

Correction claims are owned by local `application_users.id`, with a monotonic claim version. Administrator has no implicit bypass of another user's ordinary claim; the explicit confirmed force-release operation requires `corrections.force_release`. Legacy token-only claims have a one-time adoption path. See [recount and corrections](RECOUNT_CORRECTIONS.md) for the complete workflow. Do not infer actor identity from OIDC `sub` or a claim token.

Invitations are not implemented. Durable audit coverage is described here for access administration and in the relevant domain guides for business operations; do not assume an event exists for an unlisted operation.

## Price-change capabilities

`products.price_change` authorizes direct in-place price preview and apply independently from `products.recount`. Migration 032 grants it to every editable role that had direct recount at upgrade time, preserving Storekeeper and custom-role behavior; Administrator receives it through the protected permission-catalog trigger. `corrections.create` authorizes recount and price-change requests, while `corrections.price_override` controls Manual UAH and USD/gram decisions in either request type. UI and server behavior use effective permission keys only and never role names.
