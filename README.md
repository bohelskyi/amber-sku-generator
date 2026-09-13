# amber-sku-generator

## Deploy with Docker (Ubuntu 24.04)

1. Install Docker Engine + Compose plugin (official docs):
   - https://docs.docker.com/engine/install/ubuntu/

2. Clone the project and move into its repository folder:
```bash
cd amber-sku-generator
```

3. Create local runtime configuration and replace the placeholder database and server secrets:
```bash
cp .env.example .env
${EDITOR:-vi} .env
```

The `.env` file is ignored by Git. Keep production copies in protected deployment storage and do not commit them. `OIDC_CLIENT_SECRET` is server-only. Generate `SESSION_SECRET` from at least 32 cryptographically random bytes; do not reuse the OIDC client secret.

4. Build and run:
```bash
docker compose up -d --build
```

5. Put the deployment behind the configured HTTPS proxy and open the registered application URL:
```text
https://skumanager.ambergalbin.space
```

The checked-in Compose topology serves the client over HTTP for local/single-host use. Production OIDC and secure session cookies require the documented HTTPS origin and proxy forwarding settings; see [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Useful commands

```bash
docker compose logs -f
docker compose ps
docker compose down
```

### Data integrity audit

The audit is read-only. It reports missing and duplicate SKUs, plus products without a saved UAH price:

```bash
docker compose exec server npm run audit:data
```

For machine-readable output:

```bash
docker compose exec server npm run audit:data -- --json
```

Database migrations from `server/migrations` run automatically during server startup and are recorded in `schema_migrations`.

### SKU schema versions

- Existing articles without a marker are decoded by the immutable V1 snapshot.
- Structural changes in the admin panel remain a draft until `Опублікувати V…` is pressed.
- New published versions use a compact numeric marker, for example `BR2/...` or `BR52/...`.
- `Внутрішнє значення` is used by pricing rules; `Код у SKU` is the encoded value and may be reused after the old option is archived.
- Labels for natural and formed grades may share the same internal value and SKU code; their visibility conditions select the contextual label.

Create a database backup before the first deployment of the versioning migration. On startup, the service automatically captures the current historical structure as V1 and links existing products to it.

### Data persistence

- PostgreSQL data is stored in Docker volume `postgres_data`.
- PostgreSQL database, user, and password are required in the project-level `.env`; Compose passes the same values to PostgreSQL and the server.
- Changing `.env` does not rewrite credentials in an already-initialized PostgreSQL volume. Coordinate credential rotation in PostgreSQL before changing deployed values.

For timestamped custom-format backups with archive verification:

```bash
sh ./scripts/postgres-backup.sh /secure/local/backup/path
sh ./scripts/postgres-restore.sh /secure/local/backup/path/amber-YYYYMMDDTHHMMSSZ.dump --confirm
```

The restore command is intentionally explicit and replaces matching database objects. Test restores regularly in a disposable environment. Production deployments must additionally copy backups to a monitored off-host destination; that destination is infrastructure-specific and is not hardcoded here.

### Migrate config from old SQLite (optional)

If you need to keep existing categories/questions/options and price settings from old `server/amber.db`, run:

```bash
cd server
npm install
DATABASE_URL='postgresql://example_user:example_password@localhost:5432/amber' \
  npm run migrate:config -- --sqlite=./amber.db
```

Notes:
- This migrates only config/pricing tables.
- Products history (`products`) is not copied.
- By default the script only imports into a database without configuration.
- To explicitly replace configuration, add `--replace`. Replacement is refused when the target contains products.
- The import creates V1 SKU schema snapshots and preserves/imports `sku_code` values.

### Runtime configuration

See `.env.example` for all supported settings. `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are required by Compose and are also used by a directly launched server when `DATABASE_URL` is absent. Standard `PG*` variables can override individual connection fields; startup fails clearly when credentials are absent or runtime values are invalid.

The server requires the OIDC issuer/client/callback settings plus `APP_BASE_URL` and `SESSION_SECRET`. It exposes the server-owned Authorization Code + PKCE flow at `/api/auth/login` and `/api/auth/callback`, current identity at `/api/auth/me`, and CSRF-protected local/provider logout at `POST /api/auth/logout`. Successful logout returns a server-generated Keycloak `logoutUrl` for the browser to open as a top-level navigation; the API response itself does not redirect cross-origin. All business API routes require an authenticated application session, and unsafe methods also require the synchronizer CSRF token. The PostgreSQL-backed session cookie is host-only, `HttpOnly`, `SameSite=Lax`, scoped to `/api`, and has a fixed configurable lifetime (`SESSION_MAX_AGE_MS`, eight hours by default).

For direct local development, use `APP_BASE_URL=http://localhost:5173`, the registered `http://localhost:5000/api/auth/callback`, `SESSION_COOKIE_SECURE=false`, and `TRUST_PROXY=false`. Use `localhost` consistently rather than mixing it with `127.0.0.1`.

For production, use `APP_BASE_URL=https://skumanager.ambergalbin.space`, the registered HTTPS callback, `SESSION_COOKIE_SECURE=true`, and the exact trusted proxy-hop count (`TRUST_PROXY=1` for the checked-in nginx-to-server path). Register the same `APP_BASE_URL` as the Keycloak post-logout redirect URI. The outer TLS proxy must replace untrusted forwarding headers and pass the original HTTPS protocol to nginx. Never expose the server container directly when proxy trust is enabled.

`VITE_API_BASE_URL` is intentionally public configuration because Vite bundles it into the browser application. Never put a secret in a `VITE_*` variable.
