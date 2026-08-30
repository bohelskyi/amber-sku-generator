#!/usr/bin/env sh
set -eu

backup_file="${1:-}"
confirmation="${2:-}"
if [ -z "$backup_file" ] || [ "$confirmation" != "--confirm" ]; then
  printf '%s\n' "Usage: $0 PATH_TO_DUMP --confirm" >&2
  printf '%s\n' "Restore replaces objects in the configured amber database." >&2
  exit 2
fi
if [ ! -s "$backup_file" ]; then
  printf '%s\n' "Backup does not exist or is empty: $backup_file" >&2
  exit 2
fi

docker compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
docker compose exec -T postgres pg_restore \
  --username=amber --dbname=amber --clean --if-exists --no-owner --no-acl --exit-on-error \
  < "$backup_file"
docker compose exec -T postgres psql --username=amber --dbname=amber \
  --command="SELECT COUNT(*) AS products FROM products; SELECT COUNT(*) AS migrations FROM schema_migrations;"
printf '%s\n' "Restore completed and basic table verification passed."
