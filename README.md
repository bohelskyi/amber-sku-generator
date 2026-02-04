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
