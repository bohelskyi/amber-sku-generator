# Operations

## Runtime topology

Docker Compose runs PostgreSQL 16, the Node server, and an nginx-hosted production client. nginx serves SPA fallback and proxies `/api/` to the internal server. The checked-in base Compose file is a development/single-host baseline, not a complete hardened boundary; PostgreSQL is host-exposed.

Startup applies migrations, seeds only an empty configuration when appropriate, ensures calibration questions, captures missing legacy V1 schemas, and only then starts listening. While the lifecycle gate is `preparing`, seed and legacy-schema initialization skip writes. PostgreSQL uses the named `postgres_data` volume.

Credentials and OIDC/session secrets come from the ignored project-level `.env` or process environment. Changing `.env` does not rotate credentials inside an already-initialized PostgreSQL volume. `VITE_*` variables are public browser configuration and must never contain secrets.

Server-only Magento OAuth configuration, GET-only discovery/review, explicit category
creation and durable CLI sync jobs are documented in [Magento integration](MAGENTO_INTEGRATION.md).
Migrations 041/042 are installed in the local operator database. The first published
KL revision and successful real UPDATE of `KL3/11131351005`, job
`f2253960-527a-40e9-b879-9041bb036453`, are recorded in the
[2026-09-28 receipt](MAGENTO_INTEGRATION.md#achieved-state-2026-09-28).
This does not certify migration installation in another deployment.

The [automatic workflow](MAGENTO_AUTOMATIC_SYNC.md) starts behind a durable,
default-disabled gate with an isolated worker pool and product-history status.
It does not activate on migration/startup. `magento:sync` without `--apply` performs
GET review **and persists a local queued job**; use the existing schema/evidence/preview
read paths for a strictly read-only review. Product writes require explicit APPLY,
current published bindings and fresh revalidation; success requires read-after-write
verification. Keep category creation and binding publication as separate reviewed
operations. CREATE uses disabled status; UPDATE preserves status/inventory, adds
website memberships and scopes EN writes. Do not replay uncertain steps blindly.

Current production completed Wave 1 activation/cutover through migration 050 (PR #19, 2026-10-01 operator receipt). Automatic sync and stable public identities are active; product CSV delivery is retired after historical delivery/collision reconciliation. See [the retirement boundary](EXPORTS.md#product-csv-retirement). Fresh installations retain default-off gates; a first sync or migration installation alone never activates the selector or retires its queues.

## Deploying the test-product deletion hotfix (050)

Current production completed this hotfix (PR #19); these steps remain the upgrade procedure for installations without 050. Implementation verification uses only fake
Magento HTTP and the canonical disposable PostgreSQL service.

1. Deploy the reviewed hotfix commit as one server/client release. Freeze business
   traffic and stop/drain all old server workers before migration
   (`docker compose stop server` for the single-server topology); do not run mixed
   versions. Keep the normal verified backup outside the repository.
2. Build the server and client images using the deployment's existing configuration:
   `docker compose build server client`. No dependency or credential changes are needed.
3. Start the new server only: `docker compose up -d --no-deps server`. Its normal
   migration runner verifies 000–049 and applies `050_test_product_deletion.sql`.
   If migration fails, keep business traffic closed and resolve it; never edit an
   applied migration or its checksum.
4. Check server readiness (`docker compose ps server` must report healthy; its
   healthcheck calls `/health/ready`) and migration 050's recorded checksum,
   then start the matched client: `docker compose up -d --no-deps client`. Verify
   Administrator has `products.delete_test`; Manager/Storekeeper must not.
5. Reopen traffic after health and ordinary create/recount/archive smoke checks.
   This deployment does not rerun public-SKU activation, delivery cutover or bindings.
6. For the separately authorized manual acceptance product, reserve an exclusive
   Magento operator window. Open its public SKU in Amber, choose **Видалити тестовий
   товар**, review eligibility and the permanent-deletion explanation, enter its exact
   public SKU, and apply. Confirm finalized evidence and absence from ordinary lists.
   Later product allocation must advance; neither SKU is reusable.

On uncertainty, use the same workflow's result check; it reads only after the durable
dispatch marker. Never manually reset ledger state or resend DELETE. A sealed drift,
remote mismatch or still-present dispatched target needs technical review. Audit
filters use subject type `product` and the product ID; `product.test_delete_*` events
and the permanent ledger distinguish dispatch, verified absence and local completion.

Schema downgrade/old-server rollback is unsupported after a deletion intent exists.
Keep the compatible build or roll forward; remote deletion cannot be undone by
restoring an Amber backup. See [the complete recovery contract](MAGENTO_AUTOMATIC_SYNC.md#test-product-deletion).

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

## One-time full-product lifecycle cutover

Ordinary future deployments verify/apply forward migrations and start a compatible application. They are separate from the one-time full-product lifecycle cutover implemented through migrations 039/040. Current production activation is complete; migration installation alone does not switch the selector in other installations.

Follow the [canonical cutover runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md): maintain the traffic/background-work freeze, drain all old writers, and generate fresh indexing and post-index manifests against the exact production database. Rehearsal hashes/counts must never be reused as production approvals. Reconciliations and attestations after activation require separate operator review. Backup/restore rules below are unchanged.

The dated [local acceptance launch](archive/implementation/HUMAN_ACCEPTANCE_2026-09-24.md) is historical evidence, not instructions for a running environment.

## Health, logs, and shutdown

- `/health/live` reports process liveness.
- `/health/ready` runs `SELECT 1` and is exposed only after startup migrations/seed/schema capture. It does not audit all business data or NBU availability.
- Both health endpoints remain unauthenticated. `/health/ready` includes `X-Amber-Full-Product-Writer: 1`; that identifies this build’s writer contract, not selector activation or completion of cutover.

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

## Client nginx and server replacement

The client nginx template resolves its API upstream at request time through Docker embedded DNS (`127.0.0.11`, `valid=1s`, IPv6 lookup disabled). The variable upstream forwards `$request_uri` unchanged, including `/api/`, encoded values, repeated query parameters and OIDC callback parameters. Explicit proxy redirect handling preserves the previous upstream-relative redirect behavior. Host, real IP, forwarded chain/protocol and cookies keep their existing behavior; OIDC callback access-log redaction remains enabled.

Keep Compose `NGINX_ENVSUBST_FILTER=^SERVER_`: only `SERVER_HOST`/`SERVER_PORT` are substituted; nginx runtime variables must remain intact. Deploying the changed nginx configuration initially requires the normal client image deployment. Later server-container replacements do not require a client restart or nginx reload. A one-server deployment can still have an outage while its upstream is absent; DNS recovery is bounded after the new server becomes ready.

Validate without starting or replacing real application services:

```text
docker compose -f docker-compose.yml -f docker-compose.local.yml config --quiet
docker compose build client
node scripts/test-nginx-dns.mjs amber-app-client
node scripts/test-nginx-dns.mjs amber-app-client --negative-control
```

The smoke owns its uniquely named containers/network, uses a mock server, verifies different server IPs and unchanged nginx process/container identity, and cleans up its resources. It also checks nginx syntax, URI/header/cookie/redirect transport, callback-log redaction, real asset caching, missing asset 404 and SPA fallback. No database or Magento service is involved. The image argument must identify the just-built client image; Compose's image name can differ with its project name.

## Integrity audit and SQLite import

`npm run audit:data` in `server/` is read-only and reports missing/duplicate SKUs and products without a saved UAH price; `--json` emits machine-readable output.

```bash
docker compose exec server npm run audit:data
docker compose exec server npm run audit:data -- --json
```

The optional SQLite importer moves configuration/pricing only, not product history. It refuses implicit replacement of a non-empty target and refuses replacement if target products exist; `--replace` is explicit. It creates V1 schema snapshots and preserves/imports `sku_code` values. Never run imports against an unintended database.

For a direct-server import, run `npm run migrate:config -- --sqlite=./amber.db` from `server/` with a verified `DATABASE_URL` targeting the intended PostgreSQL database. Add `--replace` only after explicitly deciding to replace existing configuration; the script still refuses replacement when products exist.
