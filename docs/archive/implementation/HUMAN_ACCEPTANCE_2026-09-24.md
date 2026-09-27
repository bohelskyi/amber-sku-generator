> Historical record. This document describes the state/planning at the time it was written. Current behavior is defined by current code/migrations and the [maintained domain guides](../../README.md). Dates, findings and acceptance limits below are historical evidence, not current deployment claims.

# Local human acceptance launch — 2026-09-24

### Human acceptance launch, 2026-09-24

At commit `de95738`, a separate local Node 20.20.2/Vite launch was prepared for
human login at `http://localhost:5173`; callback remains
`http://localhost:5000/api/auth/callback`, and post-logout return uses port 5173.
The ordinary Compose `server` was stopped with explicit permission to free 5000;
the ordinary client/PostgreSQL containers were left untouched. Do not use port 80
for this acceptance session.

The process-local launcher is outside the repository at
`%TEMP%/amber-human-acceptance-20260924/launch.cjs`. Before application imports it
verifies the canonical container's loopback mapping and isolated tmpfs, explicitly
sets both DATABASE_URL and PG*/POSTGRES_* to `127.0.0.1:55432/amber_test`, and checks
the actual parsed configuration. Secrets are read in memory, never embedded in the
launcher or printed. Root dotenv uses `override:false`; ordinary `.env` is unchanged.
Vite uses `/api` through its existing port-5000 proxy and strict port 5173. Cookies
retain host-only `/api`, HttpOnly, SameSite=Lax, local HTTP secure=false; trust proxy
is false. The existing server listener binds `::`; Vite binds localhost (`::1`).

Startup applied all 38 migrations through 037 and seeded the empty default catalog
(7 categories); there were no products, identities, users, templates or export
sessions. First-Administrator bootstrap is available but was not run. First real
login creates a pending identity; bootstrap requires verified identity and separate
explicit approval. Synthetic product setup and export readiness remain later steps;
the destructive integration fixture entrypoint must not provision this human session.

Checked: UI HTTP 200; live/ready HTTP 200; unauthenticated direct/proxied business
API JSON 401 without redirect; OIDC discovery HTTP 200. Provider callback/logout
registration and actual login are still unverified. Use separate normal browser
profiles for A/B, separate from ordinary application sessions. No login, permission
grant, template publication, export mutation or full-suite rerun was performed.

Initial live process IDs: server 50516, Vite 50756. PID/start-time records and logs
are beside the launcher. To stop only this launch, run its `stop.ps1`; it validates
process identity before stopping those processes and only `postgres-test`. It does
not restart the ordinary stack. Stopping the test service discards its tmpfs data.
This dated note is launch evidence, not a guarantee that these processes remain live.

Follow-up: after real OIDC login and explicit approval for local user ID 1, the
supported one-use Administrator bootstrap was executed against this isolated
`amber_test`. The account is active with Administrator; bootstrap is now permanently
completed in this disposable database. No other accounts or permissions were changed.

With separate approval, the isolated catalog was supplemented in one transaction:
one `[TEST]` SV category, 23 missing optional non-SKU questions and 56 synthetic
options from the pure Magento fixture. Existing catalog rows and SKU schemas were
verified unchanged; no products/templates/exports were created. A fresh candidate
compiled and returned zero source diagnostics (previously 38). This is synthetic
acceptance setup, not production catalog readiness. The plan and inserted-ID receipt
are retained beside the temporary launcher; no integration entrypoint was imported.
