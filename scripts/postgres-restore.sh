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
docker compose exec -T postgres sh -c '
  case "$POSTGRES_DB" in
    ""|postgres|template0|template1)
      printf "%s\n" "Refusing to replace reserved database: ${POSTGRES_DB:-<empty>}" >&2
      exit 2
      ;;
  esac
'
running_services="$(docker compose ps --status running --services)"
server_was_running=0
client_was_running=0
if printf '%s\n' "$running_services" | grep -qx server; then server_was_running=1; fi
if printf '%s\n' "$running_services" | grep -qx client; then client_was_running=1; fi

restart_previously_running_services() {
  if [ "$server_was_running" -eq 1 ]; then docker compose start server; fi
  if [ "$client_was_running" -eq 1 ]; then docker compose start client; fi
}

report_destructive_restore_failure() {
  restore_status=$?
  printf '%s\n' \
    "Restore failed after the destructive phase began; server and client were intentionally left stopped." >&2
  exit "$restore_status"
}

docker compose stop client server
trap 'report_destructive_restore_failure' EXIT
docker compose exec -T postgres sh -c \
  'exec dropdb --username="$POSTGRES_USER" --maintenance-db=postgres --force --if-exists -- "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'exec createdb --username="$POSTGRES_USER" --maintenance-db=postgres --owner="$POSTGRES_USER" --template=template0 -- "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-acl --single-transaction --exit-on-error' \
  < "$backup_file"
docker compose exec -T postgres sh -c \
  'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="SELECT COUNT(*) AS products FROM products; SELECT COUNT(*) AS migrations FROM schema_migrations;"'
trap - EXIT
restart_previously_running_services
printf '%s\n' "Restore completed and basic table verification passed."
