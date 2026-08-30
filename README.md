# amber-sku-generator

## Deploy with Docker (Ubuntu 24.04)

1. Install Docker Engine + Compose plugin (official docs):
   - https://docs.docker.com/engine/install/ubuntu/

2. Clone project and move into app folder:
```bash
cd amber-app
```

3. Build and run:
```bash
docker compose up -d --build
```

4. Open app:
```text
http://YOUR_SERVER_IP
```

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
- DB credentials in `docker-compose.yml`:
  - DB: `amber`
  - User: `amber`
  - Password: `amber_password`
- Backup:
```bash
docker compose exec -T postgres pg_dump -U amber amber > amber-backup.sql
```

- Restore:
```bash
cat amber-backup.sql | docker compose exec -T postgres psql -U amber -d amber
```

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
npm run migrate:config -- --sqlite=./amber.db --pg=postgresql://amber:amber_password@localhost:5432/amber
```

Notes:
- This migrates only config/pricing tables.
- Products history (`products`) is not copied.
- By default the script only imports into a database without configuration.
- To explicitly replace configuration, add `--replace`. Replacement is refused when the target contains products.
- The import creates V1 SKU schema snapshots and preserves/imports `sku_code` values.
