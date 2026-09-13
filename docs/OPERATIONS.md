# Operations

## Runtime topology

Docker Compose runs PostgreSQL 16, the Node server, and an nginx-hosted production client. nginx serves SPA fallback and proxies `/api/` to the internal server. The checked-in base Compose file is a development/single-host baseline, not a complete hardened boundary; PostgreSQL is host-exposed.

Startup applies migrations, seeds only an empty configuration when appropriate, ensures calibration questions, captures missing legacy V1 schemas, and only then starts listening. PostgreSQL uses the named `postgres_data` volume.

Credentials and OIDC/session secrets come from the ignored project-level `.env` or process environment. Changing `.env` does not rotate credentials inside an already-initialized PostgreSQL volume. `VITE_*` variables are public browser configuration and must never contain secrets.

## OIDC deployment

Current registered application locations are:

- production application: `https://skumanager.ambergalbin.space`;
- production callback: `https://skumanager.ambergalbin.space/api/auth/callback`;

For local execution, `APP_BASE_URL` depends on the client mode:

- Vite development: [http://localhost:5173](http://localhost:5173);
- Docker/nginx local client: [http://localhost](http://localhost);
- OIDC callback in both cases: [http://localhost:5000/api/auth/callback](http://localhost:5000/api/auth/callback).

Production uses the nginx `/api` path with the server kept internal. `TRUST_PROXY` is an exact hop count, and the outer TLS proxy must replace untrusted forwarding headers and preserve the original HTTPS scheme so Express emits secure cookies. Never directly expose the server when proxy trust is enabled.

For local development, use the registered localhost origins consistently rather than mixing `localhost` and `127.0.0.1`. `docker-compose.local.yml` may expose the server port and is not the production Compose file.

Real-environment verification has covered Keycloak plus `amber.local` AD login, PostgreSQL application sessions, `/api/auth/me`, provider logout, JSON `401` for unauthenticated business requests, and existing authenticated workflows.

## Health, logs, and shutdown

- `/health/live` reports process liveness.
- `/health/ready` runs `SELECT 1` and is exposed only after startup migrations/seed/schema capture. It does not audit all business data or NBU availability.
- Both health endpoints remain unauthenticated.

Requests receive and return `X-Request-ID`; completions and mutations are logged as structured JSON. OIDC callback logging strips query strings so authorization codes, state, and provider errors do not enter application or nginx access logs. For authenticated business mutations, operational log `actorId` uses the resolved local `application_users.id` where available. These logs remain non-durable telemetry and are separate from transaction-coupled `audit_events`.

SIGTERM/SIGINT stop new HTTP acceptance, wait for HTTP closure, close the PostgreSQL pool, and force-exit after ten seconds if shutdown stalls. Preserve that ordering.

The request pool has configurable size and connect/idle/query/statement timeouts. Migration DDL deliberately uses a separate no-query-timeout client; ordinary long-running operations still use request limits.

## Backup and restore

`scripts/postgres-backup.sh` creates a timestamped custom-format archive, removes incomplete output on failure, verifies non-empty output, and checks the archive listing.

`scripts/postgres-restore.sh` is destructive. It requires an exact dump path and `--confirm`, validates the archive, stops client/server if running, restores with `--clean --if-exists --single-transaction --exit-on-error`, checks basic product/migration tables, and restarts only services that were previously running.

Before restore, verify both dump path and target environment. Keep backups outside the repository, copy them to monitored off-host storage, and regularly test restores in a disposable environment. Scheduling, retention, encryption, off-host transfer, monitoring, and disaster-recovery orchestration are external infrastructure responsibilities.

## Integrity audit and SQLite import

`npm run audit:data` in `server/` is read-only and reports missing/duplicate SKUs and products without a saved UAH price; `--json` emits machine-readable output.

The optional SQLite importer moves configuration/pricing only, not product history. It refuses implicit replacement of a non-empty target and refuses replacement if target products exist; `--replace` is explicit. It creates V1 schema snapshots and preserves/imports `sku_code` values. Never run imports against an unintended database.
