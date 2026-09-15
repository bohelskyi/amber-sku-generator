# Operations

## Runtime topology

Docker Compose runs PostgreSQL 16, the Node server, and an nginx-hosted production client. nginx serves SPA fallback and proxies `/api/` to the internal server. The checked-in base Compose file is a development/single-host baseline, not a complete hardened boundary; PostgreSQL is host-exposed.

Startup applies migrations, seeds only an empty configuration when appropriate, ensures calibration questions, captures missing legacy V1 schemas, and only then starts listening. PostgreSQL uses the named `postgres_data` volume.

Credentials and OIDC/session secrets come from the ignored project-level `.env` or process environment. Changing `.env` does not rotate credentials inside an already-initialized PostgreSQL volume. `VITE_*` variables are public browser configuration and must never contain secrets.

## OIDC deployment

The repository's example production application locations are:

- production application: `https://skumanager.ambergalbin.space`;
- production callback: `https://skumanager.ambergalbin.space/api/auth/callback`.

The application cannot verify which URLs are currently registered with the external OIDC provider. Before deployment, confirm its allowed callback and post-logout URLs and set matching `APP_BASE_URL` and `OIDC_REDIRECT_URI` values.

For local execution, `APP_BASE_URL` depends on the client mode:

- Vite development: [http://localhost:5173](http://localhost:5173);
- Docker/nginx local client: [http://localhost](http://localhost);
- OIDC callback for a directly launched server or the local Compose override: [http://localhost:5000/api/auth/callback](http://localhost:5000/api/auth/callback).

Production uses the nginx `/api` path with the server kept internal. `TRUST_PROXY` is an exact hop count, and the outer TLS proxy must replace untrusted forwarding headers and preserve the original HTTPS scheme so Express emits secure cookies. Never directly expose the server when proxy trust is enabled.

For local development, register and use the chosen localhost origins consistently rather than mixing `localhost` and `127.0.0.1`. Vite proxies `/api` to a directly launched server on port 5000. Base Compose exposes that server only to other containers; use `docker-compose.local.yml` when a local Docker callback must reach `localhost:5000`. The override also defines the disposable `postgres-test` service and is not the production Compose file.

Earlier real-environment verification covered Keycloak plus `amber.local` AD login, PostgreSQL application sessions, `/api/auth/me`, provider logout, JSON `401` for unauthenticated business requests, and authenticated workflows. This is historical verification, not evidence of current provider registration or deployment state.

## Health, logs, and shutdown

- `/health/live` reports process liveness.
- `/health/ready` runs `SELECT 1` and is exposed only after startup migrations/seed/schema capture. It does not audit all business data or NBU availability.
- Both health endpoints remain unauthenticated.

Requests receive and return `X-Request-ID`; completions and mutations are logged as structured JSON. OIDC callback logging strips query strings so authorization codes, state, and provider errors do not enter application or nginx access logs. For authenticated business mutations, operational log `actorId` uses the resolved local `application_users.id` where available. These logs remain non-durable telemetry and are separate from transaction-coupled `audit_events`.

SIGTERM/SIGINT stop new HTTP acceptance, wait for HTTP closure, close the PostgreSQL pool, and force-exit after ten seconds if shutdown stalls. Preserve that ordering.

The request pool has configurable size and connect/idle/query/statement timeouts. Migration DDL deliberately uses a separate no-query-timeout client; ordinary long-running operations still use request limits.

## Backup and restore

`scripts/postgres-backup.sh` creates a timestamped custom-format archive, removes incomplete output on failure, verifies non-empty output, and checks the archive listing.

```bash
sh ./scripts/postgres-backup.sh /secure/local/backup/path
```

`scripts/postgres-restore.sh` is destructive. It requires an exact dump path and `--confirm`, validates the archive before destructive work, and refuses to replace the PostgreSQL maintenance/template databases. It then stops client/server if running, force-disconnects other sessions from only the configured application database, drops and recreates that database from `template0` with the configured PostgreSQL user as owner, and restores with `--no-owner --no-acl --single-transaction --exit-on-error`. Recreating the database ensures target-only objects from a newer schema cannot block or survive an older restore. The script checks basic product/migration tables and restarts only services that were previously running.

Archive validation catches an unreadable archive before the database is removed, but database replacement and archive restore cannot be one transaction. If database creation, restore, or verification fails after the destructive phase begins, the old contents are no longer available in the target; the target may be absent or newly created without restored objects. The restore transaction prevents a partially restored archive. The command exits nonzero without printing success and intentionally leaves server/client stopped so startup cannot migrate or seed an empty database. Retain the verified dump until the restore and subsequent application startup checks have passed.

```bash
sh ./scripts/postgres-restore.sh /secure/local/backup/path/amber-YYYYMMDDTHHMMSSZ.dump --confirm
```

Before restore, verify both dump path and target environment. Keep backups outside the repository, copy them to monitored off-host storage, and regularly test restores in a disposable environment. Scheduling, retention, encryption, off-host transfer, monitoring, and disaster-recovery orchestration are external infrastructure responsibilities.

## Integrity audit and SQLite import

`npm run audit:data` in `server/` is read-only and reports missing/duplicate SKUs and products without a saved UAH price; `--json` emits machine-readable output.

```bash
docker compose exec server npm run audit:data
docker compose exec server npm run audit:data -- --json
```

The optional SQLite importer moves configuration/pricing only, not product history. It refuses implicit replacement of a non-empty target and refuses replacement if target products exist; `--replace` is explicit. It creates V1 schema snapshots and preserves/imports `sku_code` values. Never run imports against an unintended database.

For a direct-server import, run `npm run migrate:config -- --sqlite=./amber.db` from `server/` with a verified `DATABASE_URL` targeting the intended PostgreSQL database. Add `--replace` only after explicitly deciding to replace existing configuration; the script still refuses replacement when products exist.
