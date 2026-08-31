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
running_services="$(docker compose ps --status running --services)"
server_was_running=0
client_was_running=0
if printf '%s\n' "$running_services" | grep -qx server; then server_was_running=1; fi
if printf '%s\n' "$running_services" | grep -qx client; then client_was_running=1; fi

restart_previously_running_services() {
  if [ "$server_was_running" -eq 1 ]; then docker compose start server; fi
  if [ "$client_was_running" -eq 1 ]; then docker compose start client; fi
}

docker compose stop client server
trap 'restart_previously_running_services >/dev/null 2>&1 || true' EXIT
docker compose exec -T postgres pg_restore \
  --username=amber --dbname=amber --clean --if-exists --no-owner --no-acl \
  --single-transaction --exit-on-error \
  < "$backup_file"
docker compose exec -T postgres psql --username=amber --dbname=amber \
  --command="SELECT COUNT(*) AS products FROM products; SELECT COUNT(*) AS migrations FROM schema_migrations;"
restart_previously_running_services
trap - EXIT
printf '%s\n' "Restore completed and basic table verification passed."
