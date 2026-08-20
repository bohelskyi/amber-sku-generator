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

### Migrate config from old SQLite (optional)

If you need to keep existing categories/questions/options and price settings from old `server/amber.db`, run:

```bash
cd amber-app/server
npm install
npm run migrate:config -- --sqlite=./amber.db --pg=postgresql://amber:amber_password@localhost:5432/amber
```

Notes:
- This migrates only config/pricing tables.
- Products history (`products`) is not copied.
- The script replaces current config tables in PostgreSQL.
