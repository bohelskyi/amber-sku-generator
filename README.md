# Amber SKU Manager

Amber SKU Manager is an internal application for catalog configuration, authoritative SKU and price generation, product recount and corrections, repricing, and immutable CSV export. See the [project overview](PROJECT_CONTEXT.md) and [documentation index](docs/README.md) for current behavior and historical records.

## Deploy with Docker

1. Install [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/ubuntu/), clone the repository, and run the following commands from its root.
2. Create deployment configuration:

   ```bash
   cp .env.example .env
   ${EDITOR:-vi} .env
   ```

   Replace the database password, OIDC client secret, and session secret. Set `APP_BASE_URL` to the externally visible application origin, `OIDC_REDIRECT_URI` to its registered `/api/auth/callback` URL, and the issuer/client values to the deployment's provider. For production HTTPS, set `SESSION_COOKIE_SECURE=true` and the exact `TRUST_PROXY` hop count (`1` for the checked-in nginx-to-server path). The sample `.env.example` uses **local HTTP** origins and flags; do not deploy with those defaults. The outer TLS proxy must pass the original HTTPS scheme and replace untrusted forwarding headers. Keep `.env` outside version control.

3. Build and start:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

The checked-in Compose topology serves the client over HTTP and publishes PostgreSQL on the host. Production HTTPS, proxy trust, database exposure, and backup arrangements need environment-specific review. Follow [operations](docs/OPERATIONS.md) before deploying or restoring data.

## Local development and verification

For a Vite client on `http://localhost:5173`, register `http://localhost:5000/api/auth/callback` with the local OIDC client and set `APP_BASE_URL=http://localhost:5173`, `SESSION_COOKIE_SECURE=false`, and `TRUST_PROXY=false`. Vite proxies `/api` to the local server. When running the Docker/nginx client locally, use `APP_BASE_URL=http://localhost` and the [local Compose override](docs/OPERATIONS.md#oidc-deployment) to expose the server callback port. Use `localhost` consistently.

With local database and OIDC settings configured in `.env`, start the server and Vite in separate terminals:

```bash
cd server && npm ci && npm start
```

```bash
cd client && npm ci && npm run dev
```

`VITE_API_BASE_URL` is browser-visible configuration; never put a secret in a `VITE_*` variable. Integration-test safety and required checks are described in [AGENTS.md](AGENTS.md). Configuration settings are listed in [.env.example](.env.example).

## Data and upgrades

Migrations run automatically before the server listens and are recorded in `schema_migrations`. The first rollout of SKU schema versioning was a historical upgrade checkpoint, not a pending deployment step. Existing installations should use the current [migration guide](docs/DATABASE_MIGRATIONS.md) and take a verified backup before a deployment that changes data. The default catalog in `server/data_config.js` seeds an empty database only and does not describe a deployed catalog.

For backup, restore, the read-only data audit, and optional legacy SQLite configuration import, use the commands and safeguards in [operations](docs/OPERATIONS.md). SKU version and decoding rules are in [SKU and catalog](docs/SKU_CATALOG.md).
